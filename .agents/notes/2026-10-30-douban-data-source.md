# 决策：豆瓣影视数据源接入（列表/搜索/详情/海报）

日期：2026-10-30 · 状态：已实施

## 背景

需求：接入真实影视封皮（海报）、详情数据、搜索，暂不接播放源。项目原为 Netflix 风格硬编码演示数据（9 部）。

## 方案（参考 LunaTV/MoonTV 的成熟做法并实测）

数据链路：前端 `douban.ts`（invoke 封装 + Title 适配器）→ Rust `douban.rs`（reqwest 多 host 回退 + 内存缓存）。

- **列表**：`GET /j/search_subjects?type={tv|movie}&tag={热门|最新|…}&sort=recommend&page_limit&page_start`
- **搜索**：`GET /j/subject_suggest?q={UTF-8 编码}`
- **详情**：`GET m.douban.com/rexxar/api/v2/{movie|tv}/{id}`（kind 双端点回退；返回 rating/genres/directors/actors/intro/pic/durations/episodes_count）
- **Host 回退顺序**：`*.cmliussss.net`（腾讯反代）→ `.com`（阿里）→ 官方域名（先 GET 首页拿 bid cookie 再请求）
- **图片防盗链**：Tauri 自定义协议 `dbimg://<原URL>`，Rust 端带 `Referer: https://movie.douban.com/explore` + 浏览器 UA 转发（LunaTV image-proxy 的桌面等价物）。hero 大图用 `s_ratio_poster→l_ratio_poster` 替换。
- **缓存**：Rust 内存缓存（列表/搜索 10min、详情 24h）；前端 localStorage `jj-title-cache` 持久化片库注册表。
- **降级**：豆瓣不可用时回退内置演示片库，UI 提示 + 重试按钮。

## Alternatives considered

1. **frodo 移动端 API**（frodo.douban.com/api/v2）：需 apiKey+签名，公开 key 已失效（实测 invalid_apikey），弃用。
2. **详情页 HTML 解析（JSON-LD/top250 正则）**：被 `sec.douban.com` 风控 302 挡住（实测），且解析脆弱，弃用（LunaTV 的 top250 走 HTML 正则是因为该页无 JSON API）。
3. **官方域名直连**：列表接口需 bid cookie（实测无 cookie 返回空/错误），仅作兜底路径。
4. **前端直接 fetch 豆瓣**：CORS + Referer 双重拦截，不可行，必须走 Rust 代理。
5. **图片 referrerPolicy=no-referrer**：实测豆瓣图床对无 Referer 请求返回 418，不可行。

## 遗留 / 下一步

- 播放源接入（Theater 仍为模拟播放；豆瓣 episodes 是生成的占位列表）。
- 豆瓣 tag 体系可扩展（华语/欧美/经典等，见 `DOUBAN_FEEDS`）。
- top250 榜单（可参考 LunaTV 的 HTML 正则方案，官方无 JSON API）。
- localStorage 注册表超 5MB 的裁剪策略目前是粗暴 slice(-300)，可优化为 LRU。