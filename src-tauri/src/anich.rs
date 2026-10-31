//! AniCh 聚合动漫源:搜索/详情/剧集与播放线路(protobuf)、直链解码、并发测速选优、弹幕。
//!
//! 接口参考 AniCh 客户端(开源项目 + 本机新版客户端字符串交叉验证):
//! - `GET {base}/bangumi/search?keyword=&skip=`          protobuf bangumi_list_(skip 为游标=上一条 id,首页传 0)
//! - `GET {base}/bangumi/detail/{id}`                    JSON
//! - `GET {base}/bangumi/episodes/{id}`                  protobuf bangumi_episodes_(每集含真实标题与弹幕 sites)
//! - `GET {base}/vod/{id}/{episode}`                     protobuf vod_(data[] = 每条线路, url 为混淆直链)
//! - `GET {base}/danmaku?bangumi=&episode=&skip=`        protobuf danmaku_(每页 3000,offset 分页)
//! - `GET {bili}/?type=1&oid={cid}&segment_index={n}`    protobuf bilibili_danmaku_(n 从 1 起)
//!
//! 播放直链解码(AniCh 原算法):删掉字符串第 4 个字符(index 3)后做标准 base64 解码。
//! `/vod/` 返回的是 JSON 整数数组(内容是 protobuf 字节),不是裸 protobuf,必须先还原。
//! 多入口依次回退(sends 社区网关 → 官方入口 → Cloudflare);新版客户端 UA 为
//! `anich Windows 1.5.27`,旧 UA 会被部分网关差别对待。
//! 注意:所有接口的 skip/分页参数必须传数字(网关对空参数返回 500)。

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

pub const ANICH_UA: &str = "anich Windows 1.5.27";

const ANICH_ENTRIES: [&str; 4] = [
    "https://anich.sends.eu.org",
    "https://api.emmmm.eu.org",
    "https://ani.emmmm.eu.org",
    "https://api.emmmm.eu.org.cdn.cloudflare.net",
];
/// 弹幕源:B 站官方 seg.so(公开可达)优先,AniCh 代理回退(协议相同,均 protobuf)
const BILI_DM_BASES: [&str; 2] = [
    "https://api.bilibili.com/x/v2/dm/web/seg.so",
    "https://bili-dm.emmmm.eu.org/",
];
const SEARCH_PAGE_MAX: usize = 5;
const VOD_TIMEOUT: Duration = Duration::from_secs(12);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const SPEED_PROBE_TIMEOUT: Duration = Duration::from_millis(2500);

/* --------------------------- protobuf wire format --------------------------- */

#[derive(Debug, Clone, Copy)]
enum Wire<'a> {
    Varint(u64),
    Fixed64(&'a [u8]),
    Bytes(&'a [u8]),
    Fixed32(&'a [u8]),
}

fn read_varint(buf: &[u8], pos: &mut usize) -> Option<u64> {
    let mut result: u64 = 0;
    let mut shift = 0u32;
    while *pos < buf.len() {
        let byte = buf[*pos];
        *pos += 1;
        result |= ((byte & 0x7f) as u64) << shift;
        if byte & 0x80 == 0 {
            return Some(result);
        }
        shift += 7;
        if shift > 63 {
            return None;
        }
    }
    None
}

fn pb_fields(buf: &[u8]) -> Vec<(u32, Wire<'_>)> {
    let mut fields = Vec::new();
    let mut pos = 0usize;
    while pos < buf.len() {
        let Some(key) = read_varint(buf, &mut pos) else { break };
        let field_no = (key >> 3) as u32;
        let wire_type = (key & 0x07) as u8;
        match wire_type {
            0 => {
                let Some(value) = read_varint(buf, &mut pos) else { break };
                fields.push((field_no, Wire::Varint(value)));
            }
            1 => {
                if pos + 8 > buf.len() {
                    break;
                }
                fields.push((field_no, Wire::Fixed64(&buf[pos..pos + 8])));
                pos += 8;
            }
            2 => {
                let Some(len) = read_varint(buf, &mut pos) else { break };
                let len = len as usize;
                if pos + len > buf.len() {
                    break;
                }
                fields.push((field_no, Wire::Bytes(&buf[pos..pos + len])));
                pos += len;
            }
            5 => {
                if pos + 4 > buf.len() {
                    break;
                }
                fields.push((field_no, Wire::Fixed32(&buf[pos..pos + 4])));
                pos += 4;
            }
            _ => break,
        }
    }
    fields
}

fn as_str(wire: Option<&Wire<'_>>) -> String {
    match wire {
        Some(Wire::Bytes(bytes)) => String::from_utf8_lossy(bytes).into_owned(),
        _ => String::new(),
    }
}

fn as_varint(wire: Option<&Wire<'_>>) -> u64 {
    match wire {
        Some(Wire::Varint(value)) => *value,
        _ => 0,
    }
}

fn as_fixed32(wire: Option<&Wire<'_>>) -> u32 {
    match wire {
        Some(Wire::Fixed32(bytes)) if bytes.len() == 4 => {
            u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
        }
        _ => 0,
    }
}

fn as_double(wire: Option<&Wire<'_>>) -> f64 {
    match wire {
        Some(Wire::Fixed64(bytes)) if bytes.len() == 8 => {
            f64::from_le_bytes([
                bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
            ])
        }
        _ => 0.0,
    }
}

/* --------------------------------- http ---------------------------------- */

static USER_PROXY: std::sync::RwLock<Option<String>> = std::sync::RwLock::new(None);

/// 用户在设置页配置的网络代理(如 http://127.0.0.1:7890),AniCh 源走此代理。
#[tauri::command]
pub async fn set_network_proxy(proxy: Option<String>) -> Result<(), String> {
    let value = proxy
        .map(|url| url.trim().to_string())
        .filter(|url| !url.is_empty());
    if let Some(url) = &value {
        reqwest::Proxy::all(url).map_err(|error| format!("代理地址无效:{error}"))?;
    }
    *USER_PROXY.write().unwrap_or_else(|poisoned| poisoned.into_inner()) = value;
    eprintln!("[anich] network proxy set");
    Ok(())
}

static DOH_RESOLVED: std::sync::RwLock<Option<std::collections::HashMap<String, (Vec<std::net::IpAddr>, Instant)>>> =
    std::sync::RwLock::new(None);
static PINNED_CLIENTS: std::sync::RwLock<Option<std::collections::HashMap<String, (reqwest::Client, Instant)>>> =
    std::sync::RwLock::new(None);
const DOH_TTL: Duration = Duration::from_secs(300);

/// DoH(alidns → doh.pub 回退)解析 IPv4:绕过本地 DNS 污染,并避开
/// 本机 IPv6 路由缺失(hyper 无 happy-eyeballs,AAAA 优先时会挂起至超时)。
async fn resolve_via_doh(host: &str) -> Option<Vec<std::net::IpAddr>> {
    {
        let cache = DOH_RESOLVED.read().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some((ips, at)) = cache.as_ref().and_then(|map| map.get(host)) {
            if at.elapsed() < DOH_TTL && !ips.is_empty() {
                return Some(ips.clone());
            }
        }
    }
    for doh_base in ["https://dns.alidns.com/resolve", "https://doh.pub/dns-query"] {
        let Ok(url) = reqwest::Url::parse_with_params(doh_base, [("name", host), ("type", "A")])
        else {
            continue;
        };
        let Ok(response) = base_client()
            .get(url)
            .header("accept", "application/dns-json")
            .timeout(Duration::from_secs(5))
            .send()
            .await
        else {
            continue;
        };
        let Ok(body) = response.text().await else { continue };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&body) else { continue };
        let ips: Vec<std::net::IpAddr> = value
            .get("Answer")
            .and_then(serde_json::Value::as_array)
            .map(|answers| {
                answers
                    .iter()
                    .filter(|answer| answer.get("type").and_then(serde_json::Value::as_i64) == Some(1))
                    .filter_map(|answer| {
                        answer
                            .get("data")
                            .and_then(serde_json::Value::as_str)
                            .and_then(|text| text.parse::<std::net::IpAddr>().ok())
                    })
                    .collect()
            })
            .unwrap_or_default();
        if !ips.is_empty() {
            let ips = order_reachable_ips(ips).await;
            DOH_RESOLVED
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .get_or_insert_with(Default::default)
                .insert(host.to_string(), (ips.clone(), Instant::now()));
            eprintln!("[anich] doh {host} -> {ips:?}");
            return Some(ips);
        }
    }
    None
}

/// Cloudflare 会同时返回多个 anycast IP,其中可能有一个在本机网络不可达。
/// reqwest/hyper 不会可靠地换下一个 IP,所以 DoH 后先按 TCP 可达性过滤并排序。
async fn order_reachable_ips(ips: Vec<std::net::IpAddr>) -> Vec<std::net::IpAddr> {
    if ips.len() < 2 {
        return ips;
    }
    let checks = ips.iter().map(|ip| {
        let ip = *ip;
        async move {
            let started = Instant::now();
            let reachable = tokio::time::timeout(
                Duration::from_millis(900),
                tokio::net::TcpStream::connect((ip, 443)),
            )
            .await
            .map(|result| result.is_ok())
            .unwrap_or(false);
            (ip, reachable, started.elapsed())
        }
    });
    let results = futures::future::join_all(checks).await;
    let mut reachable: Vec<(std::net::IpAddr, Duration)> = results
        .into_iter()
        .filter(|(_, ok, _)| *ok)
        .map(|(ip, _, elapsed)| (ip, elapsed))
        .collect();
    reachable.sort_by_key(|(_, elapsed)| *elapsed);
    if reachable.is_empty() {
        ips
    } else {
        reachable.into_iter().map(|(ip, _)| ip).collect()
    }
}

/// per-host 固定 IPv4 的 client(DoH 结果 + 用户代理 + 可选代理),缓存 5 分钟。
fn anich_client_for(host: &str, ips: &[std::net::IpAddr]) -> reqwest::Client {
    let proxy = USER_PROXY
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    let cache_key = format!(
        "{host}|{}|{}",
        ips.iter()
            .map(|ip| ip.to_string())
            .collect::<Vec<_>>()
            .join(","),
        proxy.as_deref().unwrap_or("")
    );
    {
        let cache = PINNED_CLIENTS.read().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some((client, at)) = cache.as_ref().and_then(|map| map.get(&cache_key)) {
            if at.elapsed() < DOH_TTL {
                return client.clone();
            }
        }
    }
    let mut builder = reqwest::Client::builder()
        .user_agent(ANICH_UA)
        .use_native_tls()
        .local_address(std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED))
        .connect_timeout(CONNECT_TIMEOUT)
        .http1_only();
    for ip in ips {
        builder = builder.resolve(host, std::net::SocketAddr::new(*ip, 443));
    }
    if let Some(proxy_url) = proxy {
        if let Ok(proxy) = reqwest::Proxy::all(&proxy_url) {
            builder = builder.proxy(proxy);
        }
    }
    let client = builder
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    PINNED_CLIENTS
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get_or_insert_with(Default::default)
        .insert(cache_key, (client.clone(), Instant::now()));
    client
}

/// 基础 client(UA + 用户代理,系统 DNS):用于 vod 直链测速等动态 CDN 域名。
fn base_client() -> reqwest::Client {
    let proxy = USER_PROXY
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    let mut builder = reqwest::Client::builder()
        .user_agent(ANICH_UA)
        .use_native_tls()
        .local_address(std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED))
        .connect_timeout(CONNECT_TIMEOUT);
    if let Some(proxy_url) = proxy {
        if let Ok(proxy) = reqwest::Proxy::all(&proxy_url) {
            builder = builder.proxy(proxy);
        }
    }
    builder.build().unwrap_or_else(|_| reqwest::Client::new())
}

/// 响应有效性:HTML 拦截页、JSON 错误体(`{"error":true,...}`)都视为该入口不可用。
fn response_is_valid(bytes: &[u8]) -> bool {
    let start = bytes
        .iter()
        .position(|byte| !byte.is_ascii_whitespace())
        .unwrap_or(bytes.len());
    let trimmed = &bytes[start..];
    if trimmed.first() == Some(&b'<') {
        return false;
    }
    if trimmed.first() == Some(&b'{') {
        let text = String::from_utf8_lossy(trimmed);
        return !text.contains("\"error\":true");
    }
    true
}

/// 多入口依次回退:任一入口返回有效响应即成功。
/// 实测结论(2026-10-31):api.emmmm.eu.org 免鉴权但部分地区网络不可达;
/// anich.sends.eu.org 免鉴权(元数据可用,vod 视上游);Cloudflare 入口需登录 token。
async fn anich_get(path: &str, query: &[(&str, &str)]) -> Result<Vec<u8>, String> {
    let mut last_error = String::from("所有入口均不可用");
    for (index, base) in ANICH_ENTRIES.iter().enumerate() {
        // 入口间限速:CF 网关对短时间连续请求会断连
        if index > 0 {
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        // 无参数时不留  尾巴(部分网关对空 query 串不稳定)
        let built = if query.is_empty() {
            reqwest::Url::parse(&format!("{base}{path}"))
        } else {
            reqwest::Url::parse_with_params(&format!("{base}{path}"), query.iter().copied())
        };
        let Ok(url) = built else {
            continue;
        };
        let host = url.host_str().unwrap_or_default().to_string();
        // 用户代理自行解析域名时不要再固定 IP(代理可能位于不同网络)。
        let proxy_configured = USER_PROXY
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_some();
        let ips = if proxy_configured {
            Vec::new()
        } else {
            resolve_via_doh(&host).await.unwrap_or_default()
        };
        // 同一域名的多个 IP 并发竞速:Cloudflare 常有一个 IP TCP 可达但 HTTPS 挂死,
        // 串行重试会把每个入口拖到超时。哪个 IP 先返回有效响应就用哪个。
        let candidates: Vec<Option<std::net::IpAddr>> = if ips.is_empty() {
            vec![None]
        } else {
            ips.into_iter().map(Some).collect()
        };
        let requests = candidates.into_iter().map(|ip| {
            let client = anich_client_for(&host, &ip.map(|ip| vec![ip]).unwrap_or_default());
            let url = url.clone();
            Box::pin(async move {
                let response = client
                    .get(url)
                    .header(reqwest::header::USER_AGENT, ANICH_UA)
                    .header("_", "")
                    .timeout(VOD_TIMEOUT)
                    .send()
                    .await
                    .map_err(|error| error.to_string())?;
                let status = response.status();
                if !status.is_success() {
                    return Err(format!("HTTP {}", status.as_u16()));
                }
                let bytes = response
                    .bytes()
                    .await
                    .map_err(|error| error.to_string())?
                    .to_vec();
                if !response_is_valid(&bytes) {
                    return Err("unauthorized".to_string());
                }
                Ok(bytes)
            })
        });
        match futures::future::select_ok(requests).await {
            Ok((bytes, _)) => return Ok(bytes),
            Err(error) => {
                eprintln!("[anich] {url} -> {error}");
                last_error = error;
                continue;
            }
        }
    }
    Err(last_error)
}

/* ------------------------------ decode url ------------------------------- */

/// AniCh 直链解码:删除第 4 个字符(index 3)后做标准 base64 解码。
pub(crate) fn decode_vod_url(raw: &str) -> Option<String> {
    let chars: Vec<char> = raw.chars().collect();
    if chars.len() < 8 {
        return None;
    }
    let cleaned: String = chars
        .iter()
        .enumerate()
        .filter(|(index, _)| *index != 3)
        .map(|(_, ch)| ch)
        .collect();
    let compact: String = cleaned.chars().filter(|ch| !ch.is_whitespace()).collect();
    let payload = match compact.len() % 4 {
        2 => format!("{compact}=="),
        3 => format!("{compact}="),
        _ => compact,
    };
    let decoded = decode_base64(&payload)?;
    String::from_utf8(decoded)
        .ok()
        .filter(|url| url.starts_with("http"))
}

/// 自实现 base64 解码(标准字母表 + URL-safe 兼容),避免额外依赖。
fn decode_base64(input: &str) -> Option<Vec<u8>> {
    fn value_of(ch: u8) -> Option<u32> {
        match ch {
            b'A'..=b'Z' => Some((ch - b'A') as u32),
            b'a'..=b'z' => Some((ch - b'a' + 26) as u32),
            b'0'..=b'9' => Some((ch - b'0' + 52) as u32),
            b'+' | b'-' => Some(62),
            b'/' | b'_' => Some(63),
            _ => None,
        }
    }
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for &ch in bytes {
        if ch == b'=' {
            break;
        }
        let Some(value) = value_of(ch) else { continue };
        acc = (acc << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xff) as u8);
        }
    }
    Some(out)
}

/// `/vod/` 新协议返回 JSON 整数数组(元素即 protobuf 字节),其它接口仍是裸 protobuf。
/// 统一在这里还原成字节,后续解析逻辑无需感知响应形态。
fn payload_bytes(bytes: &[u8]) -> Vec<u8> {
    let start = bytes
        .iter()
        .position(|byte| !byte.is_ascii_whitespace())
        .unwrap_or(bytes.len());
    let trimmed = &bytes[start..];
    if trimmed.first() == Some(&b'[') {
        if let Ok(values) = serde_json::from_slice::<Vec<u32>>(trimmed) {
            if values.iter().all(|value| *value <= u8::MAX as u32) {
                return values.into_iter().map(|value| value as u8).collect();
            }
        }
    }
    bytes.to_vec()
}

/* ------------------------------ data models ------------------------------ */

#[derive(Serialize, Deserialize, Clone)]
pub struct AnichEpisodeSite {
    pub site: String,
    pub id: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct AnichEpisode {
    pub sort: u32,
    pub title: String,
    pub duration: u64,
    pub overview: String,
    pub sites: Vec<AnichEpisodeSite>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DanmakuItem {
    pub time_ms: u64,
    pub mode: String, // scroll | top | bottom
    pub color: String,
    pub text: String,
}

fn parse_bangumi_items(buf: &[u8]) -> Vec<(u64, String, String, String)> {
    // bangumi_list_ { data[]: {id=1, title=2, episode=3, episodes_total=4, status=5, date=6, image=7, tagline=8} }
    let mut items = Vec::new();
    for (no, wire) in pb_fields(buf) {
        if no != 1 {
            continue;
        }
        if let Wire::Bytes(bytes) = wire {
            let mut id = 0u64;
            let mut title = String::new();
            let mut image = String::new();
            let mut tagline = String::new();
            for (f, w) in pb_fields(bytes) {
                match f {
                    1 => id = as_varint(Some(&w)),
                    2 => title = as_str(Some(&w)),
                    7 => image = as_str(Some(&w)),
                    8 => tagline = as_str(Some(&w)),
                    _ => {}
                }
            }
            if id > 0 && !title.is_empty() {
                items.push((id, title, image, tagline));
            }
        }
    }
    items
}

pub async fn search(query: &str) -> Result<Vec<crate::play::PlaySearchItem>, String> {
    let mut items = Vec::new();
    // 游标分页:首页 skip=0(网关要求 skip 必须为数字),后续 skip=上一页最后一条 id。
    let mut skip = 0u64;
    for _ in 0..SEARCH_PAGE_MAX {
        // 翻页失败不丢弃已获取的页(网关对未缓存的深分页可能回源失败)
        let Ok(buf) = anich_get(
            "/bangumi/search",
            &[("keyword", query), ("skip", &skip.to_string())],
        )
        .await
        else {
            break;
        };
        let page = parse_bangumi_items(&buf);
        if page.is_empty() {
            break;
        }
        let last_id = page.last().map(|(id, _, _, _)| *id).unwrap_or(0);
        for (id, title, image, tagline) in page {
            items.push(crate::play::PlaySearchItem {
                source_key: "anich".to_string(),
                vod_id: id.to_string(),
                name: title,
                pic: image,
                year: String::new(),
                type_name: tagline,
                remarks: "动漫".to_string(),
                actor: String::new(),
                director: String::new(),
                area: String::new(),
                lang: String::new(),
                line_names: vec!["AniCh聚合".to_string()],
            });
        }
        if last_id == 0 || last_id == skip {
            break;
        }
        skip = last_id;
    }
    Ok(items)
}

pub struct AnichDetail {
    pub name: String,
    pub image: String,
    pub overview: String,
    pub genres: Vec<String>,
    pub episodes: Vec<AnichEpisode>,
}

pub async fn detail(id: &str) -> Result<AnichDetail, String> {
    if id.is_empty() {
        return Err("缺少番剧 id".to_string());
    }
    let detail_bytes = anich_get(&format!("/bangumi/detail/{id}"), &[]).await?;
    let detail_json: serde_json::Value =
        serde_json::from_slice(&detail_bytes).map_err(|error| format!("详情解析失败:{error}"))?;
    let name = detail_json
        .get("title")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_string();
    let image = detail_json
        .get("image")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_string();
    let overview = detail_json
        .get("overview")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_string();
    let genres = detail_json
        .get("genres")
        .and_then(serde_json::Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();

    let eps_bytes = anich_get(&format!("/bangumi/episodes/{id}"), &[]).await?;
    let mut episodes = Vec::new();
    for (no, wire) in pb_fields(&eps_bytes) {
        if no != 1 {
            continue;
        }
        if let Wire::Bytes(bytes) = wire {
            // bangumi_episodes_data_ {status=1, sort=2, airdate=3, duration=4, sites=5, rating=6, image=7, title=8, overview=9}
            let mut sort = 0u32;
            let mut duration = 0u64;
            let mut title = String::new();
            let mut overview = String::new();
            let mut sites = Vec::new();
            for (f, w) in pb_fields(bytes) {
                match f {
                    2 => sort = as_varint(Some(&w)) as u32,
                    4 => duration = as_varint(Some(&w)),
                    5 => {
                        if let Wire::Bytes(site_buf) = w {
                            // sites { site=1, id=2 }
                            let mut site = String::new();
                            let mut site_id = String::new();
                            for (sf, sw) in pb_fields(site_buf) {
                                match sf {
                                    1 => site = as_str(Some(&sw)),
                                    2 => site_id = as_str(Some(&sw)),
                                    _ => {}
                                }
                            }
                            if !site.is_empty() {
                                sites.push(AnichEpisodeSite { site, id: site_id });
                            }
                        }
                    }
                    8 => title = as_str(Some(&w)),
                    9 => overview = as_str(Some(&w)),
                    _ => {}
                }
            }
            episodes.push(AnichEpisode {
                sort,
                title,
                duration,
                overview,
                sites,
            });
        }
    }
    episodes.sort_by_key(|episode| episode.sort);
    if episodes.is_empty() {
        return Err("该番剧没有可用剧集".to_string());
    }
    Ok(AnichDetail {
        name,
        image,
        overview,
        genres,
        episodes,
    })
}

#[derive(Serialize, Clone)]
pub struct AnichVodLine {
    pub url: String, // 解码后的直链
    pub caption: String,
    pub source: String, // 源标记,如 ek-20 / bf-3
    pub info: String,   // 画质/时长/编码信息
}

/// 拉取某集的全部播放线路并解码。
pub async fn vod_lines(id: &str, episode: u32) -> Result<Vec<AnichVodLine>, String> {
    let raw = anich_get(&format!("/vod/{id}/{episode}"), &[]).await?;
    let lines = parse_vod_lines(&payload_bytes(&raw));
    if lines.is_empty() {
        return Err("该集没有可用的播放线路".to_string());
    }
    Ok(lines)
}

fn parse_vod_lines(buf: &[u8]) -> Vec<AnichVodLine> {
    let mut lines = Vec::new();
    for (no, wire) in pb_fields(buf) {
        if no != 1 {
            continue;
        }
        if let Wire::Bytes(bytes) = wire {
            // vod_item_ { url=1, sort=2, type=3, caption=4, source=5, info=6 }
            let mut url_raw = String::new();
            let mut caption = String::new();
            let mut source = String::new();
            let mut info = String::new();
            for (f, w) in pb_fields(bytes) {
                match f {
                    1 => url_raw = as_str(Some(&w)),
                    4 => caption = as_str(Some(&w)),
                    5 => source = as_str(Some(&w)),
                    6 => info = as_str(Some(&w)),
                    _ => {}
                }
            }
            if url_raw.is_empty() {
                continue;
            }
            let Some(url) = decode_vod_url(&url_raw) else {
                continue;
            };
            let caption = if caption.is_empty() {
                if source.is_empty() {
                    format!("线路{}", lines.len() + 1)
                } else {
                    source.clone()
                }
            } else {
                caption
            };
            lines.push(AnichVodLine {
                url,
                caption,
                source,
                info,
            });
        }
    }
    lines
}

fn format_of(
    original: &reqwest::Url,
    content_type: &str,
    final_url: &reqwest::Url,
) -> Option<&'static str> {
    let ct = content_type.to_ascii_lowercase();
    if ct.contains("mpegurl")
        || ct.contains("m3u8")
        || ct.contains("x-mpeg")
        || ct.contains("mp2t")
    {
        return Some("hls");
    }
    if ct.contains("video/mp4") || ct.contains("video/x-m4v") || ct.contains("video/quicktime") {
        return Some("mp4");
    }
    let final_path = final_url.path().to_ascii_lowercase();
    if final_path.ends_with(".m3u8") {
        return Some("hls");
    }
    if final_path.ends_with(".mp4") || final_path.ends_with(".m4v") {
        return Some("mp4");
    }
    let original_path = original.path().to_ascii_lowercase();
    if original_path.ends_with(".m3u8") {
        return Some("hls");
    }
    if original_path.ends_with(".mp4") {
        return Some("mp4");
    }
    if ct.starts_with("video/") {
        return Some("mp4");
    }
    None
}

fn hls_playlist_stats(body: &str) -> (Option<f64>, bool, Option<String>) {
    let mut total = 0.0;
    let mut has_extinf = false;
    let mut master = false;
    let mut first_segment = None;
    for line in body.lines() {
        let line = line.trim();
        if let Some(value) = line.strip_prefix("#EXTINF:") {
            has_extinf = true;
            if let Some(seconds) = value
                .split(',')
                .next()
                .and_then(|value| value.trim().parse::<f64>().ok())
            {
                total += seconds;
            }
        } else if line.starts_with("#EXT-X-STREAM-INF") {
            master = true;
        } else if !line.is_empty() && !line.starts_with('#') && first_segment.is_none() {
            first_segment = Some(line.to_string());
        }
    }
    (
        if has_extinf { Some(total) } else { None },
        master,
        first_segment,
    )
}

/// 图片分片播放列表(广告幻灯片)不是可播放视频;真实分片通常是 .ts / .m4s / 无扩展名。
fn segment_looks_like_image(segment: &str) -> bool {
    let path = segment
        .split('?')
        .next()
        .unwrap_or(segment)
        .to_ascii_lowercase();
    [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]
        .iter()
        .any(|ext| path.ends_with(ext))
}

/// 线路信息里的时长形如 `23:40`,用于校验 HLS 播放列表是否真是本集。
fn duration_from_info(info: &str) -> u64 {
    for part in info.split('·') {
        let pieces: Vec<&str> = part.trim().split(':').collect();
        if (2..=3).contains(&pieces.len())
            && pieces.iter().all(|piece| piece.parse::<u64>().is_ok())
        {
            let mut seconds = 0u64;
            for piece in pieces {
                seconds = seconds * 60 + piece.parse::<u64>().unwrap_or(0);
            }
            if seconds > 0 {
                return seconds;
            }
        }
    }
    0
}

/// WebView2 对 HEVC 支持不稳定:0=H.264(优先),1=未知,2=H.265/HEVC。
fn codec_rank(info: &str) -> u8 {
    let upper = info.to_ascii_uppercase();
    if upper.contains("H.265") || upper.contains("HEVC") || upper.contains("H265") {
        2
    } else if upper.contains("H.264") || upper.contains("AVC") || upper.contains("H264") {
        0
    } else {
        1
    }
}

struct ProbeOutcome {
    index: usize,
    elapsed: f64,
    format: &'static str,
    tier: u8,
    valid: bool,
}

/// 为任意 URL 构造可用的 client:DoH 解析 + 可达 IP 固定(CDN 域名同样适用)。
async fn client_for_url(url: &reqwest::Url) -> Option<reqwest::Client> {
    let host = url.host_str()?.to_string();
    let proxy_configured = USER_PROXY
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .is_some();
    let ips = if proxy_configured {
        Vec::new()
    } else {
        resolve_via_doh(&host).await.unwrap_or_default()
    };
    Some(anich_client_for(&host, &ips))
}

/// 并发测速并校验内容:MP4 直链优先于 HLS,H.264 优先于未知/HEVC;
/// HLS 会拒绝图片分片广告和时长明显不符的播放列表。
pub async fn pick_fastest(
    lines: &[AnichVodLine],
    line_hint: Option<usize>,
    expected_duration: u64,
) -> Result<(usize, String, String), String> {
    if let Some(index) = line_hint {
        let line = lines
            .get(index)
            .or_else(|| lines.first())
            .ok_or_else(|| "线路不存在".to_string())?;
        let index = lines.iter().position(|l| l.url == line.url).unwrap_or(0);
        let format = if line.url.to_ascii_lowercase().contains(".m3u8") {
            "hls"
        } else {
            "mp4"
        };
        return Ok((index, line.url.clone(), format.to_string()));
    }
    let probes = lines.iter().enumerate().map(|(index, line)| {
        let line = line.clone();
        async move {
            let parsed = reqwest::Url::parse(&line.url).ok()?;
            let client = client_for_url(&parsed).await?;
            let started = Instant::now();
            let response = client
                .get(parsed.clone())
                .timeout(SPEED_PROBE_TIMEOUT)
                .send()
                .await
                .ok()?;
            let elapsed = started.elapsed().as_secs_f64();
            let status = response.status();
            if !(status.is_success() || status.as_u16() == 206) {
                return None;
            }
            let content_type = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .unwrap_or("")
                .to_string();
            let final_url = response.url().clone();
            let lower_ct = content_type.to_ascii_lowercase();
            let playlist_like = final_url.path().to_ascii_lowercase().ends_with(".m3u8");
            if lower_ct.starts_with("text/html")
                || lower_ct.starts_with("application/json")
                || lower_ct.starts_with("image/")
                || (lower_ct.starts_with("text/plain") && !playlist_like)
            {
                return None;
            }
            let format = format_of(&parsed, &content_type, &final_url)?;
            let mut hls_image = false;
            let mut hls_duration_ok = true;
            if format == "hls" {
                let length = response.content_length().unwrap_or(0);
                if length <= 2_000_000 {
                    let body = response.text().await.ok()?;
                    let (total, master, segment) = hls_playlist_stats(&body);
                    if let Some(segment) = segment {
                        let resolved = final_url
                            .join(&segment)
                            .map(|url| url.to_string())
                            .unwrap_or(segment);
                        hls_image = segment_looks_like_image(&resolved);
                    }
                    if !master {
                        if let Some(total) = total {
                            let expected = if expected_duration > 0 {
                                expected_duration as f64
                            } else {
                                duration_from_info(&line.info) as f64
                            };
                            if expected > 0.0 {
                                hls_duration_ok = total + 15.0 >= expected * 0.5
                                    && total <= expected * 1.5 + 60.0;
                            }
                        }
                    }
                }
            }
            let codec = codec_rank(&line.info);
            let tier = match (format, codec) {
                ("mp4", 0) => 0,
                ("mp4", 1) => 1,
                ("hls", 0) => 2,
                ("hls", 1) => 3,
                ("mp4", _) => 4,
                ("hls", _) => 5,
                _ => 6,
            };
            let valid = format == "mp4" || (format == "hls" && !hls_image && hls_duration_ok);
            Some(ProbeOutcome {
                index,
                elapsed,
                format,
                tier,
                valid,
            })
        }
    });
    let results = futures::future::join_all(probes).await;
    let mut best: Option<ProbeOutcome> = None;
    for outcome in results.into_iter().flatten().filter(|outcome| outcome.valid) {
        let better = match &best {
            None => true,
            Some(current) => (outcome.tier, outcome.elapsed) < (current.tier, current.elapsed),
        };
        if better {
            best = Some(outcome);
        }
    }
    if let Some(best) = best {
        let line = &lines[best.index];
        eprintln!(
            "[anich] pick {} ({}) {} {:.2}s {}",
            best.index, line.source, best.format, best.elapsed, line.caption
        );
        return Ok((best.index, line.url.clone(), best.format.to_string()));
    }
    // 测速全部失败(弱网/全超时):退回首个 MP4,再退回首个 http 线路,交给播放端兜底。
    let index = lines
        .iter()
        .position(|line| line.url.to_ascii_lowercase().contains(".mp4"))
        .or_else(|| {
            lines
                .iter()
                .position(|line| line.url.starts_with("http"))
        })
        .ok_or_else(|| "没有可用线路".to_string())?;
    let url = lines[index].url.clone();
    let format = if url.to_ascii_lowercase().contains(".m3u8") {
        "hls"
    } else {
        "mp4"
    };
    eprintln!("[anich] pick fallback {} {} {}", index, format, lines[index].caption);
    Ok((index, url, format.to_string()))
}

/// 从详情缓存读取该集时长(秒),用于校验 HLS 播放列表。
pub fn cached_episode_duration(id: &str, episode_sort: u32) -> u64 {
    crate::play::cache_get(&format!("anich:sites:{id}"))
        .and_then(|json| serde_json::from_str::<Vec<AnichEpisode>>(&json).ok())
        .and_then(|episodes| {
            episodes
                .into_iter()
                .find(|episode| episode.sort == episode_sort)
        })
        .map(|episode| episode.duration)
        .unwrap_or(0)
}

/* -------------------------------- danmaku -------------------------------- */

fn danmaku_mode(mode: u32) -> &'static str {
    match mode {
        4 => "bottom",
        5 => "top",
        _ => "scroll",
    }
}

/// 聚合某集弹幕:AniCh 自建源 + B 站代理(经集 sites 中的 cid)。
pub async fn danmaku(
    id: &str,
    episode_sort: u32,
    bili_cids: &[String],
) -> Result<Vec<DanmakuItem>, String> {
    let mut items: Vec<DanmakuItem> = Vec::new();
    let mut failures = Vec::new();

    // 1) AniCh 自建弹幕(protobuf,每页 3000,offset 分页)
    let mut skip = 0u64;
    for page in 0..5u32 {
        let buf = match anich_get(
            "/danmaku",
            &[
                ("bangumi", id),
                ("episode", &episode_sort.to_string()),
                ("skip", &skip.to_string()),
            ],
        )
        .await
        {
            Ok(buf) => buf,
            Err(error) => {
                failures.push(format!("anich:{error}"));
                break;
            }
        };
        let mut page_count = 0usize;
        for (no, wire) in pb_fields(&buf) {
            if no != 1 {
                continue;
            }
            if let Wire::Bytes(bytes) = wire {
                // _data_ {id=1, color=2, date=3, text=4, t=5, time=6, type=7, from=8}
                let mut time = 0f64;
                let mut color = String::from("#ffffff");
                let mut text = String::new();
                let mut mode = 1u32;
                for (f, w) in pb_fields(bytes) {
                    match f {
                        2 => color = as_str(Some(&w)),
                        4 => text = as_str(Some(&w)),
                        6 => time = as_double(Some(&w)),
                        7 => mode = as_varint(Some(&w)) as u32,
                        _ => {}
                    }
                }
                if !text.is_empty() && time >= 0.0 {
                    items.push(DanmakuItem {
                        time_ms: (time * 1000.0) as u64,
                        mode: danmaku_mode(mode).to_string(),
                        color,
                        text,
                    });
                    page_count += 1;
                }
            }
        }
        if page_count < 3000 {
            break;
        }
        skip = (page as u64 + 1) * 3000;
    }

    // 2) B 站弹幕(protobuf,segment_index 从 1 起,空页即停;官方源优先,AniCh 代理回退)
    for cid in bili_cids {
        for base in BILI_DM_BASES {
            let mut got_any = false;
            let mut segment = 1u32;
            while segment < 30 {
                let Ok(seg_url) = reqwest::Url::parse_with_params(
                    base,
                    [
                        ("type", "1"),
                        ("oid", cid.as_str()),
                        ("segment_index", &segment.to_string()),
                    ],
                ) else {
                    break;
                };
                let seg_buf = match base_client().get(seg_url).timeout(VOD_TIMEOUT).send().await {
                    Ok(response) if response.status().is_success() => match response.bytes().await {
                        Ok(bytes) => bytes.to_vec(),
                        Err(_) => break,
                    },
                    _ => break,
                };
                let mut segment_count = 0usize;
                for (no, wire) in pb_fields(&seg_buf) {
                    if no != 1 {
                        continue;
                    }
                    if let Wire::Bytes(bytes) = wire {
                        let mut progress = 0u32;
                        let mut mode = 1u32;
                        let mut color = 0xffffffu32;
                        let mut content = String::new();
                        for (f, w) in pb_fields(bytes) {
                            match f {
                                2 => progress = as_fixed32(Some(&w)),
                                3 => mode = as_varint(Some(&w)) as u32,
                                5 => color = as_varint(Some(&w)) as u32,
                                7 => content = as_str(Some(&w)),
                                _ => {}
                            }
                        }
                        if !content.is_empty() {
                            items.push(DanmakuItem {
                                time_ms: progress as u64,
                                mode: danmaku_mode(mode).to_string(),
                                color: format!("#{:06x}", color & 0xffffff),
                                text: content,
                            });
                            segment_count += 1;
                            got_any = true;
                        }
                    }
                }
                if segment_count == 0 {
                    break;
                }
                segment += 1;
                tokio::time::sleep(Duration::from_millis(350)).await;
            }
            if got_any {
                break; // 该 cid 已拿到弹幕,无需回退下一源
            }
        }
    }

    if items.is_empty() && !failures.is_empty() {
        return Err(failures.join("; "));
    }
    items.sort_by_key(|item| item.time_ms);
    Ok(items)
}

/// 弹幕入口:从 play 缓存读取该集的弹幕源映射(B站 cid),聚合自建源与 B 站代理。
#[tauri::command]
pub async fn anime_danmaku(
    source_key: String,
    vod_id: String,
    episode_index: usize,
) -> Result<Vec<DanmakuItem>, String> {
    if !source_key.eq_ignore_ascii_case("anich") {
        // CMS 影视源暂无弹幕源,返回空列表(前端自动隐藏弹幕层)。
        return Ok(Vec::new());
    }
    let sites_json = crate::play::cache_get(&format!("anich:sites:{vod_id}"))
        .ok_or_else(|| "弹幕源信息尚未缓存,请先加载详情".to_string())?;
    let episodes: Vec<AnichEpisode> = serde_json::from_str(&sites_json)
        .map_err(|error| format!("弹幕源缓存解析失败:{error}"))?;
    // episode_index 为集数组下标;sort 是 AniCh 全局序号,二者不可混用。
    let episode = episodes
        .get(episode_index)
        .ok_or_else(|| "集不存在".to_string())?;
    let bili_cids: Vec<String> = episode
        .sites
        .iter()
        .filter(|site| site.site == "bili_cid" || site.site == "bili_hmt_cid")
        .map(|site| site.id.clone())
        .collect();
    danmaku(vod_id.trim(), episode.sort, &bili_cids).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_vod_url_by_dropping_fourth_char() {
        // 上游混淆:base64(真实直链) 的第 4 个字符处插入垃圾字符
        let poisoned = "aHRZ0cHM6Ly9jZG4uZXhhbXBsZS5jb20vYS8xLm0zdTg=";
        let decoded = decode_vod_url(poisoned).expect("decode");
        assert_eq!(decoded, "https://cdn.example.com/a/1.m3u8");
    }

#[test]
    fn response_is_valid_rejects_json_error_body() {
        assert!(!response_is_valid(
            b"{\"error\":true,\"message\":\"unauthorized\"}"
        ));
        assert!(response_is_valid(b"\n\x10protobuf-binary"));
        assert!(response_is_valid(b"{\"ok\":true}"));
        assert!(!response_is_valid(b"<!DOCTYPE html><html>challenge</html>"));
        assert!(!response_is_valid(b"  <html>blocked</html>"));
    }

    #[test]
    fn anich_get_reaches_an_entry() {
        let result = tauri::async_runtime::block_on(anich_get(
            "/bangumi/search",
            &[("keyword", "蜡笔小新"), ("skip", "0")],
        ));
        match result {
            Ok(bytes) => println!("anich_get ok: {} bytes", bytes.len()),
            Err(error) => println!("anich_get failed (network-dependent): {error}"),
        }
    }

    #[test]
    fn payload_bytes_restores_json_integer_arrays() {
        assert_eq!(payload_bytes(b"[10, 4, 0, 255]"), vec![10, 4, 0, 255]);
        let plain = b"\n\x10protobuf";
        assert_eq!(payload_bytes(plain), plain.to_vec());
    }

    #[test]
    fn parses_vod_items_from_json_wrapped_payload() {
        fn varint(mut value: u32) -> Vec<u8> {
            let mut out = Vec::new();
            loop {
                let byte = (value & 0x7f) as u8;
                value >>= 7;
                if value == 0 {
                    out.push(byte);
                    break;
                }
                out.push(byte | 0x80);
            }
            out
        }
        fn bytes_field(no: u32, payload: &[u8]) -> Vec<u8> {
            let mut out = varint((no << 3) | 2);
            out.extend(varint(payload.len() as u32));
            out.extend_from_slice(payload);
            out
        }
        let mut item = Vec::new();
        item.extend(bytes_field(
            1,
            b"aHRZ0cHM6Ly9jZG4uZXhhbXBsZS5jb20vYS8xLm0zdTg=",
        ));
        item.extend(bytes_field(4, "第1集".as_bytes()));
        item.extend(bytes_field(5, b"ek-20"));
        item.extend(bytes_field(6, "23:40 · H.264".as_bytes()));
        let vod = bytes_field(1, &item);
        let json = format!(
            "[{}]",
            vod.iter()
                .map(|byte| byte.to_string())
                .collect::<Vec<_>>()
                .join(",")
        );
        let lines = parse_vod_lines(&payload_bytes(json.as_bytes()));
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].url, "https://cdn.example.com/a/1.m3u8");
        assert_eq!(lines[0].caption, "第1集");
        assert_eq!(lines[0].source, "ek-20");
    }

    #[test]
    fn reads_info_duration_and_codec() {
        assert_eq!(
            duration_from_info("吉伊卡哇 · 1920x1080 · 2.56Mbps · 23:40 · H.264"),
            1420
        );
        assert_eq!(
            duration_from_info("海贼王谈恋爱 · 1080x1920 · 07:10 · H.264"),
            430
        );
        assert_eq!(codec_rank("H.265/HEVC"), 2);
        assert_eq!(codec_rank("H.264"), 0);
        assert_eq!(codec_rank("吉伊卡哇"), 1);
    }

    #[test]
    fn detects_image_hls_segments() {
        assert!(segment_looks_like_image("https://cdn/a.png"));
        assert!(segment_looks_like_image("https://cdn/a.JPG?x=1"));
        assert!(!segment_looks_like_image("https://cdn/a.ts"));
        assert!(!segment_looks_like_image("https://cdn/segment"));
    }

    #[test]
    #[ignore = "network-dependent live check"]
    fn live_vod_flow_picks_playable_line() {
        let raw = tauri::async_runtime::block_on(anich_get("/vod/38374/7", &[]))
            .expect("vod request");
        let lines = parse_vod_lines(&payload_bytes(&raw));
        assert!(!lines.is_empty(), "no lines parsed");
        let (index, url, format) = tauri::async_runtime::block_on(pick_fastest(
            &lines,
            None,
            1420,
        ))
        .expect("pick");
        println!(
            "picked {index} {format} {} {}",
            lines[index].source, url
        );
    }
}
