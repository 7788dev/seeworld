use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use futures::future::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::http::{header, Request, Response};

const LIST_HOSTS: [&str; 2] = [
    "https://movie.douban.com",
    "https://movie.douban.cmliussss.net",
];
const REXXAR_HOSTS: [&str; 2] = ["https://m.douban.com", "https://m.douban.cmliussss.net"];
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";
const REFERER: &str = "https://movie.douban.com/";
const M_REFERER: &str = "https://m.douban.com/";
const IMG_REFERER: &str = "https://movie.douban.com/explore";
const TIMEOUT: Duration = Duration::from_secs(10);
/// 一次豆瓣命令的总预算：官方与反代对冲，谁先返回可用 JSON 用谁。
/// 不能让两个 10s 超时串行叠加，冷启动等 20-30s 是不可接受的。
const FETCH_BUDGET: Duration = Duration::from_secs(8);
const DETAIL_BUDGET: Duration = Duration::from_secs(8);
const WARM_TIMEOUT: Duration = Duration::from_secs(3);
const LIST_TTL: Duration = Duration::from_secs(600);
const DETAIL_TTL: Duration = Duration::from_secs(86_400);
static COOKIE_WARMED: AtomicBool = AtomicBool::new(false);
const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;

fn image_semaphore() -> &'static tokio::sync::Semaphore {
    static SEM: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
    SEM.get_or_init(|| tokio::sync::Semaphore::new(6))
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .use_native_tls()
            .user_agent(UA)
            .timeout(TIMEOUT)
            .connect_timeout(Duration::from_secs(5))
            .cookie_store(true)
            .build()
            .expect("failed to build http client")
    })
}

fn image_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(UA)
            .timeout(Duration::from_secs(15))
            .connect_timeout(Duration::from_secs(5))
            .dns_resolver(std::sync::Arc::new(crate::play_proxy::PublicDnsResolver))
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= 3 {
                    return attempt.error("too many redirects");
                }
                let host = attempt.url().host_str().unwrap_or_default();
                if host != "doubanio.com" && !host.ends_with(".doubanio.com") {
                    return attempt.error("blocked redirect host");
                }
                attempt.follow()
            }))
            .build()
            .expect("failed to build image http client")
    })
}

struct CacheEntry {
    expires: Instant,
    body: String,
}

fn cache() -> &'static Mutex<HashMap<String, CacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_get(key: &str) -> Option<String> {
    let mut map = cache().lock().ok()?;
    match map.get(key) {
        Some(entry) if entry.expires > Instant::now() => Some(entry.body.clone()),
        Some(_) => {
            map.remove(key);
            None
        }
        None => None,
    }
}

fn cache_put(key: String, body: String, ttl: Duration) {
    if let Ok(mut map) = cache().lock() {
        if map.len() >= 512 {
            let now = Instant::now();
            map.retain(|_, entry| entry.expires > now);
            while map.len() >= 512 {
                let Some(oldest) = map
                    .iter()
                    .min_by_key(|(_, entry)| entry.expires)
                    .map(|(key, _)| key.clone())
                else {
                    break;
                };
                map.remove(&oldest);
            }
        }
        map.insert(
            key,
            CacheEntry {
                expires: Instant::now() + ttl,
                body,
            },
        );
    }
}

/// 只缓存真正的 JSON（对象/数组）。豆瓣反爬可能返回 200 HTML，
/// 旧实现会在解析前写缓存，导致后续 10 分钟持续 parse error。
fn looks_like_json(body: &str) -> bool {
    matches!(
        serde_json::from_str::<Value>(body.trim()),
        Ok(Value::Object(_)) | Ok(Value::Array(_))
    )
}

fn warm_cookies_once() {
    if COOKIE_WARMED.swap(true, Ordering::Relaxed) {
        return;
    }
    eprintln!("[douban] warming cookies in background…");
    // 不等待：暖 Cookie 只是提高官方域名成功率，不能阻塞首屏。
    tauri::async_runtime::spawn(async move {
        let _ = client()
            .get("https://movie.douban.com/")
            .header(header::REFERER, "https://www.douban.com/")
            .timeout(WARM_TIMEOUT)
            .send()
            .await;
    });
}

async fn fetch_from_host(host: String, referer: String, path_query: String) -> Result<String, String> {
    let started = Instant::now();
    let url = format!("{host}{path_query}");
    eprintln!("[douban] GET {url}");
    let response = client()
        .get(&url)
        .header(header::REFERER, referer)
        .header(header::ACCEPT, "application/json, text/plain, */*")
        .timeout(TIMEOUT)
        .send()
        .await
        .map_err(|error| format!("{host}: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("{host}: HTTP {}", response.status().as_u16()));
    }
    let body = response
        .text()
        .await
        .map_err(|error| format!("{host}: body read failed: {error}"))?;
    if body.trim().is_empty() {
        return Err(format!("{host}: empty body"));
    }
    if !looks_like_json(&body) {
        return Err(format!("{host}: 返回内容不是 JSON（可能被反爬拦截）"));
    }
    eprintln!(
        "[douban] OK {host} {} bytes ({}ms)",
        body.len(),
        started.elapsed().as_millis()
    );
    Ok(body)
}

async fn fetch_json(
    key: &str,
    hosts: &[&str],
    referer: &str,
    path_query: &str,
) -> Result<String, String> {
    if let Some(body) = cache_get(key) {
        eprintln!("[douban] cache hit: {key}");
        return Ok(body);
    }
    if hosts
        .iter()
        .any(|host| host.ends_with("douban.com") && !host.contains("cmliussss"))
    {
        warm_cookies_once();
    }
    let started = Instant::now();
    let futures: Vec<BoxFuture<'static, Result<String, String>>> = hosts
        .iter()
        .map(|host| {
            Box::pin(fetch_from_host(
                host.to_string(),
                referer.to_string(),
                path_query.to_string(),
            )) as BoxFuture<'static, Result<String, String>>
        })
        .collect();
    match tokio::time::timeout(FETCH_BUDGET, futures::future::select_ok(futures)).await {
        Ok(Ok((body, _remaining))) => {
            cache_put(key.to_string(), body.clone(), LIST_TTL);
            eprintln!(
                "[douban] fetch {key} ok ({} bytes, {}ms)",
                body.len(),
                started.elapsed().as_millis()
            );
            Ok(body)
        }
        Ok(Err(error)) => {
            eprintln!(
                "[douban] fetch {key} failed after {}ms: {error}",
                started.elapsed().as_millis()
            );
            Err(error)
        }
        Err(_) => {
            eprintln!(
                "[douban] fetch {key} timed out after {}ms",
                started.elapsed().as_millis()
            );
            Err("豆瓣请求超时（8s）".to_string())
        }
    }
}

#[derive(Deserialize)]
struct RawSubject {
    id: String,
    title: String,
    #[serde(default)]
    cover: String,
    #[serde(default)]
    rate: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    is_new: bool,
    #[serde(default)]
    episodes_info: String,
}

#[derive(Deserialize)]
struct RawListResponse {
    #[serde(default)]
    subjects: Vec<RawSubject>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DbSubject {
    pub id: String,
    pub title: String,
    pub cover: String,
    pub rate: String,
    pub url: String,
    pub is_new: bool,
    pub episodes_info: String,
}

#[tauri::command]
pub async fn douban_list(
    kind: String,
    tag: String,
    limit: u32,
    start: u32,
    sort: Option<String>,
) -> Result<Vec<DbSubject>, String> {
    let sort = match sort.as_deref() {
        Some("time") => "time",
        Some("rank") => "rank",
        _ => "recommend",
    };
    eprintln!("[douban] douban_list invoked: kind={kind} tag={tag} sort={sort} limit={limit} start={start}");
    let kind = if kind == "tv" { "tv" } else { "movie" };
    let limit = limit.clamp(1, 100);
    let path = format!(
        "/j/search_subjects?type={kind}&tag={}&sort={sort}&page_limit={limit}&page_start={start}",
        urlencoding::encode(&tag)
    );
    let key = format!(
        "list:{kind}:{}:{limit}:{start}:{sort}",
        urlencoding::encode(&tag)
    );
    let body = fetch_json(&key, &LIST_HOSTS, REFERER, &path).await?;
    let parsed: RawListResponse =
        serde_json::from_str(&body).map_err(|e| format!("parse error: {e}"))?;
    Ok(parsed
        .subjects
        .into_iter()
        .map(|s| DbSubject {
            id: s.id,
            title: s.title,
            cover: s.cover,
            rate: s.rate,
            url: s.url,
            is_new: s.is_new,
            episodes_info: s.episodes_info,
        })
        .collect())
}

#[derive(Deserialize)]
struct RawSuggest {
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    sub_title: String,
    #[serde(default)]
    img: String,
    #[serde(default)]
    year: String,
    #[serde(default)]
    episode: String,
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default)]
    url: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DbSuggest {
    pub id: String,
    pub title: String,
    pub sub_title: String,
    pub img: String,
    pub year: String,
    pub episode: String,
    pub kind: String,
    pub url: String,
}

#[tauri::command]
pub async fn douban_suggest(q: String) -> Result<Vec<DbSuggest>, String> {
    let query = q.trim().to_string();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let path = format!("/j/subject_suggest?q={}", urlencoding::encode(&query));
    let key = format!("suggest:{}", urlencoding::encode(&query));
    let body = fetch_json(&key, &LIST_HOSTS, REFERER, &path).await?;
    let parsed: Vec<RawSuggest> =
        serde_json::from_str(&body).map_err(|e| format!("parse error: {e}"))?;
    Ok(parsed
        .into_iter()
        .map(|s| DbSuggest {
            id: s.id,
            title: s.title,
            sub_title: s.sub_title,
            img: s.img,
            year: s.year,
            episode: s.episode,
            kind: s.kind,
            url: s.url,
        })
        .collect())
}

fn flexible_string<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value: Option<serde_json::Value> = Option::deserialize(deserializer)?;
    Ok(match value {
        Some(serde_json::Value::String(s)) => s,
        Some(serde_json::Value::Number(n)) => n.to_string(),
        _ => String::new(),
    })
}

fn flexible_count<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value: Option<serde_json::Value> = Option::deserialize(deserializer)?;
    Ok(match value {
        Some(serde_json::Value::Number(n)) => n.as_u64().unwrap_or(0),
        Some(serde_json::Value::String(s)) => s.parse().unwrap_or(0),
        _ => 0,
    })
}

#[derive(Deserialize, Default)]
struct RawPerson {
    #[serde(default)]
    name: String,
}

#[derive(Deserialize, Default)]
struct RawRating {
    #[serde(default)]
    value: f64,
    #[serde(default)]
    count: u64,
}

#[derive(Deserialize, Default)]
struct RawPic {
    #[serde(default)]
    large: String,
    #[serde(default)]
    normal: String,
}

#[derive(Deserialize, Default)]
struct RawDetail {
    #[serde(default)]
    id: String,
    #[serde(default)]
    title: String,
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default, deserialize_with = "flexible_string")]
    original_title: String,
    #[serde(default)]
    rating: RawRating,
    #[serde(default, deserialize_with = "flexible_string")]
    year: String,
    #[serde(default)]
    genres: Vec<String>,
    #[serde(default)]
    actors: Vec<RawPerson>,
    #[serde(default)]
    directors: Vec<RawPerson>,
    #[serde(default)]
    intro: String,
    #[serde(default)]
    pic: RawPic,
    #[serde(default)]
    durations: Vec<String>,
    #[serde(default, deserialize_with = "flexible_count")]
    episodes_count: u64,
    #[serde(default)]
    pubdate: Vec<String>,
    #[serde(default)]
    countries: Vec<String>,
    #[serde(default)]
    aka: Vec<String>,
    #[serde(default)]
    card_subtitle: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DbDetail {
    pub id: String,
    pub title: String,
    pub original_title: String,
    pub kind: String,
    pub year: String,
    pub rating: f64,
    pub votes: u64,
    pub genres: Vec<String>,
    pub actors: Vec<String>,
    pub directors: Vec<String>,
    pub intro: String,
    pub pic_large: String,
    pub pic_normal: String,
    pub durations: Vec<String>,
    pub episodes_count: u64,
    pub pubdate: Vec<String>,
    pub countries: Vec<String>,
    pub aka: Vec<String>,
    pub card_subtitle: String,
}

#[derive(Deserialize, Default)]
struct RawRecommendItem {
    #[serde(default)]
    id: String,
    #[serde(default)]
    title: String,
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default)]
    year: String,
    #[serde(default)]
    card: String,
    #[serde(default)]
    card_subtitle: String,
    #[serde(default)]
    episodes_info: String,
    #[serde(default)]
    pic: RawPic,
    #[serde(default)]
    rating: RawRating,
    #[serde(default)]
    photos: Vec<String>,
}

#[derive(Deserialize, Default)]
struct RawRecommendResponse {
    #[serde(default)]
    items: Vec<RawRecommendItem>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DbRecommend {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub year: String,
    pub cover: String,
    pub hero: String,
    pub rating: f64,
    pub votes: u64,
    pub genres: Vec<String>,
    pub region: String,
    pub creator: String,
    pub cast: Vec<String>,
    pub episodes_info: String,
}

fn parse_detail(body: &str) -> Result<DbDetail, String> {
    let raw: RawDetail = serde_json::from_str(body).map_err(|e| format!("parse error: {e}"))?;
    if raw.id.is_empty() || raw.title.is_empty() {
        return Err("invalid subject".into());
    }
    Ok(DbDetail {
        id: raw.id,
        title: raw.title,
        original_title: raw.original_title,
        kind: if raw.kind == "tv" {
            "tv".into()
        } else {
            "movie".into()
        },
        year: raw.year,
        rating: raw.rating.value,
        votes: raw.rating.count,
        genres: raw.genres,
        actors: raw
            .actors
            .into_iter()
            .map(|p| p.name)
            .filter(|n| !n.is_empty())
            .collect(),
        directors: raw
            .directors
            .into_iter()
            .map(|p| p.name)
            .filter(|n| !n.is_empty())
            .collect(),
        intro: raw.intro,
        pic_large: raw.pic.large,
        pic_normal: raw.pic.normal,
        durations: raw.durations,
        episodes_count: raw.episodes_count,
        pubdate: raw.pubdate,
        countries: raw.countries,
        aka: raw.aka,
        card_subtitle: raw.card_subtitle,
    })
}

async fn fetch_detail_from(
    host: String,
    endpoint: String,
    subject_id: String,
) -> Result<(String, DbDetail), String> {
    let url = format!("{host}/rexxar/api/v2/{endpoint}/{subject_id}");
    eprintln!("[douban] detail GET {url}");
    let response = client()
        .get(&url)
        .header(header::REFERER, M_REFERER)
        .header(header::ACCEPT, "application/json, text/plain, */*")
        .timeout(TIMEOUT)
        .send()
        .await
        .map_err(|error| format!("{host}/{endpoint}: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("{host}/{endpoint}: HTTP {}", response.status().as_u16()));
    }
    let body = response
        .text()
        .await
        .map_err(|error| format!("{host}/{endpoint}: body read failed: {error}"))?;
    if body.contains("traversal_error") || body.contains("invalid_request") {
        return Err(format!("{host}/{endpoint}: subject is not a {endpoint}"));
    }
    let detail = parse_detail(&body).map_err(|error| format!("{host}/{endpoint}: {error}"))?;
    Ok((body, detail))
}

#[tauri::command]
pub async fn douban_detail(id: String, kind: Option<String>) -> Result<DbDetail, String> {
    let subject_id = id.trim().trim_start_matches("db-").to_string();
    if subject_id.is_empty() || !subject_id.chars().all(|c| c.is_ascii_digit()) {
        return Err("invalid douban id".into());
    }
    let cache_key = format!("detail:{subject_id}");
    if let Some(body) = cache_get(&cache_key) {
        return parse_detail(&body);
    }
    let primary = if kind.as_deref() == Some("tv") {
        "tv"
    } else {
        "movie"
    };
    let secondary = if primary == "tv" { "movie" } else { "tv" };
    let started = Instant::now();
    let mut last_error = String::new();
    // 先并发尝试两个 host 的主 endpoint（最常见情况 2 个请求即可），
    // 只有主 endpoint 都失败时才回退到另一个 endpoint，避免每次详情 4 路请求。
    for endpoint in [primary, secondary] {
        let remaining = DETAIL_BUDGET.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            break;
        }
        let mut futures: Vec<BoxFuture<'static, Result<(String, DbDetail), String>>> = Vec::new();
        for host in REXXAR_HOSTS {
            futures.push(Box::pin(fetch_detail_from(
                host.to_string(),
                endpoint.to_string(),
                subject_id.clone(),
            )));
        }
        match tokio::time::timeout(remaining, futures::future::select_ok(futures)).await {
            Ok(Ok((body_and_detail, _remaining))) => {
                let (body, detail) = body_and_detail;
                cache_put(cache_key, body, DETAIL_TTL);
                return Ok(detail);
            }
            Ok(Err(error)) => last_error = error,
            Err(_) => return Err("豆瓣详情请求超时（8s）".to_string()),
        }
    }
    if last_error.is_empty() {
        Err("豆瓣详情请求超时（8s）".to_string())
    } else {
        Err(last_error)
    }
}

fn split_card_subtitle(raw: &str) -> (String, Vec<String>, String, Vec<String>) {
    let parts: Vec<&str> = raw.split('/').map(str::trim).collect();
    let region = parts.get(1).copied().unwrap_or("").to_string();
    let genres = parts
        .get(2)
        .map(|value| value.split_whitespace().map(str::to_string).collect())
        .unwrap_or_default();
    let creator = parts
        .get(3)
        .map(|value| value.split_whitespace().collect::<Vec<_>>().join(" / "))
        .unwrap_or_default();
    let cast = parts
        .get(4)
        .map(|value| value.split_whitespace().map(str::to_string).collect())
        .unwrap_or_default();
    (region, genres, creator, cast)
}

#[tauri::command]
pub async fn douban_recommend(
    form: String,
    tags: Vec<String>,
    sort: Option<String>,
    min_rating: Option<u8>,
    start: Option<u32>,
    count: Option<u32>,
) -> Result<Vec<DbRecommend>, String> {
    let form = if form == "tv" { "tv" } else { "movie" };
    let sort = match sort.as_deref() {
        Some("U") => "U",
        Some("R") => "R",
        Some("S") => "S",
        _ => "T",
    };
    let min_rating = min_rating.unwrap_or(0).min(10);
    let start = start.unwrap_or(0);
    let count = count.unwrap_or(48).clamp(1, 60);
    let tags: Vec<String> = tags
        .into_iter()
        .map(|tag| tag.trim().to_string())
        .filter(|tag| !tag.is_empty())
        .collect();
    let mut path = format!(
        "/rexxar/api/v2/{form}/recommend?start={start}&count={count}&sort={sort}&score_range={min_rating},10"
    );
    if !tags.is_empty() {
        path.push_str(&format!("&tags={}", urlencoding::encode(&tags.join(","))));
    }
    let key = format!(
        "recommend:{form}:{sort}:{min_rating}:{start}:{count}:{}",
        tags.join(",")
    );
    eprintln!("[douban] recommend GET {path}");
    let body = fetch_json(&key, &REXXAR_HOSTS, M_REFERER, &path).await?;
    let parsed: RawRecommendResponse =
        serde_json::from_str(&body).map_err(|e| format!("parse error: {e}"))?;
    Ok(parsed
        .items
        .into_iter()
        .filter(|item| {
            item.card == "subject"
                && !item.id.is_empty()
                && !item.title.is_empty()
                && !item.pic.normal.is_empty()
        })
        .map(|item| {
            let (region, genres, creator, cast) = split_card_subtitle(&item.card_subtitle);
            let hero = item
                .photos
                .first()
                .cloned()
                .unwrap_or_else(|| item.pic.large.clone());
            DbRecommend {
                id: item.id,
                title: item.title,
                kind: if item.kind.is_empty() {
                    form.to_string()
                } else {
                    item.kind
                },
                year: item.year,
                cover: item.pic.normal,
                hero,
                rating: item.rating.value,
                votes: item.rating.count,
                genres,
                region,
                creator,
                cast,
                episodes_info: item.episodes_info,
            }
        })
        .collect())
}

fn image_error(status: u16, message: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(message.as_bytes().to_vec())
        .expect("failed to build error response")
}

fn resolve_image_url(uri: &str) -> Option<String> {
    let rest = if let Some(rest) = uri.strip_prefix("dbimg://") {
        rest
    } else if let Some(rest) = uri
        .strip_prefix("http://dbimg.localhost/")
        .or_else(|| uri.strip_prefix("https://dbimg.localhost/"))
    {
        rest
    } else {
        return None;
    };
    // Wry maps `http://dbimg.localhost/<encoded>` to `dbimg://localhost/<encoded>` on Windows.
    let rest = rest.strip_prefix("localhost/").unwrap_or(rest);
    let decoded = urlencoding::decode(rest)
        .map(|value| value.into_owned())
        .unwrap_or_else(|_| rest.to_string());
    if decoded.starts_with("http://") || decoded.starts_with("https://") {
        Some(decoded)
    } else if decoded.is_empty() {
        None
    } else {
        Some(format!("https://{decoded}"))
    }
}

pub async fn fetch_image(request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let uri = request.uri().to_string();
    let Some(https_url) = resolve_image_url(&uri) else {
        return image_error(400, "invalid dbimg url");
    };
    eprintln!("[dbimg] fetching {https_url}");
    let parsed = match reqwest::Url::parse(&https_url) {
        Ok(url) => url,
        Err(_) => return image_error(400, "invalid dbimg url"),
    };
    let host_allowed = parsed
        .host_str()
        .map(|host| host == "doubanio.com" || host.ends_with(".doubanio.com"))
        .unwrap_or(false);
    if !host_allowed {
        return image_error(400, "only doubanio.com images are allowed");
    }
    let _permit = match image_semaphore().acquire().await {
        Ok(permit) => permit,
        Err(_) => return image_error(503, "image proxy busy"),
    };
    let attempt = image_client()
        .get(parsed)
        .header(header::REFERER, IMG_REFERER)
        .timeout(Duration::from_secs(15))
        .send()
        .await;
    match attempt {
        Ok(mut response) => {
            let status = response.status().as_u16();
            if status != 200 {
                return image_error(502, "douban image upstream error");
            }
            let content_type = response
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .map(|value| value.to_string());
            let mut bytes = Vec::new();
            loop {
                match response.chunk().await {
                    Ok(Some(chunk)) => {
                        if bytes.len().saturating_add(chunk.len()) > MAX_IMAGE_BYTES {
                            return image_error(502, "douban image too large");
                        }
                        bytes.extend_from_slice(&chunk);
                    }
                    Ok(None) => break,
                    Err(_) => return image_error(502, "failed to read image body"),
                }
            }
            let mut builder = Response::builder()
                .status(200)
                .header(header::CACHE_CONTROL, "public, max-age=2592000")
                .header(header::CONTENT_LENGTH, bytes.len().to_string());
            if let Some(content_type) = content_type {
                builder = builder.header(header::CONTENT_TYPE, content_type);
            }
            builder
                .body(bytes)
                .expect("failed to build image response")
        }
        Err(_) => image_error(502, "failed to fetch douban image"),
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_accepts_json_bodies_for_cache() {
        assert!(looks_like_json(r#"{"subjects":[]}"#));
        assert!(looks_like_json("  [1,2,3]  "));
        assert!(!looks_like_json("<html>blocked</html>"));
        assert!(!looks_like_json(""));
        assert!(!looks_like_json("null"));
    }

    #[test]
    fn splits_recommend_card_subtitle() {
        let (region, genres, creator, cast) =
            split_card_subtitle("电影 / 中国大陆 / 科幻 冒险 / 郭帆 / 吴京 屈楚萧");
        assert_eq!(region, "中国大陆");
        assert_eq!(genres, vec!["科幻", "冒险"]);
        assert_eq!(creator, "郭帆");
        assert_eq!(cast, vec!["吴京", "屈楚萧"]);
    }

    #[test]
    fn resolves_dbimg_url_forms() {
        let expected = Some("https://img1.doubanio.com/a.jpg".to_string());
        assert_eq!(
            resolve_image_url("dbimg://localhost/https%3A%2F%2Fimg1.doubanio.com%2Fa.jpg"),
            expected
        );
        assert_eq!(
            resolve_image_url("http://dbimg.localhost/https%3A%2F%2Fimg1.doubanio.com%2Fa.jpg"),
            expected
        );
        assert_eq!(
            resolve_image_url("dbimg://img1.doubanio.com/a.jpg"),
            expected
        );
        assert_eq!(resolve_image_url("https://img1.doubanio.com/a.jpg"), None);
    }

    #[test]
    fn parses_detail_fields() {
        let body = r#"{
          "id": "123",
          "title": "流浪地球",
          "type": "movie",
          "year": "2019",
          "rating": {"value": 7.9, "count": 1000},
          "genres": ["科幻"],
          "actors": [{"name": "吴京"}],
          "directors": [{"name": "郭帆"}],
          "intro": "简介",
          "pic": {"large": "https://x/l.jpg", "normal": "https://x/n.jpg"},
          "durations": ["125分钟"],
          "episodes_count": "0",
          "pubdate": ["2019-02-05"],
          "countries": ["中国大陆"],
          "aka": ["The Wandering Earth"],
          "card_subtitle": "电影 / 中国大陆 / 科幻 / 郭帆 / 吴京"
        }"#;
        let detail = parse_detail(body).unwrap();
        assert_eq!(detail.id, "123");
        assert_eq!(detail.title, "流浪地球");
        assert_eq!(detail.kind, "movie");
        assert_eq!(detail.year, "2019");
        assert_eq!(detail.rating, 7.9);
        assert_eq!(detail.actors, vec!["吴京"]);
        assert_eq!(detail.directors, vec!["郭帆"]);
        assert_eq!(detail.episodes_count, 0);
        assert_eq!(detail.countries, vec!["中国大陆"]);
    }

    #[test]
    fn rejects_detail_without_identity() {
        assert!(parse_detail(r#"{"id":"","title":""}"#).is_err());
    }
}
