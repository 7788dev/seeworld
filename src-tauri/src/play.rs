use std::collections::hash_map::RandomState;
use std::collections::{HashMap, HashSet};
use std::hash::{BuildHasher, Hash, Hasher};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures::future::BoxFuture;
use futures::stream::FuturesUnordered;
use futures::StreamExt;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::http::header;
use tauri::{AppHandle, Manager};

const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";
const SEARCH_TIMEOUT: Duration = Duration::from_secs(3);
const DETAIL_TIMEOUT: Duration = Duration::from_secs(10);
/// 搜索命令的总预算：到点先返回已就绪结果，慢源转后台继续，保证 UI 侧 <= 3s。
const SEARCH_TOTAL_BUDGET: Duration = Duration::from_millis(2500);
/// 首个可用结果到达后，再收 250ms 内已就绪的源，避免只拿到单源候选。
const SEARCH_MERGE_WINDOW: Duration = Duration::from_millis(250);
const PROBE_TTL: Duration = Duration::from_secs(600);
// 慢源 TTFB 普遍在 2s 以上,线路总超时必须大于 playlist 采样自身的 5s 预算,
// 否则可播线路会被一律误判为探测失败。
const PROBE_LINE_TIMEOUT: Duration = Duration::from_secs(10);
const PROBE_SEGMENT_BYTES: usize = 128 * 1024;
const SEARCH_TTL: Duration = Duration::from_secs(300);
const DETAIL_TTL: Duration = Duration::from_secs(1800);
const CONFIG_TTL: Duration = Duration::from_secs(30);
const BREAKER_THRESHOLD: u32 = 3;
const BREAKER_COOLDOWN: Duration = Duration::from_secs(60);
const MAX_CACHE_ENTRIES: usize = 256;
const BUNDLED_CONFIG: &str = include_str!("../resources/play-sources.json");

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourceHeaders {
    pub(crate) referer: Option<String>,
    pub(crate) user_agent: Option<String>,
    pub(crate) origin: Option<String>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct AdRules {
    /// 删除 discontinuity 分块中的异常短块(中插广告常见形态)。
    pub(crate) drop_short_blocks: bool,
    pub(crate) short_block_seconds: f64,
    /// 精确广告指纹:连续分片的时长序列(如电影天堂赌场广告 5.567/2.933/5.7/3.333/1.533)。
    /// 指纹命中只删除这些分片,不依赖 discontinuity 切法,不会误删前后正片。
    #[serde(default)]
    pub(crate) ad_duration_fingerprints: Vec<Vec<f64>>,
    #[serde(default = "default_ad_duration_tolerance")]
    pub(crate) ad_duration_tolerance: f64,
    /// 删除只出现一次、且与主体线路不同 host/目录的中插块。
    pub(crate) drop_unique_host_blocks: bool,
    pub(crate) max_ad_block_seconds: f64,
    /// 单次允许删除的时长占比上限,防止误删正片。
    pub(crate) max_drop_ratio: f64,
}

impl Default for AdRules {
    fn default() -> Self {
        Self {
            drop_short_blocks: false,
            short_block_seconds: 8.0,
            ad_duration_fingerprints: Vec::new(),
            ad_duration_tolerance: 0.15,
            drop_unique_host_blocks: false,
            max_ad_block_seconds: 180.0,
            max_drop_ratio: 0.30,
        }
    }
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourceConfig {
    pub(crate) key: String,
    pub(crate) name: String,
    #[serde(rename = "type", default = "default_source_type")]
    pub(crate) source_type: String,
    pub(crate) api: String,
    #[serde(default = "default_true")]
    pub(crate) enabled: bool,
    #[serde(default)]
    pub(crate) priority: i32,
    #[serde(default)]
    pub(crate) headers: SourceHeaders,
    #[serde(default)]
    pub(crate) allow_private_network: bool,
    /// 为 true 时前端跳过直连，直接使用 jjstream 代理（无 CORS/防盗链源）。
    #[serde(default)]
    pub(crate) always_proxy: bool,
    /// safe（默认，代理播放列表广告过滤）/ off。
    #[serde(default = "default_ad_filter")]
    pub(crate) ad_filter: String,
    #[serde(default)]
    pub(crate) ad_rules: AdRules,
    #[serde(default = "default_search_action")]
    pub(crate) search_action: String,
    #[serde(default = "default_detail_action")]
    pub(crate) detail_action: String,
    #[serde(default)]
    pub(crate) search_params: HashMap<String, String>,
    #[serde(default)]
    pub(crate) detail_params: HashMap<String, String>,
}

#[derive(Deserialize, Default)]
struct SourceConfigFile {
    #[serde(default)]
    #[allow(dead_code)]
    version: Option<u32>,
    #[serde(default)]
    replace: bool,
    #[serde(default)]
    sources: Vec<SourceConfig>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PlaySourceInfo {
    pub key: String,
    pub name: String,
    pub priority: i32,
    pub enabled: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PlaySourceError {
    pub source_key: String,
    pub message: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlaySearchItem {
    pub source_key: String,
    pub vod_id: String,
    pub name: String,
    pub pic: String,
    pub year: String,
    pub type_name: String,
    pub remarks: String,
    pub actor: String,
    pub director: String,
    pub area: String,
    pub lang: String,
    pub line_names: Vec<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PlaySearchResponse {
    pub items: Vec<PlaySearchItem>,
    pub errors: Vec<PlaySourceError>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlayEpisode {
    pub index: usize,
    pub name: String,
    pub url: String,
    /// hls / mp4 / unknown。unknown 多为分享页，前端不应默认选它。
    pub format: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlayLine {
    pub index: usize,
    pub name: String,
    /// hls / mp4 / page / unknown。page 为分享页/播放页，前端应禁用。
    pub format: String,
    pub episodes: Vec<PlayEpisode>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PlayDetail {
    pub source_key: String,
    pub vod_id: String,
    pub name: String,
    pub year: String,
    pub type_name: String,
    pub remarks: String,
    pub content: String,
    pub lines: Vec<PlayLine>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PlayTarget {
    pub source_key: String,
    pub vod_id: String,
    pub line_index: usize,
    pub episode_index: usize,
    pub url: String,
    pub proxy_url: String,
    pub format: String,
    /// 源配置 alwaysProxy=true 时为 true，前端应优先使用 proxyUrl。
    pub use_proxy: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlayProbeLine {
    pub line_index: usize,
    pub name: String,
    pub format: String,
    pub ok: bool,
    pub error: Option<String>,
    pub ttfb_ms: u64,
    pub speed_kbps: u64,
    pub width: u32,
    pub height: u32,
    pub bandwidth_kbps: u64,
    /// 首集 media playlist 的段数/总时长/ENDLIST；用于前端检测截断/占位流。
    pub segment_count: usize,
    pub duration_sec: f64,
    pub endlist: bool,
    pub sample_count: usize,
    pub failure_count: usize,
    pub jitter_ms: f64,
    pub stability_score: f64,
    pub score: f64,
    pub recommended: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlayProbeResult {
    pub source_key: String,
    pub vod_id: String,
    pub lines: Vec<PlayProbeLine>,
    pub recommended_line_index: Option<usize>,
    pub cached: bool,
    pub probed_at_ms: u64,
}

type SearchFuture =
    BoxFuture<'static, (String, Result<Vec<PlaySearchItem>, String>)>;

#[derive(Deserialize, Default)]
struct RawVod {
    #[serde(default, deserialize_with = "flexible_string")]
    vod_id: String,
    #[serde(default, deserialize_with = "flexible_string")]
    vod_name: String,
    #[serde(default, deserialize_with = "flexible_string")]
    vod_pic: String,
    #[serde(default, deserialize_with = "flexible_string")]
    vod_year: String,
    #[serde(default, deserialize_with = "flexible_string")]
    type_name: String,
    #[serde(default, deserialize_with = "flexible_string")]
    vod_remarks: String,
    #[serde(default, deserialize_with = "flexible_string")]
    vod_actor: String,
    #[serde(default, deserialize_with = "flexible_string")]
    vod_director: String,
    #[serde(default, deserialize_with = "flexible_string")]
    vod_area: String,
    #[serde(default, deserialize_with = "flexible_string")]
    vod_lang: String,
    #[serde(default, deserialize_with = "flexible_string")]
    vod_play_from: String,
    #[serde(default, deserialize_with = "flexible_string")]
    vod_play_url: String,
    #[serde(default, deserialize_with = "flexible_string")]
    vod_content: String,
}

fn flexible_string<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value: Option<Value> = Option::deserialize(deserializer)?;
    Ok(match value {
        Some(Value::String(s)) => s,
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        _ => String::new(),
    })
}

fn default_source_type() -> String {
    "cms".to_string()
}

fn default_search_action() -> String {
    "videolist".to_string()
}

fn default_detail_action() -> String {
    "videolist".to_string()
}

fn default_ad_filter() -> String {
    "safe".to_string()
}

fn default_ad_duration_tolerance() -> f64 {
    0.15
}

fn default_true() -> bool {
    true
}

struct CacheEntry {
    expires: Instant,
    body: String,
}

fn cache() -> &'static Mutex<HashMap<String, CacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn cache_get(key: &str) -> Option<String> {
    let mut guard = cache().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    match guard.get(key) {
        Some(entry) if entry.expires > Instant::now() => Some(entry.body.clone()),
        Some(_) => {
            guard.remove(key);
            None
        }
        None => None,
    }
}

fn cache_put(key: String, body: String, ttl: Duration) {
    let mut guard = cache().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if guard.len() >= MAX_CACHE_ENTRIES {
        let now = Instant::now();
        guard.retain(|_, entry| entry.expires > now);
        while guard.len() >= MAX_CACHE_ENTRIES {
            let Some(oldest) = guard
                .iter()
                .min_by_key(|(_, entry)| entry.expires)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            guard.remove(&oldest);
        }
    }
    guard.insert(
        key,
        CacheEntry {
            expires: Instant::now() + ttl,
            body,
        },
    );
}

struct BreakerState {
    failures: u32,
    open_until: Option<Instant>,
}

fn breakers() -> &'static Mutex<HashMap<String, BreakerState>> {
    static BREAKERS: OnceLock<Mutex<HashMap<String, BreakerState>>> = OnceLock::new();
    BREAKERS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn breaker_check(key: &str) -> Result<(), String> {
    let mut guard = breakers().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(state) = guard.get_mut(key) else {
        return Ok(());
    };
    if let Some(until) = state.open_until {
        if until > Instant::now() {
            let remaining = until.duration_since(Instant::now()).as_secs() + 1;
            return Err(format!("源 {key} 暂时不可用，约 {remaining}s 后重试"));
        }
        state.open_until = None;
        state.failures = 0;
    }
    Ok(())
}

fn breaker_success(key: &str) {
    if let Ok(mut guard) = breakers().lock() {
        guard.remove(key);
    }
}

fn breaker_failure(key: &str) {
    let mut guard = breakers().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let state = guard.entry(key.to_string()).or_insert(BreakerState {
        failures: 0,
        open_until: None,
    });
    state.failures += 1;
    if state.failures >= BREAKER_THRESHOLD {
        state.failures = 0;
        state.open_until = Some(Instant::now() + BREAKER_COOLDOWN);
        eprintln!(
            "[play] source {key} circuit opened for {}s",
            BREAKER_COOLDOWN.as_secs()
        );
    }
}

struct ProbeCacheEntry {
    expires: Instant,
    result: PlayProbeResult,
}

fn probe_cache() -> &'static Mutex<HashMap<String, ProbeCacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, ProbeCacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn probe_cache_get(key: &str) -> Option<PlayProbeResult> {
    let mut guard = probe_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match guard.get(key) {
        Some(entry) if entry.expires > Instant::now() => Some(entry.result.clone()),
        Some(_) => {
            guard.remove(key);
            None
        }
        None => None,
    }
}

fn probe_cache_put(key: String, result: PlayProbeResult) {
    let mut guard = probe_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if guard.len() >= 128 {
        let now = Instant::now();
        guard.retain(|_, entry| entry.expires > now);
        while guard.len() >= 128 {
            let Some(oldest) = guard
                .iter()
                .min_by_key(|(_, entry)| entry.expires)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            guard.remove(&oldest);
        }
    }
    guard.insert(
        key,
        ProbeCacheEntry {
            expires: Instant::now() + PROBE_TTL,
            result,
        },
    );
}

struct ConfigCache {
    loaded_at: Instant,
    sources: Vec<SourceConfig>,
}

fn config_cache() -> &'static Mutex<Option<ConfigCache>> {
    static CONFIG: OnceLock<Mutex<Option<ConfigCache>>> = OnceLock::new();
    CONFIG.get_or_init(|| Mutex::new(None))
}

fn load_config(app: &AppHandle) -> Vec<SourceConfig> {
    let mut guard = config_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(entry) = guard.as_ref() {
        if entry.loaded_at.elapsed() < CONFIG_TTL {
            return entry.sources.clone();
        }
    }
    let sources = read_config(app);
    *guard = Some(ConfigCache {
        loaded_at: Instant::now(),
        sources: sources.clone(),
    });
    sources
}

fn read_config(app: &AppHandle) -> Vec<SourceConfig> {
    let mut sources = parse_config(BUNDLED_CONFIG, "bundled");
    if let Ok(dir) = app.path().app_config_dir() {
        let path = dir.join("play-sources.json");
        if path.is_file() {
            match std::fs::read_to_string(&path) {
                Ok(text) => match serde_json::from_str::<SourceConfigFile>(&text) {
                    Ok(file) => {
                        let user: Vec<SourceConfig> = file
                            .sources
                            .into_iter()
                            .filter_map(validate_source)
                            .collect();
                        if file.replace {
                            eprintln!(
                                "[play] user source config replaces bundled ({} sources)",
                                user.len()
                            );
                            sources = user;
                        } else {
                            sources = merge_sources(sources, user);
                        }
                    }
                    Err(error) => eprintln!("[play] user source config parse failed: {error}"),
                },
                Err(error) => eprintln!("[play] user source config read failed: {error}"),
            }
        }
    }
    sources.sort_by(|a, b| {
        b.priority
            .cmp(&a.priority)
            .then_with(|| a.key.cmp(&b.key))
    });
    sources
}

fn parse_config(text: &str, label: &str) -> Vec<SourceConfig> {
    match serde_json::from_str::<SourceConfigFile>(text) {
        Ok(file) => file
            .sources
            .into_iter()
            .filter_map(validate_source)
            .collect(),
        Err(error) => {
            eprintln!("[play] {label} source config parse failed: {error}");
            Vec::new()
        }
    }
}

fn merge_sources(bundled: Vec<SourceConfig>, user: Vec<SourceConfig>) -> Vec<SourceConfig> {
    let mut merged: HashMap<String, SourceConfig> = bundled
        .into_iter()
        .map(|source| (source.key.clone(), source))
        .collect();
    for source in user {
        merged.insert(source.key.clone(), source);
    }
    merged.into_values().collect()
}

fn validate_source(mut source: SourceConfig) -> Option<SourceConfig> {
    source.key = source.key.trim().to_ascii_lowercase();
    if source.key.is_empty()
        || !source
            .key
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        eprintln!("[play] skip source with invalid key: {:?}", source.key);
        return None;
    }
    if source.source_type.trim().is_empty() {
        source.source_type = default_source_type();
    }
    if !source.source_type.eq_ignore_ascii_case("cms") {
        eprintln!(
            "[play] skip unsupported source type {:?} ({})",
            source.source_type, source.key
        );
        return None;
    }
    let name = source.name.trim();
    source.name = if name.is_empty() {
        source.key.clone()
    } else {
        name.to_string()
    };
    match Url::parse(source.api.trim()) {
        Ok(url) if matches!(url.scheme(), "http" | "https") => {
            source.api = source.api.trim().to_string();
        }
        _ => {
            eprintln!("[play] skip source with invalid api: {}", source.key);
            return None;
        }
    }
    if source.search_action.trim().is_empty() {
        source.search_action = default_search_action();
    } else {
        source.search_action = source.search_action.trim().to_string();
    }
    if source.detail_action.trim().is_empty() {
        source.detail_action = default_detail_action();
    } else {
        source.detail_action = source.detail_action.trim().to_string();
    }
    source.ad_filter = source.ad_filter.trim().to_ascii_lowercase();
    if !matches!(source.ad_filter.as_str(), "safe" | "off") {
        eprintln!(
            "[play] source {} has invalid adFilter {:?}, fallback to safe",
            source.key, source.ad_filter
        );
        source.ad_filter = default_ad_filter();
    }
    Some(source)
}

pub(crate) fn api_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .use_native_tls()
            .user_agent(USER_AGENT)
            .connect_timeout(Duration::from_secs(5))
            .gzip(true)
            .cookie_store(true)
            .dns_resolver(std::sync::Arc::new(crate::play_proxy::PublicDnsResolver))
            .build()
            .expect("failed to build play http client")
    })
}

/// 用户显式允许私网后，才使用不做私网拦截的 client（例如局域网 IPTV 源）。
fn private_api_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .use_native_tls()
            .user_agent(USER_AGENT)
            .connect_timeout(Duration::from_secs(5))
            .gzip(true)
            .cookie_store(true)
            .build()
            .expect("failed to build private play http client")
    })
}

pub(crate) fn client_for(source: &SourceConfig) -> &'static reqwest::Client {
    if source.allow_private_network {
        private_api_client()
    } else {
        api_client()
    }
}

fn apply_source_headers(
    builder: reqwest::RequestBuilder,
    source: &SourceConfig,
) -> reqwest::RequestBuilder {
    let mut builder = builder.header(header::ACCEPT, "application/json, text/plain, */*");
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
        .or_else(|| {
            Url::parse(&source.api)
                .ok()
                .and_then(|url| default_origin(&url))
        });
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

fn build_api_url(
    source: &SourceConfig,
    action: &str,
    key: &str,
    value: &str,
    extra: &HashMap<String, String>,
) -> Result<Url, String> {
    build_api_url_page(source, action, key, value, extra, 1)
}

fn build_api_url_page(
    source: &SourceConfig,
    action: &str,
    key: &str,
    value: &str,
    extra: &HashMap<String, String>,
    page: u32,
) -> Result<Url, String> {
    let mut url = Url::parse(source.api.trim()).map_err(|error| format!("源 API 地址无效：{error}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("源 API 仅支持 http/https".to_string());
    }
    {
        let mut pairs = url.query_pairs_mut();
        pairs.append_pair("ac", action);
        pairs.append_pair(key, value);
        if key == "wd" {
            pairs.append_pair("pg", &page.to_string());
        }
        for (extra_key, extra_value) in extra {
            pairs.append_pair(extra_key, extra_value);
        }
    }
    Ok(url)
}

fn extract_list(value: &Value) -> Vec<&Value> {
    if let Some(list) = value.get("list").and_then(Value::as_array) {
        return list.iter().collect();
    }
    if let Some(array) = value.as_array() {
        return array.iter().collect();
    }
    if value.get("vod_id").is_some() || value.get("vod_name").is_some() {
        return vec![value];
    }
    Vec::new()
}

fn item_vod_id(item: &Value) -> Option<String> {
    item.get("vod_id").and_then(|value| match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    })
}

fn split_line_names(raw: &str) -> Vec<String> {
    raw.split("$$$")
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(str::to_string)
        .collect()
}

fn split_multi(raw: &str) -> Vec<String> {
    raw.split("$$$")
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(str::to_string)
        .collect()
}

fn parse_search_items(
    value: &Value,
    source: &SourceConfig,
) -> Result<Vec<PlaySearchItem>, String> {
    let list = extract_list(value);
    if list.is_empty() {
        let code = value.get("code").and_then(Value::as_i64).unwrap_or(1);
        let message = value.get("msg").and_then(Value::as_str).unwrap_or("");
        if code != 1 && !message.is_empty() {
            return Err(format!("源返回错误：{message}"));
        }
        return Ok(Vec::new());
    }
    let mut items = Vec::new();
    for item in list {
        match serde_json::from_value::<RawVod>(item.clone()) {
            Ok(raw) => {
                if raw.vod_id.is_empty() || raw.vod_name.is_empty() {
                    continue;
                }
                items.push(PlaySearchItem {
                    source_key: source.key.clone(),
                    vod_id: raw.vod_id,
                    name: raw.vod_name,
                    pic: raw.vod_pic,
                    year: raw.vod_year,
                    type_name: raw.type_name,
                    remarks: raw.vod_remarks,
                    actor: raw.vod_actor,
                    director: raw.vod_director,
                    area: raw.vod_area,
                    lang: raw.vod_lang,
                    line_names: split_line_names(&raw.vod_play_from),
                });
            }
            Err(error) => eprintln!(
                "[play] skip malformed search result from {}: {error}",
                source.key
            ),
        }
    }
    Ok(items)
}

fn parse_detail_value(
    value: &Value,
    source: &SourceConfig,
    vod_id: &str,
) -> Result<PlayDetail, String> {
    let list = extract_list(value);
    if list.is_empty() {
        let message = value
            .get("msg")
            .and_then(Value::as_str)
            .unwrap_or("响应中没有 list");
        return Err(format!("详情为空：{message}"));
    }
    let chosen = list
        .iter()
        .find(|item| item_vod_id(item).as_deref() == Some(vod_id))
        .copied()
        .unwrap_or(list[0]);
    let raw: RawVod =
        serde_json::from_value(chosen.clone()).map_err(|error| format!("详情字段解析失败：{error}"))?;
    if raw.vod_id.is_empty() && raw.vod_name.is_empty() {
        return Err("详情缺少 vod_id/vod_name".to_string());
    }
    let lines = parse_play_lines(&raw.vod_play_from, &raw.vod_play_url);
    if lines.is_empty() {
        return Err("该源未返回可播放线路（可能只有页面地址）".to_string());
    }
    Ok(PlayDetail {
        source_key: source.key.clone(),
        vod_id: if raw.vod_id.is_empty() {
            vod_id.to_string()
        } else {
            raw.vod_id
        },
        name: raw.vod_name,
        year: raw.vod_year,
        type_name: raw.type_name,
        remarks: raw.vod_remarks,
        content: raw.vod_content,
        lines,
    })
}

fn parse_play_lines(from_raw: &str, url_raw: &str) -> Vec<PlayLine> {
    let froms = split_multi(from_raw);
    let urls = split_multi(url_raw);
    let total = froms.len().max(urls.len());
    let mut lines = Vec::new();
    for index in 0..total {
        let name = froms
            .get(index)
            .filter(|name| !name.is_empty())
            .cloned()
            .unwrap_or_else(|| format!("线路{}", index + 1));
        // 云播线路(标记名含 "yun",如 jinyingyun)是网页跳转封装,不可直接播放,
        // 只会以"暂不支持"干扰线路选择,在解析层直接丢弃。
        if name.to_ascii_lowercase().contains("yun") {
            continue;
        }
        let episodes = urls
            .get(index)
            .map(|blob| parse_episodes(blob))
            .unwrap_or_default();
        if episodes.is_empty() {
            continue;
        }
        let format = summarize_line_format(&episodes);
        // 网页跳转线路(标记如 dytt/feifan/liangzi,分集是 share/php 页面)不可直接播放,
        // 与云播一样只会以"暂不支持"干扰线路面板,解析层直接丢弃,只保留 m3u8/mp4 系列。
        if format == "page" {
            continue;
        }
        lines.push(PlayLine {
            index: lines.len(),
            name,
            format,
            episodes,
        });
    }
    // 可播线路优先返回给前端；稳定排序保留同格式线路的原始顺序，并重排 index。
    lines.sort_by_key(|line| match line.format.as_str() {
        "hls" | "mp4" => 0,
        "page" => 1,
        _ => 2,
    });
    for (index, line) in lines.iter_mut().enumerate() {
        line.index = index;
    }
    lines
}

fn summarize_line_format(episodes: &[PlayEpisode]) -> String {
    if episodes.iter().any(|episode| episode.format == "hls") {
        return "hls".to_string();
    }
    if episodes.iter().any(|episode| episode.format == "mp4") {
        return "mp4".to_string();
    }
    if episodes.iter().any(|episode| episode.format == "page") {
        return "page".to_string();
    }
    "unknown".to_string()
}

fn is_playable_line(line: &PlayLine) -> bool {
    matches!(line.format.as_str(), "hls" | "mp4")
}

/// None 表示自动选择第一条 hls/mp4 线路；显式选择 page/unknown 线路会返回可读错误。
fn choose_line(
    lines: &[PlayLine],
    line_index: Option<usize>,
) -> Result<&PlayLine, String> {
    if let Some(index) = line_index {
        let line = lines
            .get(index)
            .ok_or_else(|| format!("线路索引超出范围（共 {} 条）", lines.len()))?;
        if !is_playable_line(line) {
            return Err(match line.format.as_str() {
                "page" => format!("线路「{}」是网页地址，暂不支持播放", line.name),
                _ => format!("线路「{}」的播放格式暂不支持（仅支持 HLS/MP4）", line.name),
            });
        }
        return Ok(line);
    }
    lines
        .iter()
        .find(|line| is_playable_line(line))
        .ok_or_else(|| "该片没有可播放的 HLS/MP4 线路".to_string())
}

fn parse_episodes(raw: &str) -> Vec<PlayEpisode> {
    let mut episodes = Vec::new();
    for chunk in raw.split('#') {
        let entry = chunk.trim();
        if entry.is_empty() {
            continue;
        }
        let (name, raw_url) = split_episode_entry(entry);
        let Some(url) = normalize_play_url(&raw_url) else {
            continue;
        };
        let name = if name.is_empty() {
            format!("第{}集", episodes.len() + 1)
        } else {
            name
        };
        let format = detect_format(&url).to_string();
        episodes.push(PlayEpisode {
            index: episodes.len(),
            name,
            url,
            format,
        });
    }
    episodes
}

fn split_episode_entry(entry: &str) -> (String, String) {
    if let Some((left, right)) = entry.split_once('$') {
        let left = left.trim();
        let right = right.trim();
        if !right.is_empty() && !left.contains("://") {
            return (left.to_string(), right.to_string());
        }
    }
    (String::new(), entry.trim().to_string())
}

fn normalize_play_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let unescaped = trimmed.replace("&amp;", "&");
    let candidate = if let Some(rest) = unescaped.strip_prefix("//") {
        format!("https://{rest}")
    } else {
        unescaped
    };
    let lower = candidate.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return None;
    }
    if candidate.len() > 8192 {
        return None;
    }
    Some(candidate)
}

pub(crate) fn detect_format(raw: &str) -> &'static str {
    let lower = raw.to_ascii_lowercase();
    let path = lower
        .split(['?', '#'])
        .next()
        .unwrap_or(&lower);
    if path.contains(".m3u8") {
        return "hls";
    }
    if path.contains(".mp4") {
        return "mp4";
    }
    if path.ends_with(".html")
        || path.ends_with(".htm")
        || path.ends_with(".shtml")
        || path.contains("/share/")
        || path.contains("/play/")
        || path.contains("/vod/")
    {
        return "page";
    }
    // 少数直链把格式放在 query 里，例如 ?format=m3u8
    if lower.contains("m3u8") {
        return "hls";
    }
    if lower.contains("mp4") {
        return "mp4";
    }
    "unknown"
}

/// 每次启动随机生成的代理口令:jjstream 请求必须携带,防止本机任意进程借道代理。
pub(crate) fn proxy_token() -> &'static str {
    static TOKEN: OnceLock<String> = OnceLock::new();
    TOKEN.get_or_init(|| {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos() as u64)
            .unwrap_or(0);
        let pid = std::process::id();
        let mut token = String::with_capacity(32);
        for round in 0..4u64 {
            // RandomState 由操作系统随机种子初始化，比时间+PID 的线性同余更不可预测。
            let mut hasher = RandomState::new().build_hasher();
            nanos.hash(&mut hasher);
            pid.hash(&mut hasher);
            round.hash(&mut hasher);
            token.push_str(&format!("{:08x}", hasher.finish() as u32));
        }
        token
    })
}

pub(crate) fn proxy_url(source_key: &str, raw_url: &str) -> String {
    format!(
        "http://jjstream.localhost/{}/{}?k={}",
        source_key,
        urlencoding::encode(raw_url),
        proxy_token()
    )
}

pub(crate) fn default_origin(url: &Url) -> Option<String> {
    let origin = url.origin();
    let serialized = origin.ascii_serialization();
    if serialized.is_empty() || serialized == "null" {
        None
    } else {
        Some(format!("{serialized}/"))
    }
}

pub(crate) fn safe_url(url: &Url) -> String {
    let mut clone = url.clone();
    clone.set_query(None);
    clone.set_fragment(None);
    clone.to_string()
}

fn apply_media_headers(
    builder: reqwest::RequestBuilder,
    source: &SourceConfig,
    url: &Url,
) -> reqwest::RequestBuilder {
    let mut builder = builder.header(header::ACCEPT, "*/*");
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
        .or_else(|| default_origin(url));
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

async fn fetch_playlist(source: &SourceConfig, url: &Url) -> Result<(String, Url, u64), String> {
    let started = Instant::now();
    let response = apply_media_headers(client_for(source).get(url.clone()), source, url)
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map_err(|error| format!("播放列表请求失败：{}", error.without_url()))?;
    let ttfb_ms = started.elapsed().as_millis() as u64;
    if !response.status().is_success() {
        return Err(format!("播放列表 HTTP {}", response.status().as_u16()));
    }
    let final_url = response.url().clone();
    let text = response
        .text()
        .await
        .map_err(|error| format!("播放列表读取失败：{}", error.without_url()))?;
    let text = text.trim_start_matches('\u{feff}').to_string();
    if !text.trim_start().starts_with("#EXTM3U") {
        return Err("首集不是 m3u8（可能是网页）".to_string());
    }
    Ok((text, final_url, ttfb_ms))
}

async fn measure_segment(source: &SourceConfig, url: &Url) -> Result<(u64, u64), String> {
    let started = Instant::now();
    let mut response = apply_media_headers(client_for(source).get(url.clone()), source, url)
        .header(
            header::RANGE,
            format!("bytes=0-{}", PROBE_SEGMENT_BYTES - 1),
        )
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map_err(|error| format!("分片请求失败：{}", error.without_url()))?;
    let ttfb_ms = started.elapsed().as_millis() as u64;
    let status = response.status().as_u16();
    if status != 200 && status != 206 {
        return Err(format!("分片 HTTP {status}"));
    }
    let mut bytes = 0usize;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("分片读取失败：{}", error.without_url()))?
    {
        bytes += chunk.len();
        if bytes >= PROBE_SEGMENT_BYTES {
            break;
        }
    }
    if bytes == 0 {
        return Err("分片为空".to_string());
    }
    let elapsed = started.elapsed().as_secs_f64();
    let speed_kbps = if elapsed > 0.0 {
        (((bytes as f64) * 8.0 / elapsed) / 1000.0).round() as u64
    } else {
        0
    };
    Ok((ttfb_ms, speed_kbps))
}

#[derive(Debug)]
struct MasterVariant {
    url: Url,
    width: u32,
    height: u32,
    bandwidth_kbps: u64,
}

fn attr_value<'a>(attrs: &'a str, name: &str) -> Option<&'a str> {
    attrs.split(',').find_map(|part| {
        let (key, value) = part.split_once('=')?;
        if key.trim().eq_ignore_ascii_case(name) {
            Some(value.trim().trim_matches('"'))
        } else {
            None
        }
    })
}

fn parse_resolution(value: &str) -> Option<(u32, u32)> {
    let (width, height) = value.split_once('x')?;
    Some((width.trim().parse().ok()?, height.trim().parse().ok()?))
}

fn parse_master_playlist(text: &str, base: &Url) -> Option<MasterVariant> {
    let mut pending: Option<(u32, u32, u64)> = None;
    let mut best: Option<MasterVariant> = None;
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(attrs) = line.strip_prefix("#EXT-X-STREAM-INF:") {
            let bandwidth_kbps = attr_value(attrs, "BANDWIDTH")
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(0)
                / 1000;
            let (width, height) = attr_value(attrs, "RESOLUTION")
                .and_then(parse_resolution)
                .unwrap_or((0, 0));
            pending = Some((width, height, bandwidth_kbps));
            continue;
        }
        if line.starts_with('#') {
            continue;
        }
        let Some((width, height, bandwidth_kbps)) = pending.take() else {
            continue;
        };
        let Ok(url) = base.join(line) else {
            continue;
        };
        if !matches!(url.scheme(), "http" | "https") {
            continue;
        }
        let candidate = MasterVariant {
            url,
            width,
            height,
            bandwidth_kbps,
        };
        let better = best.as_ref().is_none_or(|current| {
            (candidate.height, candidate.bandwidth_kbps)
                > (current.height, current.bandwidth_kbps)
        });
        if better {
            best = Some(candidate);
        }
    }
    best
}

fn segment_urls(text: &str, base: &Url) -> Vec<Url> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .filter_map(|line| {
            base.join(line)
                .ok()
                .filter(|url| matches!(url.scheme(), "http" | "https"))
        })
        .collect()
}

struct ProbeMetrics {
    ttfb_ms: u64,
    speed_kbps: u64,
    width: u32,
    height: u32,
    bandwidth_kbps: u64,
    segment_count: usize,
    duration_sec: f64,
    endlist: bool,
    sample_count: usize,
    failure_count: usize,
    jitter_ms: f64,
    stability_score: f64,
}

fn parse_extinf_duration(line: &str) -> Option<f64> {
    let rest = line.strip_prefix("#EXTINF:")?;
    rest.split(',').next()?.trim().parse::<f64>().ok()
}

fn playlist_stats(text: &str) -> (usize, f64, bool) {
    let mut segment_count = 0usize;
    let mut duration_sec = 0.0f64;
    let mut endlist = false;
    for raw in text.lines() {
        let line = raw.trim();
        if line == "#EXT-X-ENDLIST" {
            endlist = true;
        } else if let Some(duration) = parse_extinf_duration(line) {
            duration_sec += duration;
        } else if !line.is_empty() && !line.starts_with('#') {
            segment_count += 1;
        }
    }
    (segment_count, duration_sec, endlist)
}

fn mean(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.iter().sum::<f64>() / values.len() as f64
}

fn stddev(values: &[f64]) -> f64 {
    if values.len() < 2 {
        return 0.0;
    }
    let average = mean(values);
    (values
        .iter()
        .map(|value| (value - average).powi(2))
        .sum::<f64>()
        / values.len() as f64)
        .sqrt()
}

fn compute_speed_score(ttfb_ms: u64, speed_kbps: u64) -> f64 {
    let ttfb_score = (100.0 - ttfb_ms as f64 / 20.0).clamp(0.0, 100.0);
    let throughput_score = (speed_kbps as f64 / 8000.0 * 100.0).clamp(0.0, 100.0);
    ttfb_score * 0.4 + throughput_score * 0.6
}

fn compute_quality_score(height: u32, bandwidth_kbps: u64) -> f64 {
    let resolution_score = if height > 0 {
        (height as f64 / 2160.0 * 100.0).clamp(0.0, 100.0)
    } else {
        0.0
    };
    let bandwidth_score = if bandwidth_kbps > 0 {
        (bandwidth_kbps as f64 / 8000.0 * 100.0).clamp(0.0, 100.0)
    } else {
        0.0
    };
    if height > 0 && bandwidth_kbps > 0 {
        resolution_score * 0.7 + bandwidth_score * 0.3
    } else if height > 0 {
        resolution_score
    } else {
        bandwidth_score
    }
}

fn compute_stability_score(
    successes: usize,
    failures: usize,
    jitter_ms: f64,
    speeds: &[f64],
) -> f64 {
    let total = successes + failures;
    if total == 0 {
        return 0.0;
    }
    let failure_score = successes as f64 / total as f64 * 100.0;
    let jitter_score = (100.0 - jitter_ms / 10.0).clamp(0.0, 100.0);
    let consistency = if speeds.len() >= 2 {
        let average = mean(speeds);
        if average > 0.0 {
            (100.0 - stddev(speeds) / average * 100.0).clamp(0.0, 100.0)
        } else {
            0.0
        }
    } else {
        100.0
    };
    ((failure_score * 0.4 + jitter_score * 0.3 + consistency * 0.3) * 10.0).round() / 10.0
}

fn compute_probe_score(
    ttfb_ms: u64,
    speed_kbps: u64,
    height: u32,
    bandwidth_kbps: u64,
    stability_score: f64,
) -> f64 {
    let speed = compute_speed_score(ttfb_ms, speed_kbps);
    let quality = compute_quality_score(height, bandwidth_kbps);
    // 速度主导:带宽不足是卡顿根因;稳定性保底避免选到抖动线;质量仅作保底项。
    ((speed * 0.7 + quality * 0.1 + stability_score * 0.2) * 10.0).round() / 10.0
}

fn mark_recommended(lines: &mut [PlayProbeLine]) -> Option<usize> {
    let best = lines
        .iter()
        .enumerate()
        .filter(|(_, line)| line.ok)
        .max_by(|(_, left), (_, right)| {
            left.score
                .total_cmp(&right.score)
                .then_with(|| left.stability_score.total_cmp(&right.stability_score))
                .then_with(|| left.height.cmp(&right.height))
                .then_with(|| left.speed_kbps.cmp(&right.speed_kbps))
        })
        .map(|(index, _)| index);
    if let Some(index) = best {
        lines[index].recommended = true;
        Some(lines[index].line_index)
    } else {
        None
    }
}

async fn probe_line_inner(source: &SourceConfig, line: &PlayLine) -> Result<ProbeMetrics, String> {
    let episode = line
        .episodes
        .iter()
        .find(|episode| matches!(episode.format.as_str(), "hls" | "mp4"))
        .ok_or_else(|| "线路没有可探测分集".to_string())?;
    let first = Url::parse(&episode.url).map_err(|error| format!("分集地址无效：{error}"))?;
    if episode.format == "mp4" {
        let (ttfb_ms, speed_kbps) = measure_segment(source, &first).await?;
        let speeds = vec![speed_kbps as f64];
        return Ok(ProbeMetrics {
            ttfb_ms,
            speed_kbps,
            width: 0,
            height: 0,
            bandwidth_kbps: 0,
            segment_count: 0,
            duration_sec: 0.0,
            endlist: false,
            sample_count: 1,
            failure_count: 0,
            jitter_ms: 0.0,
            stability_score: compute_stability_score(1, 0, 0.0, &speeds),
        });
    }
    let (text, final_url, ttfb_ms) = fetch_playlist(source, &first).await?;
    let is_master = text
        .lines()
        .any(|line| line.trim_start().starts_with("#EXT-X-STREAM-INF"));
    let (media_text, media_url, width, height, bandwidth_kbps) = if is_master {
        let master = parse_master_playlist(&text, &final_url)
            .ok_or_else(|| "master 播放列表没有可用变体".to_string())?;
        let (variant_text, variant_url, _) = fetch_playlist(source, &master.url).await?;
        (
            variant_text,
            variant_url,
            master.width,
            master.height,
            master.bandwidth_kbps,
        )
    } else {
        (text, final_url, 0, 0, 0)
    };
    let (segment_count, duration_sec, endlist) = playlist_stats(&media_text);
    let urls = segment_urls(&media_text, &media_url);
    if urls.is_empty() {
        return Err("播放列表里没有分片".to_string());
    }
    // 3 个分片采样：首/中/尾（不足 3 段则全测），每个只取 128KB。
    let sample_indices: Vec<usize> = if urls.len() <= 3 {
        (0..urls.len()).collect()
    } else {
        vec![0, urls.len() / 2, urls.len() - 1]
    };
    let sample_urls: Vec<Url> = sample_indices.iter().map(|&index| urls[index].clone()).collect();
    let results = futures::future::join_all(
        sample_urls
            .iter()
            .map(|url| measure_segment(source, url)),
    )
    .await;
    let mut ttfb_samples = Vec::new();
    let mut speeds = Vec::new();
    let mut failures = 0usize;
    for result in results {
        match result {
            Ok((sample_ttfb, sample_speed)) => {
                ttfb_samples.push(sample_ttfb as f64);
                speeds.push(sample_speed as f64);
            }
            Err(_) => failures += 1,
        }
    }
    if speeds.is_empty() {
        return Err(format!("{failures} 个分片采样全部失败"));
    }
    let speed_kbps = mean(&speeds).round() as u64;
    let jitter_ms = stddev(&ttfb_samples);
    let stability_score =
        compute_stability_score(speeds.len(), failures, jitter_ms, &speeds);
    Ok(ProbeMetrics {
        ttfb_ms,
        speed_kbps,
        width,
        height,
        bandwidth_kbps,
        segment_count,
        duration_sec,
        endlist,
        sample_count: speeds.len(),
        failure_count: failures,
        jitter_ms,
        stability_score,
    })
}

async fn probe_line(source: &SourceConfig, line: &PlayLine) -> PlayProbeLine {
    let base = PlayProbeLine {
        line_index: line.index,
        name: line.name.clone(),
        format: line.format.clone(),
        ok: false,
        error: None,
        ttfb_ms: 0,
        speed_kbps: 0,
        width: 0,
        height: 0,
        bandwidth_kbps: 0,
        segment_count: 0,
        duration_sec: 0.0,
        endlist: false,
        sample_count: 0,
        failure_count: 0,
        jitter_ms: 0.0,
        stability_score: 0.0,
        score: 0.0,
        recommended: false,
    };
    match tokio::time::timeout(PROBE_LINE_TIMEOUT, probe_line_inner(source, line)).await {
        Ok(Ok(metrics)) => {
            let score = compute_probe_score(
                metrics.ttfb_ms,
                metrics.speed_kbps,
                metrics.height,
                metrics.bandwidth_kbps,
                metrics.stability_score,
            );
            PlayProbeLine {
                ok: true,
                ttfb_ms: metrics.ttfb_ms,
                speed_kbps: metrics.speed_kbps,
                width: metrics.width,
                height: metrics.height,
                bandwidth_kbps: metrics.bandwidth_kbps,
                segment_count: metrics.segment_count,
                duration_sec: metrics.duration_sec,
                endlist: metrics.endlist,
                sample_count: metrics.sample_count,
                failure_count: metrics.failure_count,
                jitter_ms: metrics.jitter_ms,
                stability_score: metrics.stability_score,
                score,
                ..base
            }
        }
        Ok(Err(error)) => PlayProbeLine {
            error: Some(error),
            ..base
        },
        Err(_) => PlayProbeLine {
            error: Some(format!(
                "探测超时（{}s）",
                PROBE_LINE_TIMEOUT.as_secs()
            )),
            ..base
        },
    }
}

fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

async fn search_source(
    source: &SourceConfig,
    query: &str,
) -> Result<Vec<PlaySearchItem>, String> {
    // 缓存体是序列化后的完整 items(含多页合并结果),不能用第一页原始响应。
    let cache_key = format!("search2:{}:{}", source.key, query);
    if let Some(body) = cache_get(&cache_key) {
        if let Ok(items) = serde_json::from_str::<Vec<PlaySearchItem>>(&body) {
            eprintln!("[play] search {} cache hit", source.key);
            return Ok(items);
        }
    }
    breaker_check(&source.key)?;
    let url = build_api_url(
        source,
        &source.search_action,
        "wd",
        query,
        &source.search_params,
    )?;
    eprintln!("[play] search {} -> {}", source.key, safe_url(&url));
    let response = apply_source_headers(client_for(source).get(url), source)
        .timeout(SEARCH_TIMEOUT)
        .send()
        .await;
    let response = match response {
        Ok(response) => response,
        Err(error) => {
            breaker_failure(&source.key);
            return Err(format!("请求失败：{}", error.without_url()));
        }
    };
    if !response.status().is_success() {
        let status = response.status().as_u16();
        breaker_failure(&source.key);
        return Err(format!("HTTP {status}"));
    }
    let body = match response.text().await {
        Ok(body) => body,
        Err(error) => {
            breaker_failure(&source.key);
            return Err(format!("读取响应失败：{}", error.without_url()));
        }
    };
    let value: Value = match serde_json::from_str(&body) {
        Ok(value) => value,
        Err(error) => {
            breaker_failure(&source.key);
            return Err(format!("源返回非 JSON：{error}"));
        }
    };
    let mut items = match parse_search_items(&value, source) {
        Ok(items) => items,
        Err(error) => {
            breaker_failure(&source.key);
            return Err(error);
        }
    };
    // 多页拉取:CMS 每页约 20 条,长尾片名(如多季动漫)只取第一页会漏结果。
    let pagecount = value
        .get("pagecount")
        .and_then(Value::as_i64)
        .unwrap_or(1)
        .clamp(1, 4) as u32;
    if pagecount > 1 && items.len() >= 5 {
        let mut seen: std::collections::HashSet<String> = items
            .iter()
            .map(|item| item.vod_id.clone())
            .collect();
        for page in 2..=pagecount {
            let Ok(page_url) = build_api_url_page(source, &source.search_action, "wd", query, &source.search_params, page)
            else {
                break;
            };
            let Ok(page_response) = apply_source_headers(client_for(source).get(page_url), source)
                .timeout(SEARCH_TIMEOUT)
                .send()
                .await
            else {
                break;
            };
            if !page_response.status().is_success() {
                break;
            }
            let Ok(page_body) = page_response.text().await else { break };
            let Ok(page_value) = serde_json::from_str::<Value>(&page_body) else { break };
            let Ok(mut page_items) = parse_search_items(&page_value, source) else { break };
            if page_items.is_empty() {
                break;
            }
            page_items.retain(|item| seen.insert(item.vod_id.clone()));
            items.append(&mut page_items);
            if items.len() >= 120 {
                break;
            }
        }
    }
    cache_put(
        cache_key,
        serde_json::to_string(&items).unwrap_or_else(|_| "[]".to_string()),
        SEARCH_TTL,
    );
    breaker_success(&source.key);
    eprintln!("[play] search {} ok ({} items)", source.key, items.len());
    Ok(items)
}

/// 只读本地详情缓存；`play_resolve` 依赖它做纯本地计算，不发网络请求。
fn cached_detail(source: &SourceConfig, vod_id: &str) -> Option<PlayDetail> {
    let cache_key = format!("detail:{}:{}", source.key, vod_id);
    let body = cache_get(&cache_key)?;
    let value: Value = serde_json::from_str(&body).ok()?;
    parse_detail_value(&value, source, vod_id).ok()
}

async fn fetch_detail(source: &SourceConfig, vod_id: &str) -> Result<PlayDetail, String> {
    if let Some(detail) = cached_detail(source, vod_id) {
        eprintln!("[play] detail {} cache hit", source.key);
        return Ok(detail);
    }
    breaker_check(&source.key)?;
    let cache_key = format!("detail:{}:{}", source.key, vod_id);
    let mut actions = vec![source.detail_action.clone()];
    let alternate = if source.detail_action == "detail" {
        "videolist"
    } else {
        "detail"
    };
    if alternate != source.detail_action {
        actions.push(alternate.to_string());
    }
    let mut errors = Vec::new();
    let mut transport_ok = false;
    for action in actions {
        let url = match build_api_url(
            source,
            &action,
            "ids",
            vod_id,
            &source.detail_params,
        ) {
            Ok(url) => url,
            Err(error) => {
                errors.push(format!("{action}: {error}"));
                continue;
            }
        };
        eprintln!(
            "[play] detail {} action={} -> {}",
            source.key,
            action,
            safe_url(&url)
        );
        let response = apply_source_headers(client_for(source).get(url), source)
            .timeout(DETAIL_TIMEOUT)
            .send()
            .await;
        let response = match response {
            Ok(response) => response,
            Err(error) => {
                errors.push(format!("{action}: {}", error.without_url()));
                continue;
            }
        };
        if !response.status().is_success() {
            errors.push(format!("{action}: HTTP {}", response.status().as_u16()));
            continue;
        }
        let body = match response.text().await {
            Ok(body) => body,
            Err(error) => {
                errors.push(format!(
                    "{action}: 读取响应失败（{}）",
                    error.without_url()
                ));
                continue;
            }
        };
        let value: Value = match serde_json::from_str(&body) {
            Ok(value) => value,
            Err(error) => {
                errors.push(format!("{action}: 非 JSON（{error}）"));
                continue;
            }
        };
        transport_ok = true;
        match parse_detail_value(&value, source, vod_id) {
            Ok(detail) => {
                cache_put(cache_key, body, DETAIL_TTL);
                breaker_success(&source.key);
                eprintln!(
                    "[play] detail {} ok ({} lines)",
                    source.key,
                    detail.lines.len()
                );
                return Ok(detail);
            }
            Err(error) => errors.push(format!("{action}: {error}")),
        }
    }
    if !transport_ok {
        breaker_failure(&source.key);
    }
    Err(errors.join("；"))
}

fn find_source(app: &AppHandle, key: &str, require_enabled: bool) -> Result<SourceConfig, String> {
    let key = key.trim().to_ascii_lowercase();
    if key.is_empty() {
        return Err("缺少播放源 key".to_string());
    }
    let source = load_config(app)
        .into_iter()
        .find(|source| source.key == key)
        .ok_or_else(|| format!("未找到播放源：{key}"))?;
    if require_enabled && !source.enabled {
        return Err(format!("播放源已禁用：{key}"));
    }
    Ok(source)
}

pub(crate) fn source_by_key(app: &AppHandle, key: &str) -> Option<SourceConfig> {
    let key = key.trim().to_ascii_lowercase();
    load_config(app)
        .into_iter()
        .find(|source| source.key == key)
}

#[tauri::command]
pub async fn play_sources(app: AppHandle) -> Result<Vec<PlaySourceInfo>, String> {
    Ok(load_config(&app)
        .into_iter()
        .map(|source| PlaySourceInfo {
            key: source.key,
            name: source.name,
            priority: source.priority,
            enabled: source.enabled,
        })
        .collect())
}

#[tauri::command]
pub async fn play_probe(
    app: AppHandle,
    source_key: String,
    vod_id: String,
) -> Result<PlayProbeResult, String> {
    let source = find_source(&app, &source_key, true)?;
    let vod_id = vod_id.trim();
    if vod_id.is_empty() {
        return Err("缺少 vod_id".to_string());
    }
    let cache_key = format!("probe:{}:{}", source.key, vod_id);
    if let Some(mut cached) = probe_cache_get(&cache_key) {
        // 全部失败的探测不缓存（兼容旧版本写入的失败结果），让首帧自愈能真正重探。
        if cached.lines.iter().any(|line| line.ok) {
            cached.cached = true;
            eprintln!("[play] probe {} vod={} cache hit", source.key, vod_id);
            return Ok(cached);
        }
    }
    let started = Instant::now();
    // P0：probe 只读详情缓存，不触发 detail 网络，避免与 resolve/播放竞争。
    let detail = cached_detail(&source, vod_id).ok_or_else(|| {
        "详情尚未缓存，请先 play_detail 后再 probe".to_string()
    })?;
    let playable: Vec<PlayLine> = detail
        .lines
        .iter()
        .filter(|line| is_playable_line(line))
        .cloned()
        .collect();
    let mut lines = if playable.is_empty() {
        Vec::new()
    } else {
        let futures = playable.into_iter().map(|line| {
            let source = source.clone();
            async move { probe_line(&source, &line).await }
        });
        futures::future::join_all(futures).await
    };
    let recommended = mark_recommended(&mut lines);
    let result = PlayProbeResult {
        source_key: source.key.clone(),
        vod_id: detail.vod_id.clone(),
        lines,
        recommended_line_index: recommended,
        cached: false,
        probed_at_ms: epoch_ms(),
    };
    // 只缓存至少有一条可播线路的结果；全失败交给下次重试。
    if result.lines.iter().any(|line| line.ok) {
        probe_cache_put(cache_key, result.clone());
    }
    for line in &result.lines {
        eprintln!(
            "[play] probe line {} name={:?} ok={} segs={} dur={:.1}s endlist={} ttfb={}ms speed={}kbps stability={:.1} jitter={:.1}ms samples={} fail={} score={:.1} err={:?}",
            line.line_index,
            line.name,
            line.ok,
            line.segment_count,
            line.duration_sec,
            line.endlist,
            line.ttfb_ms,
            line.speed_kbps,
            line.stability_score,
            line.jitter_ms,
            line.sample_count,
            line.failure_count,
            line.score,
            line.error
        );
    }
    eprintln!(
        "[play] probe {} vod={} lines={} recommended={:?} in {}ms",
        source.key,
        detail.vod_id,
        result.lines.len(),
        recommended,
        started.elapsed().as_millis()
    );
    Ok(result)
}

#[tauri::command]
pub async fn play_search(
    app: AppHandle,
    query: String,
    source_key: Option<String>,
) -> Result<PlaySearchResponse, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Ok(PlaySearchResponse {
            items: Vec::new(),
            errors: Vec::new(),
        });
    }
    let all = load_config(&app);
    let explicit = source_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(|key| key.to_ascii_lowercase());
    let sources: Vec<SourceConfig> = match explicit.as_deref() {
        Some(key) => {
            let source = all
                .into_iter()
                .find(|source| source.key == key)
                .ok_or_else(|| format!("未找到播放源：{key}"))?;
            if !source.enabled {
                return Err(format!("播放源已禁用：{key}"));
            }
            vec![source]
        }
        None => all.into_iter().filter(|source| source.enabled).collect(),
    };
    if sources.is_empty() {
        eprintln!("[play] search skipped: no enabled sources");
        return Ok(PlaySearchResponse {
            items: Vec::new(),
            errors: Vec::new(),
        });
    }
    let search_started = Instant::now();
    let mut pending_keys: HashSet<String> = sources
        .iter()
        .map(|source| source.key.clone())
        .collect();
    let mut pending: FuturesUnordered<SearchFuture> = FuturesUnordered::new();    for source in sources {
        let query = query.clone();
        pending.push(Box::pin(async move {
            let result = search_source(&source, &query).await;
            (source.key.clone(), result)
        }));
    }
    let deadline = Instant::now() + SEARCH_TOTAL_BUDGET;
    let mut merge_until: Option<Instant> = None;
    let mut got_usable = false;
    let mut items = Vec::new();
    let mut errors = Vec::new();
    loop {
        if pending.is_empty() {
            break;
        }
        let now = Instant::now();
        let wait_until = merge_until.unwrap_or(deadline);
        if now >= wait_until {
            break;
        }
        match tokio::time::timeout(wait_until - now, pending.next()).await {
            Ok(Some((source_key, result))) => {
                pending_keys.remove(&source_key);
                match result {
                    Ok(mut found) => {
                        let usable = !found.is_empty();
                        items.append(&mut found);
                        if usable && !got_usable {
                            got_usable = true;
                            let mut end = Instant::now() + SEARCH_MERGE_WINDOW;
                            if end > deadline {
                                end = deadline;
                            }
                            merge_until = Some(end);
                        }
                    }
                    Err(message) => errors.push(PlaySourceError {
                        source_key,
                        message,
                    }),
                }
            }
            Ok(None) => break,
            Err(_) => break,
        }
    }
    for source_key in pending_keys.drain() {
        errors.push(PlaySourceError {
            source_key,
            message: "超过搜索时限，已跳过本次结果（后台继续）".to_string(),
        });
    }
    // 已返回给 UI 的慢源不再等待；让它们在后台跑完并写入 5min 缓存，供下一次搜索命中。
    if !pending.is_empty() {
        tauri::async_runtime::spawn(async move {
            let mut pending = pending;
            while let Some((source_key, result)) = pending.next().await {
                match result {
                    Ok(items) => {
                        eprintln!("[play] late search {source_key} -> {} items", items.len())
                    }
                    Err(error) => eprintln!("[play] late search {source_key} failed: {error}"),
                }
            }
        });
    }
    if explicit.is_some() && items.is_empty() {
        if let Some(error) = errors.first() {
            return Err(format!("{}：{}", error.source_key, error.message));
        }
    }
    eprintln!(
        "[play] search \"{}\" -> {} items, {} errors in {}ms",
        query,
        items.len(),
        errors.len(),
        search_started.elapsed().as_millis()
    );
    Ok(PlaySearchResponse { items, errors })
}

#[tauri::command]
pub async fn play_detail(
    app: AppHandle,
    source_key: String,
    vod_id: String,
) -> Result<PlayDetail, String> {
    let source = find_source(&app, &source_key, true)?;
    let vod_id = vod_id.trim();
    if vod_id.is_empty() {
        return Err("缺少 vod_id".to_string());
    }
    fetch_detail(&source, vod_id).await
}

#[tauri::command]
pub async fn play_resolve(
    app: AppHandle,
    source_key: String,
    vod_id: String,
    line_index: Option<usize>,
    episode_index: usize,
) -> Result<PlayTarget, String> {
    let source = find_source(&app, &source_key, true)?;
    let vod_id = vod_id.trim();
    if vod_id.is_empty() {
        return Err("缺少 vod_id".to_string());
    }
    // P0：resolve 只读本地详情缓存，不发网络；前端必须先 play_detail 再 resolve。
    let detail = cached_detail(&source, vod_id).ok_or_else(|| {
        "详情尚未加载，请先调用 play_detail 获取线路后再播放".to_string()
    })?;
    if detail.lines.is_empty() {
        return Err("该源未返回可播放线路".to_string());
    }
    let line = choose_line(&detail.lines, line_index)?;
    if line.episodes.is_empty() {
        return Err(format!("线路「{}」没有可播放剧集", line.name));
    }
    let safe_episode = episode_index.min(line.episodes.len() - 1);
    if safe_episode != episode_index {
        eprintln!(
            "[play] episode_index {episode_index} clamped to {safe_episode} (line {})",
            line.index
        );
    }
    let episode = &line.episodes[safe_episode];
    let format = episode.format.clone();
    if !matches!(format.as_str(), "hls" | "mp4") {
        return Err(match format.as_str() {
            "page" => format!("线路「{}」第 {} 集是网页地址，暂不支持播放", line.name, safe_episode + 1),
            _ => format!("线路「{}」第 {} 集格式暂不支持（仅支持 HLS/MP4）", line.name, safe_episode + 1),
        });
    }
    eprintln!(
        "[play] resolve {} vod={} line={} line_format={} ep={} format={} always_proxy={}",
        source.key,
        detail.vod_id,
        line.index,
        line.format,
        safe_episode,
        format,
        source.always_proxy
    );
    // HLS 线路走代理才能执行按源的广告过滤;MP4 直链保持直连以降低开销。
    let use_proxy = source.always_proxy || (format == "hls" && source.ad_filter == "safe");
    Ok(PlayTarget {
        source_key: source.key.clone(),
        vod_id: detail.vod_id.clone(),
        line_index: line.index,
        episode_index: safe_episode,
        url: episode.url.clone(),
        proxy_url: proxy_url(&source.key, &episode.url),
        format,
        use_proxy,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 生成进程内唯一的缓存 key:全局 OnceLock 缓存被所有测试共享,固定 key 会在
    /// cargo test 并行执行时互相污染。
    fn unique_test_key(prefix: &str) -> String {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let sequence = SEQ.fetch_add(1, Ordering::SeqCst);
        format!("{prefix}:{}:{}", std::process::id(), sequence)
    }

    fn test_source() -> SourceConfig {
        SourceConfig {
            key: "lzi".to_string(),
            name: "量子资源".to_string(),
            source_type: "cms".to_string(),
            api: "https://example.com/api.php/provide/vod/".to_string(),
            enabled: true,
            priority: 0,
            headers: SourceHeaders::default(),
            allow_private_network: false,
            always_proxy: false,
            ad_filter: default_ad_filter(),
            ad_rules: AdRules::default(),
            search_action: default_search_action(),
            detail_action: default_detail_action(),
            search_params: HashMap::new(),
            detail_params: HashMap::new(),
        }
    }

    #[test]
    fn parses_multiple_lines_and_episodes() {
        let lines = parse_play_lines(
            "线路一$$$线路二",
            "第01集$https://cdn.example.com/a/1.m3u8#第02集$https://cdn.example.com/a/2.m3u8$$$正片$https://cdn.example.com/b/full.mp4",
        );
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].name, "线路一");
        assert_eq!(lines[0].format, "hls");
        assert_eq!(lines[0].episodes.len(), 2);
        assert_eq!(lines[0].episodes[1].name, "第02集");
        assert_eq!(lines[0].episodes[1].format, "hls");
        assert_eq!(lines[1].name, "线路二");
        assert_eq!(lines[1].format, "mp4");
        assert_eq!(lines[1].episodes[0].name, "正片");
        assert_eq!(lines[1].episodes[0].format, "mp4");
    }

    #[test]
    fn generates_names_when_missing() {
        let lines = parse_play_lines("", "https://cdn.example.com/a/1.m3u8#https://cdn.example.com/a/2.m3u8");
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].name, "线路1");
        assert_eq!(lines[0].episodes[0].name, "第1集");
        assert_eq!(lines[0].episodes[1].name, "第2集");
    }

    #[test]
    fn tolerates_mismatched_line_counts() {
        let only_urls = parse_play_lines("A", "https://cdn.example.com/a/1.m3u8$$$https://cdn.example.com/b/2.m3u8");
        assert_eq!(only_urls.len(), 2);
        assert_eq!(only_urls[0].name, "A");
        assert_eq!(only_urls[1].name, "线路2");

        let only_names = parse_play_lines("A$$$B$$$C", "https://cdn.example.com/a/1.m3u8");
        assert_eq!(only_names.len(), 1);
        assert_eq!(only_names[0].name, "A");
    }

    #[test]
    fn playable_lines_sort_first_and_reindex() {
        // page/unknown 线路里 page 被丢弃,unknown 保留但排在最后。
        let lines = parse_play_lines(
            "share$$$m3u8$$$unknown",
            "正片$https://example.com/share/1$$$正片$https://example.com/a.m3u8$$$正片$https://example.com/live/stream",
        );
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].format, "hls");
        assert_eq!(lines[0].index, 0);
        assert_eq!(lines[1].format, "unknown");
        assert_eq!(lines[1].index, 1);
    }

    #[test]
    fn drops_page_lines() {
        let lines = parse_play_lines(
            "dyttm3u8$$$dytt$$$ffm3u8",
            "正片$https://example.com/a/1.m3u8$$$正片$https://example.com/share/v$$$正片$https://example.com/b/1.m3u8",
        );
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].name, "dyttm3u8");
        assert_eq!(lines[1].name, "ffm3u8");
    }

    #[test]
    fn drops_yun_play_lines() {
        let lines = parse_play_lines(
            "jinyingm3u8$$$jinyingyun$$$ffm3u8",
            "正片$https://example.com/a/1.m3u8$$$正片$https://example.com/share/v$$$正片$https://example.com/b/1.m3u8",
        );
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].name, "jinyingm3u8");
        assert_eq!(lines[1].name, "ffm3u8");
    }

    #[test]
    fn cached_detail_reads_local_cache_only() {
        let source = test_source();
        let vod_id = unique_test_key("vod");
        let body = r#"{"vod_id":42,"vod_name":"cache me","vod_play_url":"正片$https://example.com/a.m3u8"}"#;
        cache_put(
            format!("detail:{}:{}", source.key, vod_id),
            body.to_string(),
            DETAIL_TTL,
        );
        let detail = cached_detail(&source, &vod_id).unwrap();
        assert_eq!(detail.name, "cache me");
        assert!(cached_detail(&source, "missing-definitely-absent").is_none());
    }

    #[test]
    fn selects_first_playable_line_by_default() {
        let lines = vec![
            PlayLine {
                index: 0,
                name: "share".to_string(),
                format: "page".to_string(),
                episodes: vec![PlayEpisode {
                    index: 0,
                    name: "HD".to_string(),
                    url: "https://example.com/share/abc".to_string(),
                    format: "page".to_string(),
                }],
            },
            PlayLine {
                index: 1,
                name: "m3u8".to_string(),
                format: "hls".to_string(),
                episodes: vec![PlayEpisode {
                    index: 0,
                    name: "HD".to_string(),
                    url: "https://example.com/hls/index.m3u8".to_string(),
                    format: "hls".to_string(),
                }],
            },
        ];
        let selected = choose_line(&lines, None).unwrap();
        assert_eq!(selected.index, 1);
        assert_eq!(selected.format, "hls");

        let error = choose_line(&lines, Some(0)).unwrap_err();
        assert!(error.contains("暂不支持"));
        let error = choose_line(&lines, Some(9)).unwrap_err();
        assert!(error.contains("超出范围"));

        let only_pages = vec![lines[0].clone()];
        assert!(choose_line(&only_pages, None).is_err());
    }

    #[test]
    fn handles_empty_and_invalid_inputs() {
        assert!(parse_play_lines("", "").is_empty());
        assert!(parse_play_lines("A$$$B", "").is_empty());
        assert!(parse_play_lines("A", "###").is_empty());
        assert!(parse_play_lines("A", "第01集$#第02集$").is_empty());
    }

    #[test]
    fn keeps_dollar_signs_inside_urls() {
        let lines = parse_play_lines("", "第01集$https://cdn.example.com/a.m3u8?sign=$abc");
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].episodes[0].name, "第01集");
        assert_eq!(
            lines[0].episodes[0].url,
            "https://cdn.example.com/a.m3u8?sign=$abc"
        );
    }

    #[test]
    fn accepts_protocol_relative_and_html_escaped_urls() {
        let lines = parse_play_lines("", "正片$//cdn.example.com/a.m3u8?x=1&amp;y=2");
        assert_eq!(lines.len(), 1);
        assert_eq!(
            lines[0].episodes[0].url,
            "https://cdn.example.com/a.m3u8?x=1&y=2"
        );
    }

    #[test]
    fn detects_play_url_format() {
        assert_eq!(detect_format("https://x/a/index.m3u8?sign=1"), "hls");
        assert_eq!(detect_format("https://x/a/full.mp4"), "mp4");
        assert_eq!(detect_format("https://vip.lzcdn2.com/share/abc"), "page");
        assert_eq!(detect_format("https://x/index.php/vod/play/id/1/sid/1/nid/1"), "page");
        assert_eq!(detect_format("https://x/detail/1.html"), "page");
        assert_eq!(
            detect_format("https://x/share/abc?url=https://y/a.m3u8"),
            "page"
        );
        assert_eq!(detect_format("https://x/live/stream?format=m3u8"), "hls");
        assert_eq!(detect_format("https://x/live/stream"), "unknown");
    }

    #[test]
    fn builds_proxy_url() {
        let url = proxy_url("lzi", "https://cdn.example.com/a/index.m3u8?sign=1");
        assert!(url.starts_with("http://jjstream.localhost/lzi/"));
        assert!(url.contains("https%3A%2F%2Fcdn.example.com%2Fa%2Findex.m3u8"));
        assert!(url.ends_with(&format!("?k={}", proxy_token())));

    }

    #[test]
    fn builds_default_origin() {
        let url = Url::parse("https://vip.lzcdn2.com/path/index.m3u8").unwrap();
        assert_eq!(default_origin(&url).as_deref(), Some("https://vip.lzcdn2.com/"));
    }

    #[test]
    fn parses_bare_detail_object() {
        let value: Value = serde_json::from_str(
            r#"{
              "vod_id": 14547,
              "vod_name": "流浪地球",
              "vod_year": "2019",
              "type_name": "科幻片",
              "vod_play_from": "liangzi$$$lzm3u8",
              "vod_play_url": "HD中字$https://vip.lzcdn2.com/share/15b3342aa0abd5176b93d68ddf95e3ce$$$HD中字$https://vip.lzcdn2.com/20220507/5834_3349bde2/index.m3u8"
            }"#,
        )
        .unwrap();
        let detail = parse_detail_value(&value, &test_source(), "14547").unwrap();
        assert_eq!(detail.vod_id, "14547");
        assert_eq!(detail.name, "流浪地球");
        // page 线路(liangzi)在解析层被丢弃,只保留 m3u8 系列
        assert_eq!(detail.lines.len(), 1);
        assert_eq!(detail.lines[0].name, "lzm3u8");
        assert_eq!(detail.lines[0].index, 0);
        assert_eq!(detail.lines[0].format, "hls");
        assert_eq!(detail.lines[0].episodes[0].format, "hls");
    }

    #[test]
    fn parses_detail_list_and_matches_vod_id() {
        let value = json!({
            "code": 1,
            "list": [
                {"vod_id": 1, "vod_name": "wrong", "vod_play_url": "正片$https://x/1.mp4"},
                {"vod_id": 2, "vod_name": "right", "vod_play_url": "正片$https://x/2.mp4"}
            ]
        });
        let detail = parse_detail_value(&value, &test_source(), "2").unwrap();
        assert_eq!(detail.vod_id, "2");
        assert_eq!(detail.name, "right");
    }

    #[test]
    fn rejects_detail_without_lines() {
        let value = json!({"vod_id": 1, "vod_name": "empty", "vod_play_url": ""});
        assert!(parse_detail_value(&value, &test_source(), "1").is_err());
        // 只有网页地址的源在解析层被过滤后等价于无线路,应报错而不是给出 page 线路。
        let page_only = json!({"vod_id": 1, "vod_name": "page", "vod_play_url": "正片$https://example.com/play/1"});
        assert!(parse_detail_value(&page_only, &test_source(), "1").is_err());
    }

    #[test]
    fn parses_search_items() {
        let value = json!({
            "code": 1,
            "msg": "数据列表",
            "list": [{
                "vod_id": 14547,
                "vod_name": "流浪地球",
                "vod_year": "2019",
                "type_name": "科幻片",
                "vod_play_from": "liangzi$$$lzm3u8",
                "vod_play_url": "HD中字$https://x/a.m3u8"
            }]
        });
        let items = parse_search_items(&value, &test_source()).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].vod_id, "14547");
        assert_eq!(items[0].year, "2019");
        assert_eq!(items[0].line_names, vec!["liangzi", "lzm3u8"]);
    }

    #[test]
    fn reports_source_error_message() {
        let value = json!({"code": 0, "msg": "参数错误", "list": []});
        let error = parse_search_items(&value, &test_source()).unwrap_err();
        assert!(error.contains("参数错误"));
    }

    #[test]
    fn validates_source_config() {
        let valid = validate_source(SourceConfig {
            key: " LZI-A ".to_string(),
            ..test_source()
        })
        .unwrap();
        assert_eq!(valid.key, "lzi-a");

        let invalid = validate_source(SourceConfig {
            key: "bad key".to_string(),
            ..test_source()
        });
        assert!(invalid.is_none());

        let unsupported = validate_source(SourceConfig {
            source_type: "json".to_string(),
            ..test_source()
        });
        assert!(unsupported.is_none());

        let ad_off = validate_source(SourceConfig {
            ad_filter: "OFF".to_string(),
            ..test_source()
        })
        .unwrap();
        assert_eq!(ad_off.ad_filter, "off");

        let ad_fallback = validate_source(SourceConfig {
            ad_filter: "weird".to_string(),
            ..test_source()
        })
        .unwrap();
        assert_eq!(ad_fallback.ad_filter, "safe");
    }

    #[test]
    fn picks_highest_master_variant() {
        let base = Url::parse("https://cdn.example.com/hls/master.m3u8").unwrap();
        let text = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720\n720/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080\n1080/index.m3u8\n";
        let best = parse_master_playlist(text, &base).unwrap();
        assert_eq!(best.width, 1920);
        assert_eq!(best.height, 1080);
        assert_eq!(best.bandwidth_kbps, 3000);
        assert_eq!(
            best.url.as_str(),
            "https://cdn.example.com/hls/1080/index.m3u8"
        );
    }

    #[test]
    fn finds_first_media_segment() {
        let base = Url::parse("https://cdn.example.com/hls/1080/index.m3u8").unwrap();
        let text = "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:4,\nseg1.ts\n";
        let segment = segment_urls(text, &base).into_iter().next().unwrap();
        assert_eq!(
            segment.as_str(),
            "https://cdn.example.com/hls/1080/seg1.ts"
        );
    }

    #[test]
    fn probe_score_balances_speed_and_quality() {
        let fast_1080 = compute_probe_score(300, 6000, 1080, 5000, 100.0);
        let slow_1080 = compute_probe_score(2000, 1000, 1080, 5000, 100.0);
        let fast_2160 = compute_probe_score(300, 6000, 2160, 10000, 100.0);
        assert!(fast_1080 > slow_1080);
        assert!(fast_2160 > fast_1080);
    }

    #[test]
    fn probe_score_stability_weight() {
        let stable = compute_probe_score(300, 6000, 1080, 5000, 100.0);
        let unstable = compute_probe_score(300, 6000, 1080, 5000, 0.0);
        // 稳定性权重 0.2:满分稳定性带来 20 分差。
        assert!(stable - unstable >= 19.0);
        assert!(stable - unstable <= 21.0);
    }

    #[test]
    fn probe_score_prefers_faster_line() {
        // 速度主导(0.7):带宽更高、TTFB 更低的线路总分必须显著更高。
        let slow = compute_probe_score(400, 1500, 1080, 3000, 80.0);
        let fast = compute_probe_score(120, 8000, 1080, 8000, 90.0);
        assert!(fast > slow);
    }

    #[test]
    fn stability_score_penalizes_jitter_and_failures() {
        let stable = compute_stability_score(3, 0, 20.0, &[5000.0, 5100.0, 4900.0]);
        let jittery = compute_stability_score(3, 0, 900.0, &[5000.0, 5100.0, 4900.0]);
        let failing = compute_stability_score(2, 1, 20.0, &[5000.0, 5100.0]);
        assert!(stable > jittery);
        assert!(stable > failing);
    }

    #[test]
    fn playlist_stats_reports_segments_duration_and_endlist() {
        let (count, duration, endlist) = playlist_stats(
            "#EXTM3U\n#EXTINF:4,\na.ts\n#EXTINF:3.5,\nb.ts\n#EXT-X-ENDLIST\n",
        );
        assert_eq!(count, 2);
        assert!((duration - 7.5).abs() < 1e-6);
        assert!(endlist);

        let (count, duration, endlist) =
            playlist_stats("#EXTM3U\n#EXTINF:4,\na.ts\n");
        assert_eq!(count, 1);
        assert!((duration - 4.0).abs() < 1e-6);
        assert!(!endlist);
    }

    #[test]
    fn probe_cache_roundtrip() {
        let vod_id = unique_test_key("probe-cache");
        let result = PlayProbeResult {
            source_key: "lzi".to_string(),
            vod_id: vod_id.clone(),
            lines: Vec::new(),
            recommended_line_index: None,
            cached: false,
            probed_at_ms: 1,
        };
        probe_cache_put(format!("probe:lzi:{vod_id}"), result);
        let hit = probe_cache_get(&format!("probe:lzi:{vod_id}")).unwrap();
        assert_eq!(hit.vod_id, vod_id);
        assert!(!hit.cached);
        assert!(probe_cache_get("probe:lzi:missing-probe-cache-entry").is_none());
    }

    #[test]
    fn marks_highest_scoring_probe_line() {
        let mut lines = vec![
            PlayProbeLine {
                line_index: 0,
                name: "a".to_string(),
                format: "hls".to_string(),
                ok: true,
                error: None,
                ttfb_ms: 200,
                speed_kbps: 4000,
                width: 1920,
                height: 1080,
                bandwidth_kbps: 5000,
                segment_count: 100,
                duration_sec: 600.0,
                endlist: true,
                sample_count: 3,
                failure_count: 0,
                jitter_ms: 30.0,
                stability_score: 80.0,
                score: 70.0,
                recommended: false,
            },
            PlayProbeLine {
                line_index: 1,
                name: "b".to_string(),
                format: "hls".to_string(),
                ok: true,
                error: None,
                ttfb_ms: 250,
                speed_kbps: 4000,
                width: 3840,
                height: 2160,
                bandwidth_kbps: 10000,
                segment_count: 100,
                duration_sec: 600.0,
                endlist: true,
                sample_count: 3,
                failure_count: 0,
                jitter_ms: 20.0,
                stability_score: 95.0,
                score: 82.0,
                recommended: false,
            },
            PlayProbeLine {
                line_index: 2,
                name: "bad".to_string(),
                format: "hls".to_string(),
                ok: false,
                error: Some("timeout".to_string()),
                ttfb_ms: 0,
                speed_kbps: 0,
                width: 0,
                height: 0,
                bandwidth_kbps: 0,
                segment_count: 0,
                duration_sec: 0.0,
                endlist: false,
                sample_count: 0,
                failure_count: 0,
                jitter_ms: 0.0,
                stability_score: 0.0,
                score: 0.0,
                recommended: false,
            },
        ];
        let recommended = mark_recommended(&mut lines);
        assert_eq!(recommended, Some(1));
        assert!(!lines[0].recommended);
        assert!(lines[1].recommended);
        assert!(!lines[2].recommended);
    }

    #[test]
    fn builds_api_url_with_expected_params() {
        let source = test_source();
        let url = build_api_url(&source, "videolist", "wd", "流浪地球", &HashMap::new()).unwrap();
        assert_eq!(url.path(), "/api.php/provide/vod/");
        assert!(url.query().unwrap().contains("ac=videolist"));
        assert!(url.query().unwrap().contains("wd="));
        assert!(url.query().unwrap().contains("pg=1"));

        let detail = build_api_url(&source, "videolist", "ids", "14547", &HashMap::new()).unwrap();
        assert!(detail.query().unwrap().contains("ids=14547"));
    }
}
