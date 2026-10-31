use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::net::IpAddr;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use reqwest::Url;
use tauri::http::{header, Method, Request, Response};
use tauri::AppHandle;

use crate::play::{self, AdRules, SourceConfig};

const PROXY_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";
const HOST_CHECK_TTL: Duration = Duration::from_secs(600);
const MAX_PLAYLIST_BYTES: usize = 2 * 1024 * 1024;
const MAX_SEGMENT_BYTES: usize = 64 * 1024 * 1024;
/// 大文件(MP4)按段回源:代理需要缓冲响应体,不能一次拉整部影片。
const MAX_MEDIA_CHUNK_BYTES: usize = 16 * 1024 * 1024;

/// 连接层私网拦截:自定义 DNS resolver 在解析结果交给 hyper 之前逐 IP 校验,
/// 关闭 ensure_public_host 之后、真实 TCP 连接之前的 DNS rebinding 窗口。
pub(crate) struct PublicDnsResolver;

impl reqwest::dns::Resolve for PublicDnsResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_string();
        Box::pin(async move {
            let addrs = tokio::net::lookup_host((host.as_str(), 0))
                .await
                .map_err(|error| -> Box<dyn std::error::Error + Send + Sync> {
                    Box::new(error)
                })?;
            let mut allowed: Vec<std::net::SocketAddr> = Vec::new();
            for address in addrs {
                if is_forbidden_ip(address.ip()) {
                    return Err("blocked private ip during dns resolution".into());
                }
                allowed.push(address);
            }
            if allowed.is_empty() {
                return Err("dns lookup returned no address".into());
            }
            Ok(Box::new(allowed.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

fn build_client(block_private: bool) -> reqwest::Client {
    let mut builder = reqwest::Client::builder()
        .user_agent(PROXY_USER_AGENT)
        .no_gzip()
        .connect_timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() >= 6 {
                return attempt.error("too many redirects");
            }
            if !matches!(attempt.url().scheme(), "http" | "https") {
                return attempt.error("blocked redirect scheme");
            }
            if let Some(host) = attempt.url().host_str() {
                if is_blocked_host_name(host) && block_private {
                    return attempt.error("blocked redirect host");
                }
                let bare = host.trim_start_matches('[').trim_end_matches(']');
                if block_private {
                    if let Ok(ip) = bare.parse::<IpAddr>() {
                        if is_forbidden_ip(ip) {
                            return attempt.error("blocked redirect ip");
                        }
                    }
                }
            } else {
                return attempt.error("redirect without host");
            }
            attempt.follow()
        }));
    if block_private {
        builder = builder.dns_resolver(std::sync::Arc::new(PublicDnsResolver));
    }
    builder
        .build()
        .expect("failed to build stream proxy http client")
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| build_client(true))
}

fn private_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| build_client(false))
}

fn client_for(source: &SourceConfig) -> &'static reqwest::Client {
    if source.allow_private_network {
        private_client()
    } else {
        client()
    }
}

struct HostCheck {
    checked_at: Instant,
    allowed: bool,
}

fn host_checks() -> &'static Mutex<HashMap<String, HostCheck>> {
    static CHECKS: OnceLock<Mutex<HashMap<String, HostCheck>>> = OnceLock::new();
    CHECKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn host_check_get(key: &str) -> Option<bool> {
    let mut guard = host_checks()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(entry) = guard.get(key) {
        if entry.checked_at.elapsed() < HOST_CHECK_TTL {
            return Some(entry.allowed);
        }
        guard.remove(key);
    }
    None
}

fn host_check_put(key: String, allowed: bool) {
    let mut guard = host_checks()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if guard.len() >= 512 && !guard.contains_key(&key) {
        if let Some(oldest) = guard
            .iter()
            .min_by_key(|(_, entry)| entry.checked_at)
            .map(|(host, _)| host.clone())
        {
            guard.remove(&oldest);
        }
    }
    guard.insert(
        key,
        HostCheck {
            checked_at: Instant::now(),
            allowed,
        },
    );
}

fn is_blocked_host_name(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host == "metadata.google.internal"
}

fn is_forbidden_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let octets = v4.octets();
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_multicast()
                || v4 == std::net::Ipv4Addr::BROADCAST
                || (octets[0] == 100 && (64..=127).contains(&octets[1]))
        }
        IpAddr::V6(v6) => {
            if v6.is_loopback() || v6.is_unspecified() || v6.is_multicast() {
                return true;
            }
            let segments = v6.segments();
            if (segments[0] & 0xfe00) == 0xfc00 {
                return true;
            }
            if (segments[0] & 0xffc0) == 0xfe80 {
                return true;
            }
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_forbidden_ip(IpAddr::V4(v4));
            }
            false
        }
    }
}

async fn ensure_public_host(url: &Url) -> Result<(), String> {
    let host = url
        .host_str()
        .ok_or_else(|| "upstream url missing host".to_string())?;
    let host = host.trim().to_ascii_lowercase();
    if is_blocked_host_name(&host) {
        return Err("blocked private host".to_string());
    }
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = bare.parse::<IpAddr>() {
        return if is_forbidden_ip(ip) {
            Err("blocked private ip".to_string())
        } else {
            Ok(())
        };
    }
    let port = url.port_or_known_default().unwrap_or(443);
    let cache_key = format!("{host}:{port}");
    if let Some(allowed) = host_check_get(&cache_key) {
        return if allowed {
            Ok(())
        } else {
            Err("blocked private host".to_string())
        };
    }
    let lookup = tokio::net::lookup_host((host.clone(), port)).await;
    match lookup {
        Ok(addresses) => {
            let mut saw_address = false;
            for address in addresses {
                saw_address = true;
                if is_forbidden_ip(address.ip()) {
                    host_check_put(cache_key, false);
                    return Err("blocked private ip".to_string());
                }
            }
            if !saw_address {
                host_check_put(cache_key, false);
                return Err("dns lookup returned no address".to_string());
            }
            host_check_put(cache_key, true);
            Ok(())
        }
        Err(error) => {
            eprintln!("[jjstream] dns lookup failed for {host}: {error}");
            Err("dns lookup failed".to_string())
        }
    }
}

fn parse_proxy_uri(uri: &str) -> Option<(String, String)> {
    let rest = if let Some(rest) = uri.strip_prefix("jjstream://") {
        rest.strip_prefix("localhost/").unwrap_or(rest)
    } else if let Some(rest) = uri
        .strip_prefix("http://jjstream.localhost/")
        .or_else(|| uri.strip_prefix("https://jjstream.localhost/"))
    {
        rest
    } else {
        return None;
    };
    let rest = rest.trim_start_matches('/');
    let (key, encoded_and_query) = rest.split_once('/')?;
    // token 挂在尾部 query(?k=...)；encoded 里的 '?' 已被编码,首个裸 '?' 即分隔符。
    let (encoded, query) = match encoded_and_query.split_once('?') {
        Some((encoded, query)) => (encoded, query),
        None => (encoded_and_query, ""),
    };
    let token_valid = query.split('&').any(|pair| match pair.split_once('=') {
        Some(("k", value)) => value == play::proxy_token(),
        _ => false,
    });
    if !token_valid {
        return None;
    }
    if key.is_empty() || encoded.is_empty() {
        return None;
    }
    let decoded = urlencoding::decode(encoded).ok()?.trim().to_string();
    let lower = decoded.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return None;
    }
    Some((key.to_string(), decoded))
}

fn apply_proxy_headers(
    builder: reqwest::RequestBuilder,
    source: &SourceConfig,
    url: &Url,
) -> reqwest::RequestBuilder {
    let mut builder = builder;
    if let Some(ua) = source
        .headers
        .user_agent
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        builder = builder.header(header::USER_AGENT, ua);
    }
    let referer = source
        .headers
        .referer
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.to_string())
        .or_else(|| play::default_origin(url));
    if let Some(referer) = referer {
        builder = builder.header(header::REFERER, referer);
    }
    if let Some(origin) = source
        .headers
        .origin
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        builder = builder.header(header::ORIGIN, origin);
    }
    builder
}

fn cors_headers(builder: tauri::http::response::Builder) -> tauri::http::response::Builder {
    builder
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, HEAD, OPTIONS")
        .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "Range, If-Range")
        .header(
            header::ACCESS_CONTROL_EXPOSE_HEADERS,
            "Content-Length, Content-Range, Accept-Ranges",
        )
        .header(header::ACCEPT_RANGES, "bytes")
}

fn error_response(status: u16, message: &str) -> Response<Vec<u8>> {
    let body = message.as_bytes().to_vec();
    cors_headers(Response::builder().status(status))
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::CONTENT_LENGTH, body.len().to_string())
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn cors_preflight() -> Response<Vec<u8>> {
    cors_headers(Response::builder().status(204))
        .body(Vec::new())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn looks_like_playlist_url(url: &Url) -> bool {
    url.path().to_ascii_lowercase().ends_with(".m3u8")
        || url.as_str().to_ascii_lowercase().contains(".m3u8")
}

fn is_playlist_content_type(value: &str) -> bool {
    let value = value.to_ascii_lowercase();
    value.contains("mpegurl") || value.contains("m3u8")
}

fn looks_like_m3u8(bytes: &[u8]) -> bool {
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(64)]);
    head.trim_start_matches('\u{feff}')
        .trim_start()
        .starts_with("#EXTM3U")
}

fn guess_content_type(url: &Url) -> String {
    let path = url.path().to_ascii_lowercase();
    let value = if path.ends_with(".ts") {
        "video/mp2t"
    } else if path.ends_with(".m4s") || path.ends_with(".mp4") {
        "video/mp4"
    } else if path.ends_with(".aac") {
        "audio/aac"
    } else if path.ends_with(".m3u8") {
        "application/vnd.apple.mpegurl"
    } else {
        "application/octet-stream"
    };
    value.to_string()
}

fn rewrite_uri(uri: &str, base: &Url, source_key: &str) -> String {
    let trimmed = uri.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let Ok(resolved) = base.join(trimmed) else {
        return uri.to_string();
    };
    if !matches!(resolved.scheme(), "http" | "https") {
        return uri.to_string();
    }
    play::proxy_url(source_key, resolved.as_str())
}

fn rewrite_uri_attrs(line: &str, base: &Url, source_key: &str) -> String {
    let mut output = String::with_capacity(line.len() + 64);
    let mut rest = line;
    while let Some(position) = rest.find("URI=\"") {
        let (before, after) = rest.split_at(position + 5);
        output.push_str(before);
        let Some(end) = after.find('"') else {
            output.push_str(after);
            return output;
        };
        let (uri, tail) = after.split_at(end);
        output.push_str(&rewrite_uri(uri, base, source_key));
        output.push('"');
        rest = &tail[1..];
    }
    output.push_str(rest);
    output
}

const AD_KEYWORDS: [&str; 9] = [
    "ad", "ads", "adv", "advert", "gg", "guanggao", "sponsor", "promo", "adjump",
];
const AD_SAFETY_RATIO: f64 = 0.30;

#[cfg(test)]
fn rewrite_playlist(text: &str, base: &Url, source_key: &str, ad_filter: &str) -> String {
    rewrite_playlist_with_rules(text, base, source_key, ad_filter, &AdRules::default())
}

fn rewrite_playlist_with_rules(
    text: &str,
    base: &Url,
    source_key: &str,
    ad_filter: &str,
    rules: &AdRules,
) -> String {
    let filtered = if ad_filter == "safe" {
        filter_ads_with_rules(text, base, source_key, rules)
    } else {
        text.to_string()
    };
    rewrite_playlist_uris(&filtered, base, source_key)
}

fn rewrite_playlist_uris(text: &str, base: &Url, source_key: &str) -> String {
    let text = text.trim_start_matches('\u{feff}');
    let mut output = String::with_capacity(text.len() + 256);
    for raw_line in text.lines() {
        let line = raw_line.trim_end_matches('\r');
        let content = line.trim_start();
        if content.trim().is_empty() {
            output.push('\n');
            continue;
        }
        if content.starts_with('#') {
            output.push_str(&rewrite_uri_attrs(content, base, source_key));
        } else {
            output.push_str(&rewrite_uri(content.trim(), base, source_key));
        }
        output.push('\n');
    }
    output
}

#[derive(Debug)]
enum HlsItem {
    Global(String),
    CueTag,
    Segment(SegmentEntry),
}

#[derive(Debug)]
struct SegmentEntry {
    prefix: Vec<String>,
    uri: String,
    /// URL + BYTERANGE；fMP4 中同一 URI 的不同字节段不是重复分片。
    identity: String,
    duration: f64,
    block: usize,
    ad_cue: bool,
    ad_keyword: bool,
    ad_marker: bool,
    drop: bool,
}

fn is_segment_prefix_tag(line: &str) -> bool {
    line.starts_with("#EXTINF:")
        || line.starts_with("#EXT-X-BYTERANGE:")
        || line.starts_with("#EXT-X-PROGRAM-DATE-TIME:")
        || line.starts_with("#EXT-X-GAP")
        || line.starts_with("#EXT-X-BITRATE:")
}

fn parse_extinf_duration(line: &str) -> Option<f64> {
    let rest = line.strip_prefix("#EXTINF:")?;
    rest.split(',').next()?.trim().parse::<f64>().ok()
}

fn has_ad_keyword(url: &Url) -> bool {
    let path = url.path().to_ascii_lowercase();
    let mut tokens = Vec::new();
    let mut token = String::new();
    for character in path.chars() {
        if character.is_ascii_alphanumeric() {
            token.push(character);
        } else if !token.is_empty() {
            tokens.push(std::mem::take(&mut token));
        }
    }
    if !token.is_empty() {
        tokens.push(token);
    }
    tokens
        .iter()
        .any(|token| AD_KEYWORDS.contains(&token.as_str()))
}

fn segment_identity(item: &HlsItem) -> &str {
    match item {
        HlsItem::Segment(segment) => segment.identity.as_str(),
        _ => "",
    }
}

fn mark_repeated_blocks(items: &mut [HlsItem], indices: &[usize]) {
    let mut counts: HashMap<String, usize> = HashMap::new();
    for &index in indices {
        if let HlsItem::Segment(segment) = &items[index] {
            *counts.entry(segment.identity.clone()).or_default() += 1;
        }
    }

    let mut marks: HashSet<usize> = HashSet::new();
    for &index in indices {
        if let HlsItem::Segment(segment) = &items[index] {
            if counts.get(&segment.identity).copied().unwrap_or(0) >= 2 {
                marks.insert(index);
            }
        }
    }

    // 同一 ≥3 段块在整条列表中出现 ≥2 次时，删除全部出现位置。
    const MAX_BLOCK_LEN: usize = 12;
    for length in 3..=MAX_BLOCK_LEN {
        if indices.len() < length {
            break;
        }
        let mut windows: HashMap<u64, Vec<usize>> = HashMap::new();
        for start in 0..=indices.len() - length {
            let mut hasher = DefaultHasher::new();
            for offset in 0..length {
                segment_identity(&items[indices[start + offset]]).hash(&mut hasher);
                0u8.hash(&mut hasher);
            }
            windows.entry(hasher.finish()).or_default().push(start);
        }
        for starts in windows.values().filter(|starts| starts.len() >= 2) {
            for &start in starts {
                for offset in 0..length {
                    marks.insert(indices[start + offset]);
                }
            }
        }
    }

    for &index in &marks {
        if let HlsItem::Segment(segment) = &mut items[index] {
            segment.drop = true;
        }
    }
}

fn block_duration(items: &[HlsItem], indices: &[usize]) -> f64 {
    indices
        .iter()
        .filter_map(|&index| match &items[index] {
            HlsItem::Segment(segment) => Some(segment.duration),
            _ => None,
        })
        .sum()
}

/// 分片所在的 host + 目录:同目录的中插广告靠时长识别,跨目录/跨 host 的靠前缀识别。
fn segment_url_prefix(identity: &str) -> String {
    let raw = identity.split('|').next().unwrap_or(identity);
    let Ok(url) = Url::parse(raw) else {
        return String::new();
    };
    let directory = url.path().rsplit_once('/').map(|(dir, _)| dir).unwrap_or("");
    format!(
        "{}://{}{}",
        url.scheme(),
        url.host_str().unwrap_or(""),
        directory
    )
}

fn block_prefix(items: &[HlsItem], indices: &[usize]) -> String {
    for &index in indices {
        if let HlsItem::Segment(segment) = &items[index] {
            let prefix = segment_url_prefix(&segment.identity);
            if !prefix.is_empty() {
                return prefix;
            }
        }
    }
    String::new()
}

/// 删除 discontinuity 分块中的异常块:
/// - 中插广告常是 4~10 秒的短块(如电影天堂 5:15 的赌场广告);
/// - 跨 host/目录且整条列表只出现一次的块;
///
/// 首块/尾块始终保留,最终还会受 maxDropRatio 安全阈值约束。
fn mark_block_ads(items: &mut [HlsItem], indices: &[usize], rules: &AdRules) {
    if !rules.drop_short_blocks && !rules.drop_unique_host_blocks {
        return;
    }
    let mut blocks: Vec<(usize, Vec<usize>)> = Vec::new();
    for &index in indices {
        let HlsItem::Segment(segment) = &items[index] else {
            continue;
        };
        match blocks.last_mut() {
            Some((block, list)) if *block == segment.block => list.push(index),
            _ => blocks.push((segment.block, vec![index])),
        }
    }
    if blocks.len() < 3 {
        return;
    }
    let mut prefix_duration: HashMap<String, f64> = HashMap::new();
    for (_, list) in &blocks {
        let prefix = block_prefix(items, list);
        if !prefix.is_empty() {
            *prefix_duration.entry(prefix).or_default() += block_duration(items, list);
        }
    }
    let dominant = prefix_duration
        .iter()
        .max_by(|left, right| left.1.partial_cmp(right.1).unwrap_or(std::cmp::Ordering::Equal))
        .map(|(prefix, _)| prefix.clone());
    let first_block = blocks.first().map(|(block, _)| *block);
    let last_block = blocks.last().map(|(block, _)| *block);
    for (block, list) in &blocks {
        if Some(*block) == first_block || Some(*block) == last_block {
            continue;
        }
        let duration = block_duration(items, list);
        if duration <= 0.0 {
            continue;
        }
        let short = rules.drop_short_blocks
            && rules.short_block_seconds > 0.0
            && duration <= rules.short_block_seconds;
        let unique_host = if rules.drop_unique_host_blocks
            && rules.max_ad_block_seconds > 0.0
            && duration <= rules.max_ad_block_seconds
        {
            let prefix = block_prefix(items, list);
            !prefix.is_empty() && dominant.as_deref() != Some(prefix.as_str())
        } else {
            false
        };
        if !short && !unique_host {
            continue;
        }
        for &index in list {
            if let HlsItem::Segment(segment) = &mut items[index] {
                segment.drop = true;
            }
        }
    }
}

/// 精确广告指纹:匹配连续分片的时长序列。只删命中的分片,前后正片不动。
fn mark_duration_fingerprints(items: &mut [HlsItem], indices: &[usize], rules: &AdRules) {
    if rules.ad_duration_fingerprints.is_empty() || rules.ad_duration_tolerance <= 0.0 {
        return;
    }
    for fingerprint in &rules.ad_duration_fingerprints {
        let length = fingerprint.len();
        if length < 2 || indices.len() < length {
            continue;
        }
        for start in 0..=indices.len() - length {
            let matched = (0..length).all(|offset| match &items[indices[start + offset]] {
                HlsItem::Segment(segment) => {
                    (segment.duration - fingerprint[offset]).abs()
                        <= rules.ad_duration_tolerance
                }
                _ => false,
            });
            if matched {
                for offset in 0..length {
                    if let HlsItem::Segment(segment) = &mut items[indices[start + offset]] {
                        segment.drop = true;
                    }
                }
            }
        }
    }
}

fn removed_block_count(indices: &[usize], items: &[HlsItem]) -> usize {
    let mut blocks = 0usize;
    let mut previous_drop = false;
    for &index in indices {
        let is_drop = matches!(&items[index], HlsItem::Segment(segment) if segment.drop);
        if is_drop && !previous_drop {
            blocks += 1;
        }
        previous_drop = is_drop;
    }
    blocks
}

fn rebuild_filtered(items: &[HlsItem]) -> String {
    let mut output = String::new();
    let mut last_kept_seen = false;
    let mut removed_pending = false;
    let mut last_line_is_discontinuity = false;
    for item in items {
        match item {
            HlsItem::Global(line) => {
                output.push_str(line);
                output.push('\n');
                last_line_is_discontinuity = line.trim() == "#EXT-X-DISCONTINUITY";
            }
            HlsItem::CueTag => {}
            HlsItem::Segment(segment) => {
                if segment.drop {
                    removed_pending = true;
                    continue;
                }
                if removed_pending && last_kept_seen && !last_line_is_discontinuity {
                    output.push_str("#EXT-X-DISCONTINUITY\n");
                }
                for line in &segment.prefix {
                    output.push_str(line);
                    output.push('\n');
                }
                output.push_str(&segment.uri);
                output.push('\n');
                last_kept_seen = true;
                removed_pending = false;
                last_line_is_discontinuity = false;
            }
        }
    }
    output
}

#[cfg(test)]
fn filter_ads(text: &str, base: &Url, source_key: &str) -> String {
    filter_ads_with_rules(text, base, source_key, &AdRules::default())
}

fn filter_ads_with_rules(
    text: &str,
    base: &Url,
    source_key: &str,
    rules: &AdRules,
) -> String {
    let original = text.trim_start_matches('\u{feff}').to_string();
    let lines: Vec<&str> = original.lines().collect();
    if lines.iter().any(|line| {
        let line = line.trim_start();
        line.starts_with("#EXT-X-STREAM-INF") || line.starts_with("#EXT-X-MEDIA:")
    }) {
        return original;
    }
    if lines.iter().any(|line| {
        let line = line.trim_start();
        line.starts_with("#EXT-X-PART")
            || line.starts_with("#EXT-X-PRELOAD-HINT")
            || line.starts_with("#EXT-X-SKIP")
    }) {
        eprintln!("[jjstream] ad filter {source_key} skipped: LL-HLS/delta playlist");
        return original;
    }

    let mut items = Vec::new();
    let mut pending_prefix: Vec<String> = Vec::new();
    let mut cue_out = false;
    let mut ppvod_active = false;
    let mut ppvod_segment_seen = false;
    let mut block = 0usize;
    for raw in &lines {
        let line = raw.trim_end_matches('\r');
        let content = line.trim();
        if content.is_empty() {
            items.push(HlsItem::Global(line.to_string()));
            continue;
        }
        if content.starts_with('#') {
            if content.starts_with("# ppvod-ad-injected") {
                ppvod_active = true;
                ppvod_segment_seen = false;
                continue;
            }
            if ppvod_active && content.starts_with("#EXT-X-DISCONTINUITY") {
                if ppvod_segment_seen {
                    ppvod_active = false;
                    ppvod_segment_seen = false;
                    items.push(HlsItem::Global(line.to_string()));
                }
                block += 1;
                // 标记块的起始 discontinuity 一并丢弃
                continue;
            }
            if ppvod_active && content.starts_with("#EXT-X-CUE-IN") {
                ppvod_active = false;
                ppvod_segment_seen = false;
                items.push(HlsItem::CueTag);
                continue;
            }
            if content.starts_with("#EXT-X-CUE-OUT-CONT") {
                items.push(HlsItem::CueTag);
                continue;
            }
            if content.starts_with("#EXT-X-CUE-OUT") {
                cue_out = true;
                items.push(HlsItem::CueTag);
                continue;
            }
            if content.starts_with("#EXT-X-CUE-IN") {
                cue_out = false;
                items.push(HlsItem::CueTag);
                continue;
            }
            if is_segment_prefix_tag(content) {
                pending_prefix.push(line.to_string());
                continue;
            }
            items.push(HlsItem::Global(line.to_string()));
            if content == "#EXT-X-DISCONTINUITY" {
                block += 1;
            }
            continue;
        }
        let url = base
            .join(content)
            .ok()
            .filter(|url| matches!(url.scheme(), "http" | "https"));
        let duration = pending_prefix
            .iter()
            .rev()
            .find_map(|line| parse_extinf_duration(line))
            .unwrap_or(0.0);
        let ad_keyword = url.as_ref().map(has_ad_keyword).unwrap_or(false);
        let byterange = pending_prefix
            .iter()
            .rev()
            .find_map(|line| line.strip_prefix("#EXT-X-BYTERANGE:"))
            .map(str::trim);
        let uri_key = url.as_ref().map(|url| url.as_str()).unwrap_or(content);
        let identity = match byterange {
            Some(range) => format!("{uri_key}|{range}"),
            None => uri_key.to_string(),
        };
        let ad_marker = ppvod_active;
        if ppvod_active {
            ppvod_segment_seen = true;
        }
        items.push(HlsItem::Segment(SegmentEntry {
            prefix: std::mem::take(&mut pending_prefix),
            uri: content.to_string(),
            identity,
            duration,
            block,
            ad_cue: cue_out,
            ad_keyword,
            ad_marker,
            drop: false,
        }));
    }
    for line in pending_prefix {
        items.push(HlsItem::Global(line));
    }

    let indices: Vec<usize> = items
        .iter()
        .enumerate()
        .filter_map(|(index, item)| match item {
            HlsItem::Segment(_) => Some(index),
            _ => None,
        })
        .collect();
    if indices.is_empty() {
        return original;
    }
    let total_duration: f64 = indices
        .iter()
        .filter_map(|&index| match &items[index] {
            HlsItem::Segment(segment) => Some(segment.duration),
            _ => None,
        })
        .sum();
    if total_duration <= 0.0 {
        eprintln!("[jjstream] ad filter {source_key} skipped: no EXTINF durations");
        return original;
    }

    for &index in &indices {
        if let HlsItem::Segment(segment) = &mut items[index] {
            if segment.ad_cue || segment.ad_keyword || segment.ad_marker {
                segment.drop = true;
            }
        }
    }
    mark_repeated_blocks(&mut items, &indices);
    mark_duration_fingerprints(&mut items, &indices, rules);
    mark_block_ads(&mut items, &indices, rules);

    let removed_duration: f64 = indices
        .iter()
        .filter_map(|&index| match &items[index] {
            HlsItem::Segment(segment) if segment.drop => Some(segment.duration),
            _ => None,
        })
        .sum();
    let removed_count = indices
        .iter()
        .filter(|&&index| matches!(&items[index], HlsItem::Segment(segment) if segment.drop))
        .count();
    let removed_blocks = removed_block_count(&indices, &items);
    if removed_count == 0 {
        return original;
    }
    let ratio = removed_duration / total_duration * 100.0;
    let max_ratio = if rules.max_drop_ratio > 0.0 {
        rules.max_drop_ratio
    } else {
        AD_SAFETY_RATIO
    };
    if removed_duration > total_duration * max_ratio {
        eprintln!(
            "[jjstream] ad filter {source_key} skipped: would remove {removed_blocks} blocks / {removed_count} segments / {removed_duration:.2}s of {total_duration:.2}s ({ratio:.1}%) (>{:.0}%)",
            max_ratio * 100.0
        );
        return original;
    }
    eprintln!(
        "[jjstream] ad filter {source_key}: removed {removed_blocks} blocks / {removed_count} segments / {removed_duration:.2}s of {total_duration:.2}s ({ratio:.1}%)"
    );
    rebuild_filtered(&items)
}

/// 把客户端的 Range 收敛到单段、限定大小:视频元素常发 `bytes=0-`(不带上界),
/// 直接转发会把整部 MP4 拉进内存。返回 206 分段后播放器会继续请求下一段。
fn bound_media_range(range: Option<&str>) -> Option<String> {
    let cap_end = MAX_MEDIA_CHUNK_BYTES as u64 - 1;
    let Some(range) = range else {
        return Some(format!("bytes=0-{cap_end}"));
    };
    let spec = range.trim().strip_prefix("bytes=")?;
    if spec.contains(',') {
        return None;
    }
    let (start, end) = spec.split_once('-')?;
    let start: u64 = start.trim().parse().ok()?;
    let max_end = start.saturating_add(cap_end);
    let end = match end.trim() {
        "" => max_end,
        value => value.parse::<u64>().ok()?.min(max_end),
    };
    if end < start {
        return Some(format!("bytes={start}-{max_end}"));
    }
    Some(format!("bytes={start}-{end}"))
}

pub async fn handle(app: AppHandle, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let method = request.method().clone();
    let uri = request.uri().to_string();
    if method == Method::OPTIONS {
        return cors_preflight();
    }
    if method != Method::GET && method != Method::HEAD {
        return error_response(405, "method not allowed");
    }
    let Some((source_key, raw_url)) = parse_proxy_uri(&uri) else {
        return error_response(400, "invalid jjstream url");
    };
    let Some(source) = play::source_by_key(&app, &source_key) else {
        return error_response(404, "unknown play source");
    };
    let upstream = match Url::parse(&raw_url) {
        Ok(url) => url,
        Err(_) => return error_response(400, "invalid upstream url"),
    };
    if !matches!(upstream.scheme(), "http" | "https") {
        return error_response(400, "only http/https upstreams are allowed");
    }
    if !source.allow_private_network {
        if let Err(message) = ensure_public_host(&upstream).await {
            eprintln!(
                "[jjstream] blocked {}: {message}",
                play::safe_url(&upstream)
            );
            return error_response(403, &message);
        }
    }
    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string());
    let upstream_method = if method == Method::HEAD {
        reqwest::Method::HEAD
    } else {
        reqwest::Method::GET
    };
    let timeout = if looks_like_playlist_url(&upstream) {
        Duration::from_secs(10)
    } else {
        Duration::from_secs(60)
    };
    let mut builder = client_for(&source)
        .request(upstream_method, upstream.clone())
        .timeout(timeout)
        .header(header::ACCEPT, "*/*");
    let upstream_range = if method == Method::HEAD || looks_like_playlist_url(&upstream) {
        range.clone()
    } else {
        bound_media_range(range.as_deref())
    };
    if let Some(range) = upstream_range.as_deref() {
        builder = builder.header(header::RANGE, range);
    }
    builder = apply_proxy_headers(builder, &source, &upstream);
    eprintln!(
        "[jjstream] {} {} -> {}",
        method.as_str(),
        source.key,
        play::safe_url(&upstream)
    );
    let response = match builder.send().await {
        Ok(response) => response,
        Err(error) => {
            eprintln!("[jjstream] fetch failed: {}", error.without_url());
            return error_response(502, "upstream request failed");
        }
    };
    let status = response.status();
    let final_url = response.url().clone();
    let upstream_content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string());
    let content_range = response
        .headers()
        .get(header::CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string());
    let upstream_length = response.content_length();
    if !status.is_success() && status.as_u16() != 206 {
        eprintln!("[jjstream] upstream HTTP {}", status.as_u16());
        return error_response(502, &format!("upstream HTTP {}", status.as_u16()));
    }
    if method == Method::HEAD {
        let mut builder = cors_headers(Response::builder().status(status.as_u16()))
            .header(header::ACCEPT_RANGES, "bytes");
        if let Some(content_type) = upstream_content_type {
            builder = builder.header(header::CONTENT_TYPE, content_type);
        }
        if let Some(content_range) = content_range {
            builder = builder.header(header::CONTENT_RANGE, content_range);
        }
        if let Some(length) = upstream_length {
            builder = builder.header(header::CONTENT_LENGTH, length.to_string());
        }
        return builder
            .body(Vec::new())
            .unwrap_or_else(|_| error_response(500, "response build failed"));
    }
    let playlist_hint = looks_like_playlist_url(&final_url)
        || looks_like_playlist_url(&upstream)
        || upstream_content_type
            .as_deref()
            .map(is_playlist_content_type)
            .unwrap_or(false);
    let limit = if playlist_hint {
        MAX_PLAYLIST_BYTES
    } else {
        MAX_SEGMENT_BYTES
    };
    if let Some(length) = upstream_length {
        if length > limit as u64 {
            return error_response(502, "upstream body too large");
        }
    }
    let bytes = match response.bytes().await {
        Ok(bytes) => bytes,
        Err(_) => return error_response(502, "failed to read upstream body"),
    };
    if bytes.len() > limit {
        return error_response(502, "upstream body too large");
    }
    if playlist_hint || looks_like_m3u8(&bytes) {
        let text = String::from_utf8_lossy(&bytes);
        let rewritten = rewrite_playlist_with_rules(
            &text,
            &final_url,
            &source.key,
            &source.ad_filter,
            &source.ad_rules,
        );
        let body = rewritten.into_bytes();
        return cors_headers(Response::builder().status(200))
            .header(header::CONTENT_TYPE, "application/vnd.apple.mpegurl")
            .header(header::CACHE_CONTROL, "no-store")
            .header(header::CONTENT_LENGTH, body.len().to_string())
            .body(body)
            .unwrap_or_else(|_| error_response(500, "response build failed"));
    }
    let content_type = upstream_content_type.unwrap_or_else(|| guess_content_type(&upstream));
    let body = bytes.to_vec();
    let mut builder = cors_headers(Response::builder().status(status.as_u16()))
        .header(header::CONTENT_TYPE, content_type)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "public, max-age=3600")
        .header(header::CONTENT_LENGTH, body.len().to_string());
    if let Some(content_range) = content_range {
        builder = builder.header(header::CONTENT_RANGE, content_range);
    }
    builder
        .body(body)
        .unwrap_or_else(|_| error_response(500, "response build failed"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_proxy_uri_forms() {
        let raw = "https://cdn.example.com/hls/index.m3u8?sign=1";
        let encoded = urlencoding::encode(raw);
        let token = play::proxy_token();
        let windows = format!("http://jjstream.localhost/lzi/{encoded}?k={token}");
        assert_eq!(
            parse_proxy_uri(&windows),
            Some(("lzi".to_string(), raw.to_string()))
        );
        let wry = format!("jjstream://localhost/lzi/{encoded}?k={token}");
        assert_eq!(
            parse_proxy_uri(&wry),
            Some(("lzi".to_string(), raw.to_string()))
        );
        assert!(parse_proxy_uri(&format!("http://jjstream.localhost/lzi/{encoded}")).is_none());
        assert!(parse_proxy_uri(&format!(
            "http://jjstream.localhost/lzi/{encoded}?k=wrong-token"
        ))
        .is_none());
        assert!(parse_proxy_uri(&format!("http://jjstream.localhost/lzi/file.txt?k={token}")).is_none());
        assert!(parse_proxy_uri("https://example.com/lzi/x").is_none());
    }

    #[test]
    fn drops_short_middle_discontinuity_block() {
        let base = Url::parse("https://cdn.example.com/hls/index.m3u8").unwrap();
        let playlist = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-DISCONTINUITY\n#EXTINF:6,\nhttps://cdn.example.com/content/a1.ts\n#EXTINF:6,\nhttps://cdn.example.com/content/a2.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:2,\nhttps://cdn.example.com/content/ad1.ts\n#EXTINF:3,\nhttps://cdn.example.com/content/ad2.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:6,\nhttps://cdn.example.com/content/b1.ts\n#EXTINF:6,\nhttps://cdn.example.com/content/b2.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:6,\nhttps://cdn.example.com/content/c1.ts\n#EXTINF:6,\nhttps://cdn.example.com/content/c2.ts\n#EXT-X-ENDLIST\n";
        let rules = AdRules {
            drop_short_blocks: true,
            short_block_seconds: 8.0,
            ..AdRules::default()
        };
        let output = filter_ads_with_rules(playlist, &base, "dyttzy", &rules);
        assert!(!output.contains("ad1.ts"));
        assert!(!output.contains("ad2.ts"));
        assert!(output.contains("a1.ts"));
        assert!(output.contains("c2.ts"));
    }

    #[test]
    fn drops_exact_ad_duration_fingerprint() {
        let base = Url::parse("https://cdn.example.com/hls/index.m3u8").unwrap();
        // 广告被 discontinuity 切成 2+3 段;指纹跨块匹配,只删这 5 段。
        let playlist = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-DISCONTINUITY\n#EXTINF:4.171,\nhttps://cdn.example.com/content/a1.ts\n#EXTINF:4.171,\nhttps://cdn.example.com/content/a2.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:5.567,\nhttps://cdn.example.com/content/ad1.ts\n#EXTINF:2.933,\nhttps://cdn.example.com/content/ad2.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:5.7,\nhttps://cdn.example.com/content/ad3.ts\n#EXTINF:3.333,\nhttps://cdn.example.com/content/ad4.ts\n#EXTINF:1.533,\nhttps://cdn.example.com/content/ad5.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:4.171,\nhttps://cdn.example.com/content/b1.ts\n#EXTINF:4.171,\nhttps://cdn.example.com/content/b2.ts\n#EXT-X-ENDLIST\n";
        let rules = AdRules {
            ad_duration_fingerprints: vec![vec![5.567, 2.933, 5.7, 3.333, 1.533]],
            ad_duration_tolerance: 0.15,
            max_drop_ratio: 0.6,
            ..AdRules::default()
        };
        let output = filter_ads_with_rules(playlist, &base, "dyttzy", &rules);
        for ad in ["ad1.ts", "ad2.ts", "ad3.ts", "ad4.ts", "ad5.ts"] {
            assert!(!output.contains(ad), "{ad} should be removed");
        }
        for content in ["a1.ts", "a2.ts", "b1.ts", "b2.ts"] {
            assert!(output.contains(content), "{content} should be kept");
        }
    }

    #[test]
    fn drops_unique_host_middle_block() {
        let base = Url::parse("https://cdn.example.com/hls/index.m3u8").unwrap();
        let playlist = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-DISCONTINUITY\n#EXTINF:6,\nhttps://cdn.example.com/content/a1.ts\n#EXTINF:6,\nhttps://cdn.example.com/content/a2.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:6,\nhttps://ads.example.net/video/ad1.ts\n#EXTINF:6,\nhttps://ads.example.net/video/ad2.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:6,\nhttps://cdn.example.com/content/b1.ts\n#EXTINF:6,\nhttps://cdn.example.com/content/b2.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:6,\nhttps://cdn.example.com/content/c1.ts\n#EXTINF:6,\nhttps://cdn.example.com/content/c2.ts\n#EXT-X-ENDLIST\n";
        let rules = AdRules {
            drop_unique_host_blocks: true,
            max_ad_block_seconds: 120.0,
            ..AdRules::default()
        };
        let output = filter_ads_with_rules(playlist, &base, "test", &rules);
        assert!(!output.contains("ads.example.net"));
        assert!(output.contains("a1.ts"));
        assert!(output.contains("c2.ts"));
    }

    #[test]
    fn bounds_open_ended_media_ranges() {        let cap = format!("bytes=0-{}", MAX_MEDIA_CHUNK_BYTES - 1);
        assert_eq!(bound_media_range(None), Some(cap.clone()));
        assert_eq!(bound_media_range(Some("bytes=0-")), Some(cap.clone()));
        assert_eq!(
            bound_media_range(Some("bytes=0-999999999")),
            Some(cap.clone())
        );
        assert_eq!(
            bound_media_range(Some("bytes=100-1023")),
            Some("bytes=100-1023".to_string())
        );
        assert_eq!(bound_media_range(Some("bytes=-500")), None);
        assert_eq!(bound_media_range(Some("bytes=0-1,5-6")), None);
    }

    #[test]
    fn rewrites_playlist_segments_keys_and_maps() {
        let base = Url::parse("https://cdn.example.com/hls/master.m3u8").unwrap();
        let playlist = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n#EXT-X-MAP:URI=\"init.mp4\"\n1080p/index.m3u8\nhttps://other.example.com/seg.ts\n";
        let output = rewrite_playlist(playlist, &base, "lzi", "off");
        assert!(output.contains(&play::proxy_url(
            "lzi",
            "https://cdn.example.com/hls/key.bin"
        )));
        assert!(output.contains(&play::proxy_url(
            "lzi",
            "https://cdn.example.com/hls/init.mp4"
        )));
        assert!(output.contains(&play::proxy_url(
            "lzi",
            "https://cdn.example.com/hls/1080p/index.m3u8"
        )));
        assert!(output.contains(&play::proxy_url(
            "lzi",
            "https://other.example.com/seg.ts"
        )));
        assert!(output.starts_with("#EXTM3U\n"));
    }

    #[test]
    fn resolves_relative_key_and_variant_against_final_redirect_url() {
        let base = Url::parse("https://cdn.example.com/redirected/2025/enc/master.m3u8").unwrap();
        let playlist = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"enc.key\"\n#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1920x1080\nindex.m3u8\n";
        let output = rewrite_playlist(playlist, &base, "jszy", "off");
        assert!(output.contains(&play::proxy_url(
            "jszy",
            "https://cdn.example.com/redirected/2025/enc/enc.key"
        )));
        assert!(output.contains(&play::proxy_url(
            "jszy",
            "https://cdn.example.com/redirected/2025/enc/index.m3u8"
        )));
    }

    #[test]
    fn rewrites_bom_and_indented_playlist_lines() {
        let base = Url::parse("https://cdn.example.com/hls/master.m3u8").unwrap();
        let playlist = "\u{feff}#EXTM3U\n  #EXT-X-KEY:METHOD=AES-128,URI=\"enc.key\"\n  1080p/index.m3u8\n";
        let output = rewrite_playlist(playlist, &base, "jszy", "off");
        assert!(output.starts_with("#EXTM3U\n"));
        assert!(output.contains(&play::proxy_url(
            "jszy",
            "https://cdn.example.com/hls/enc.key"
        )));
        assert!(output.contains(&play::proxy_url(
            "jszy",
            "https://cdn.example.com/hls/1080p/index.m3u8"
        )));
    }

    #[test]
    fn keeps_non_http_uri_attributes() {
        let base = Url::parse("https://cdn.example.com/hls/master.m3u8").unwrap();
        let playlist = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"data:text/plain;base64,abc\"\n";
        let output = rewrite_playlist(playlist, &base, "lzi", "off");
        assert!(output.contains("URI=\"data:text/plain;base64,abc\""));
    }

    #[test]
    fn detects_m3u8_bodies() {
        assert!(looks_like_m3u8(b"#EXTM3U\n#EXT-X-VERSION:3\n"));
        assert!(looks_like_m3u8("\u{feff}#EXTM3U\n".as_bytes()));
        assert!(!looks_like_m3u8(b"ID3"));
    }

    #[test]
    fn blocks_private_addresses() {
        for ip in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.1.1",
            "100.64.0.1",
            "0.0.0.0",
            "255.255.255.255",
            "::1",
            "fc00::1",
            "fe80::1",
            "::ffff:127.0.0.1",
        ] {
            assert!(
                is_forbidden_ip(ip.parse::<IpAddr>().unwrap()),
                "{ip} should be blocked"
            );
        }
        for ip in ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"] {
            assert!(
                !is_forbidden_ip(ip.parse::<IpAddr>().unwrap()),
                "{ip} should be allowed"
            );
        }
    }

    #[test]
    fn removes_cue_out_blocks_and_keeps_map() {
        let base = Url::parse("https://cdn.example.com/hls/index.m3u8").unwrap();
        let mut playlist = String::from(
            "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-MAP:URI=\"init.mp4\"\n",
        );
        for index in 0..5 {
            playlist.push_str(&format!(
                "#EXTINF:10,\nhttps://cdn.example.com/content/{index}.ts\n"
            ));
        }
        playlist.push_str(
            "#EXT-X-CUE-OUT:DURATION=15\n#EXTINF:5,\nhttps://ads.example.com/a1.ts\n#EXTINF:5,\nhttps://ads.example.com/a2.ts\n#EXTINF:5,\nhttps://ads.example.com/a3.ts\n#EXT-X-CUE-IN\n",
        );
        for index in 5..15 {
            playlist.push_str(&format!(
                "#EXTINF:10,\nhttps://cdn.example.com/content/{index}.ts\n"
            ));
        }
        playlist.push_str("#EXT-X-ENDLIST\n");
        let output = filter_ads(&playlist, &base, "test");
        assert!(!output.contains("ads.example.com"));
        assert!(output.contains("content/0.ts"));
        assert!(output.contains("content/5.ts"));
        assert!(output.contains("#EXT-X-MAP"));
        assert!(output.contains("#EXT-X-DISCONTINUITY"));
        assert!(!output.contains("#EXT-X-CUE"));
    }

    #[test]
    fn filters_ad_keywords_with_word_boundaries_and_adjump() {
        let base = Url::parse("https://cdn.example.com/hls/index.m3u8").unwrap();
        let mut playlist = String::from("#EXTM3U\n");
        for index in 0..30 {
            playlist.push_str(&format!(
                "#EXTINF:4,\nhttps://cdn.example.com/content/{index}.ts\n"
            ));
        }
        playlist.push_str("#EXTINF:4,\nhttps://cdn.example.com/ad/0001.ts\n");
        playlist.push_str("#EXTINF:4,\nhttps://cdn.example.com/adventure/0002.ts\n");
        playlist.push_str("#EXTINF:4,\nhttps://cdn.example.com/video/adjump/time/0003.ts\n");
        playlist.push_str("#EXTINF:4,\nhttps://cdn.example.com/guanggao/0004.ts\n");
        for index in 30..40 {
            playlist.push_str(&format!(
                "#EXTINF:4,\nhttps://cdn.example.com/content/{index}.ts\n"
            ));
        }
        let output = filter_ads(&playlist, &base, "test");
        assert!(!output.contains("/ad/0001.ts"));
        assert!(output.contains("adventure/0002.ts"));
        assert!(!output.contains("adjump/time/0003.ts"));
        assert!(!output.contains("guanggao/0004.ts"));
        assert!(output.contains("content/0.ts"));
    }

    #[test]
    fn keeps_leading_short_foreign_host_segments_after_v2() {
        let base = Url::parse("https://cdn.example.com/hls/index.m3u8").unwrap();
        let mut playlist = String::from("#EXTM3U\n");
        for index in 0..3 {
            playlist.push_str(&format!(
                "#EXTINF:1,\nhttps://ads.example.com/pre/{index}.ts\n"
            ));
        }
        for index in 0..10 {
            playlist.push_str(&format!(
                "#EXTINF:10,\nhttps://cdn.example.com/content/{index}.ts\n"
            ));
        }
        let output = filter_ads(&playlist, &base, "test");
        assert_eq!(output.matches("ads.example.com").count(), 3);
        assert!(output.contains("content/0.ts"));
    }

    #[test]
    fn removes_all_occurrences_of_repeated_segments() {
        let base = Url::parse("https://cdn.example.com/hls/index.m3u8").unwrap();
        let mut playlist = String::from("#EXTM3U\n");
        for _ in 0..3 {
            playlist.push_str("#EXTINF:5,\nhttps://cdn.example.com/loop.ts\n");
        }
        for index in 0..10 {
            playlist.push_str(&format!(
                "#EXTINF:10,\nhttps://cdn.example.com/content/{index}.ts\n"
            ));
        }
        let output = filter_ads(&playlist, &base, "test");
        assert_eq!(output.matches("loop.ts").count(), 0);
        assert!(output.contains("content/0.ts"));
    }

    #[test]
    fn removes_ppvod_marker_blocks_with_content_between() {
        let base = Url::parse("https://cdn.example.com/hls/index.m3u8").unwrap();
        let mut playlist = String::from(
            "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:8\n#EXT-X-MEDIA-SEQUENCE:0\n",
        );
        let mut content = 0usize;
        for _ in 0..40 {
            playlist.push_str(&format!(
                "#EXTINF:4,\nhttps://cdn.example/main/{content}.ts\n"
            ));
            content += 1;
        }
        for _ in 0..2 {
            playlist.push_str("# ppvod-ad-injected v1\n#EXT-X-DISCONTINUITY\n");
            for index in 0..7 {
                let duration = if index == 6 { 1.76 } else { 4.0 };
                playlist.push_str(&format!(
                    "#EXTINF:{duration},\nhttps://cdn.example/20261003/84_9109598f/2000k/hls/751808405d700000{index}.ts\n"
                ));
            }
            playlist.push_str("#EXT-X-DISCONTINUITY\n");
            for _ in 0..2 {
                playlist.push_str(&format!(
                    "#EXTINF:4,\nhttps://cdn.example/main/{content}.ts\n"
                ));
                content += 1;
            }
        }
        for _ in 0..20 {
            playlist.push_str(&format!(
                "#EXTINF:4,\nhttps://cdn.example/main/{content}.ts\n"
            ));
            content += 1;
        }
        playlist.push_str("#EXT-X-ENDLIST\n");
        let output = filter_ads(&playlist, &base, "test");
        assert!(!output.contains("ppvod-ad-injected"));
        assert!(!output.contains("20261003/84_9109598f"));
        assert_eq!(output.matches("cdn.example/main/").count(), content);
        assert!(output.contains("#EXT-X-ENDLIST"));
    }

    #[test]
    fn removes_ppvod_movie_three_blocks() {
        let base = Url::parse("https://cdn.example.com/hls/index.m3u8").unwrap();
        let mut playlist = String::from("#EXTM3U\n");
        let mut content = 0usize;
        for _ in 0..40 {
            playlist.push_str(&format!(
                "#EXTINF:4,\nhttps://cdn.example/main/m{content}.ts\n"
            ));
            content += 1;
        }
        for _ in 0..3 {
            playlist.push_str("# ppvod-ad-injected v1\n#EXT-X-DISCONTINUITY\n");
            for index in 0..7 {
                let duration = if index == 6 { 1.76 } else { 4.0 };
                playlist.push_str(&format!(
                    "#EXTINF:{duration},\nhttps://cdn.example/20261003/84_9109598f/2000k/hls/751808405d700000{index}.ts\n"
                ));
            }
            playlist.push_str("#EXT-X-DISCONTINUITY\n");
            for _ in 0..2 {
                playlist.push_str(&format!(
                    "#EXTINF:4,\nhttps://cdn.example/main/m{content}.ts\n"
                ));
                content += 1;
            }
        }
        for _ in 0..20 {
            playlist.push_str(&format!(
                "#EXTINF:4,\nhttps://cdn.example/main/m{content}.ts\n"
            ));
            content += 1;
        }
        playlist.push_str("#EXT-X-ENDLIST\n");
        let output = filter_ads(&playlist, &base, "test");
        assert!(!output.contains("ppvod-ad-injected"));
        assert!(!output.contains("20261003/84_9109598f"));
        assert_eq!(output.matches("cdn.example/main/").count(), content);
    }

    #[test]
    fn removes_adjump_repeated_blocks() {
        let base = Url::parse("https://cdn.example.com/hls/index.m3u8").unwrap();
        let mut playlist = String::from("#EXTM3U\n");
        let mut content = 0usize;
        for _ in 0..40 {
            playlist.push_str(&format!(
                "#EXTINF:4,\nhttps://cdn.example/main/{content}.ts\n"
            ));
            content += 1;
        }
        for _ in 0..3 {
            playlist.push_str("#EXT-X-DISCONTINUITY\n");
            for index in 0..9 {
                let duration = if index == 8 { 1.76 } else { 3.0 };
                playlist.push_str(&format!(
                    "#EXTINF:{duration},\nhttps://cdn.example/video/adjump/time/1793281868388000000{index}.ts\n"
                ));
            }
            playlist.push_str("#EXT-X-DISCONTINUITY\n");
            for _ in 0..2 {
                playlist.push_str(&format!(
                    "#EXTINF:4,\nhttps://cdn.example/main/{content}.ts\n"
                ));
                content += 1;
            }
        }
        for _ in 0..20 {
            playlist.push_str(&format!(
                "#EXTINF:4,\nhttps://cdn.example/main/{content}.ts\n"
            ));
            content += 1;
        }
        playlist.push_str("#EXT-X-ENDLIST\n");
        let output = filter_ads(&playlist, &base, "test");
        assert!(!output.contains("adjump/time"));
        assert_eq!(output.matches("cdn.example/main/").count(), content);
    }

    #[test]
    fn preserves_fmp4_map_byterange_segments() {
        let base = Url::parse("https://cdn.example.com/hls/index.m3u8").unwrap();
        let playlist = "#EXTM3U\n#EXT-X-TARGETDURATION:8\n#EXT-X-VERSION:7\n#EXT-X-MEDIA-SEQUENCE:1\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-MAP:URI=\"main.mp4\",BYTERANGE=\"1206@0\"\n#EXTINF:7.88333,\n#EXT-X-BYTERANGE:2415999@1206\nmain.mp4\n#EXTINF:7.88333,\n#EXT-X-BYTERANGE:2400000@2417205\nmain.mp4\n#EXT-X-ENDLIST\n";
        let output = filter_ads(playlist, &base, "test");
        assert!(output.contains("#EXT-X-MAP"));
        assert!(output.contains("#EXT-X-BYTERANGE"));
        assert_eq!(output.matches("main.mp4").count(), 3);
    }

    #[test]
    fn preserves_aes_key_and_clean_discontinuity() {
        let base = Url::parse("https://cdn.example.com/hls/index.m3u8").unwrap();
        let aes = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-KEY:METHOD=AES-128,URI=\"enc.key\",IV=0x00000000000000000000000000000000\n#EXTINF:2.833333,\nhttps://cdn.example/play/oeErpY0a/plist0.ts\n#EXTINF:3.5,\nhttps://cdn.example/play/oeErpY0a/plist1.ts\n#EXT-X-ENDLIST\n";
        let output = filter_ads(aes, &base, "test");
        assert!(output.contains("#EXT-X-KEY"));
        assert!(output.contains("enc.key"));
        assert!(output.contains("plist0.ts"));

        let clean = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:8\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:4.0,\nhttps://cdn.example/main/0000074.ts\n#EXTINF:4.0,\nhttps://cdn.example/main/0000075.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:4.0,\nhttps://cdn.example/main/0000076.ts\n#EXT-X-ENDLIST\n";
        let output = filter_ads(clean, &base, "test");
        assert_eq!(output.matches("main/").count(), 3);
        assert!(output.contains("#EXT-X-DISCONTINUITY"));
        assert!(output.contains("#EXT-X-ENDLIST"));
    }

    #[test]
    fn keeps_midstream_short_segments() {
        let base = Url::parse("https://cdn.example.com/hls/index.m3u8").unwrap();
        let playlist = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:8\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:4.0,\nhttps://cdn.example/main/0000001.ts\n#EXTINF:0.76,\nhttps://cdn.example/main/0000002.ts\n#EXTINF:0.52,\nhttps://cdn.example/main/0000003.ts\n#EXTINF:0.48,\nhttps://cdn.example/main/0000004.ts\n#EXTINF:4.0,\nhttps://cdn.example/main/0000005.ts\n#EXT-X-ENDLIST\n";
        let output = filter_ads(playlist, &base, "test");
        assert!(output.contains("0000002.ts"));
        assert!(output.contains("0000003.ts"));
        assert!(output.contains("0000004.ts"));
    }

    #[test]
    fn skips_filtering_when_removal_exceeds_safety_ratio() {
        let base = Url::parse("https://cdn.example.com/hls/index.m3u8").unwrap();
        let mut playlist = String::from("#EXTM3U\n#EXT-X-CUE-OUT:30\n");
        for index in 0..2 {
            playlist.push_str(&format!(
                "#EXTINF:10,\nhttps://cdn.example.com/content/{index}.ts\n"
            ));
        }
        for index in 0..3 {
            playlist.push_str(&format!(
                "#EXTINF:10,\nhttps://cdn.example.com/ad/{index}.ts\n"
            ));
        }
        playlist.push_str("#EXT-X-CUE-IN\n");
        for index in 2..4 {
            playlist.push_str(&format!(
                "#EXTINF:10,\nhttps://cdn.example.com/content/{index}.ts\n"
            ));
        }
        let output = filter_ads(&playlist, &base, "test");
        assert!(output.contains("#EXT-X-CUE-OUT"));
        assert!(output.contains("#EXT-X-CUE-IN"));
        assert!(output.contains("/ad/0.ts"));
    }

    #[test]
    fn skips_master_and_llhls_playlists() {
        let base = Url::parse("https://cdn.example.com/hls/master.m3u8").unwrap();
        let master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nad/index.m3u8\n";
        let output = rewrite_playlist(master, &base, "test", "safe");
        assert!(output.contains(&play::proxy_url(
            "test",
            "https://cdn.example.com/hls/ad/index.m3u8"
        )));

        let llhls = "#EXTM3U\n#EXT-X-PART:DURATION=1,URI=\"part1.ts\"\n";
        let output = filter_ads(llhls, &base, "test");
        assert!(output.contains("#EXT-X-PART"));
    }

    #[test]
    fn ad_filter_off_keeps_ad_segments() {
        let base = Url::parse("https://cdn.example.com/hls/index.m3u8").unwrap();
        let playlist = "#EXTM3U\n#EXTINF:10,\nhttps://cdn.example.com/ad/1.ts\n#EXTINF:10,\nhttps://cdn.example.com/content/2.ts\n";
        let output = rewrite_playlist(playlist, &base, "test", "off");
        assert_eq!(output.matches(".ts").count(), 2);
    }

    #[test]
    fn blocks_private_host_names() {
        assert!(is_blocked_host_name("localhost"));
        assert!(is_blocked_host_name("foo.localhost"));
        assert!(is_blocked_host_name("router.local"));
        assert!(is_blocked_host_name("metadata.google.internal"));
        assert!(!is_blocked_host_name("cdn.example.com"));
    }
}
