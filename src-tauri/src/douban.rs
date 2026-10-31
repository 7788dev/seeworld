use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
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
const LIST_TTL: Duration = Duration::from_secs(600);
const DETAIL_TTL: Duration = Duration::from_secs(86_400);
static COOKIE_WARMED: AtomicBool = AtomicBool::new(false);

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(UA)
            .timeout(TIMEOUT)
            .connect_timeout(Duration::from_secs(5))
            .cookie_store(true)
            .build()
            .expect("failed to build http client")
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
        if map.len() > 512 {
            map.retain(|_, entry| entry.expires > Instant::now());
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
    let started = std::time::Instant::now();
    let mut last_error = String::from("all douban hosts failed");
    for host in hosts {
        let is_official = host.ends_with("douban.com") && !host.contains("cmliussss");
        if is_official && !COOKIE_WARMED.swap(true, Ordering::Relaxed) {
            eprintln!("[douban] warming cookies for official host…");
            let _ = client()
                .get("https://movie.douban.com/")
                .header(header::REFERER, "https://www.douban.com/")
                .timeout(TIMEOUT)
                .send()
                .await;
        }
        let url = format!("{host}{path_query}");
        eprintln!("[douban] GET {url}");
        let attempt = client()
            .get(&url)
            .header(header::REFERER, referer)
            .header(header::ACCEPT, "application/json, text/plain, */*")
            .timeout(TIMEOUT)
            .send()
            .await;
        match attempt {
            Ok(response) if response.status().is_success() => match response.text().await {
                Ok(body) => {
                    let trimmed = body.trim();
                    if trimmed.is_empty() {
                        eprintln!(
                            "[douban] {host} returned empty body ({}ms)",
                            started.elapsed().as_millis()
                        );
                        last_error = format!("{host}: empty body");
                        continue;
                    }
                    eprintln!(
                        "[douban] OK {host} {} bytes ({}ms)",
                        body.len(),
                        started.elapsed().as_millis()
                    );
                    cache_put(key.to_string(), body.clone(), LIST_TTL);
                    return Ok(body);
                }
                Err(error) => {
                    eprintln!("[douban] {host} body read failed: {error}");
                    last_error = format!("{host}: {error}");
                }
            },
            Ok(response) => {
                eprintln!("[douban] {host} HTTP {}", response.status().as_u16());
                last_error = format!("{host}: HTTP {}", response.status().as_u16());
            }
            Err(error) => {
                eprintln!("[douban] {host} request failed: {error}");
                last_error = format!("{host}: {error}");
            }
        }
    }
    eprintln!(
        "[douban] all hosts failed after {}ms: {last_error}",
        started.elapsed().as_millis()
    );
    Err(last_error)
}

#[derive(Deserialize)]
struct RawSubject {
    id: String,
    title: String,
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
    let mut last_error = String::from("all douban hosts failed");
    for host in REXXAR_HOSTS {
        for endpoint in [primary, secondary] {
            let url = format!("{host}/rexxar/api/v2/{endpoint}/{subject_id}");
            let attempt = client()
                .get(&url)
                .header(header::REFERER, M_REFERER)
                .header(header::ACCEPT, "application/json, text/plain, */*")
                .timeout(TIMEOUT)
                .send()
                .await;
            match attempt {
                Ok(response) if response.status().is_success() => match response.text().await {
                    Ok(body) => {
                        if body.contains("traversal_error") || body.contains("invalid_request") {
                            last_error = format!("{host}: subject is not a {endpoint}");
                            continue;
                        }
                        match parse_detail(&body) {
                            Ok(detail) => {
                                cache_put(cache_key, body, DETAIL_TTL);
                                return Ok(detail);
                            }
                            Err(error) => last_error = format!("{host}: {error}"),
                        }
                    }
                    Err(error) => last_error = format!("{host}: {error}"),
                },
                Ok(response) => last_error = format!("{host}: HTTP {}", response.status().as_u16()),
                Err(error) => last_error = format!("{host}: {error}"),
            }
        }
    }
    Err(last_error)
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
    let attempt = client()
        .get(parsed)
        .header(header::REFERER, IMG_REFERER)
        .timeout(Duration::from_secs(15))
        .send()
        .await;
    match attempt {
        Ok(response) => {
            let status = response.status().as_u16();
            if status != 200 {
                return image_error(502, "douban image upstream error");
            }
            let content_type = response
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .map(|value| value.to_string());
            match response.bytes().await {
                Ok(bytes) => {
                    let mut builder = Response::builder()
                        .status(200)
                        .header(header::CACHE_CONTROL, "public, max-age=2592000");
                    if let Some(content_type) = content_type {
                        builder = builder.header(header::CONTENT_TYPE, content_type);
                    }
                    builder
                        .body(bytes.to_vec())
                        .expect("failed to build image response")
                }
                Err(_) => image_error(502, "failed to read image body"),
            }
        }
        Err(_) => image_error(502, "failed to fetch douban image"),
    }
}
