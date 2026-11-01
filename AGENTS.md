# SeeWorld（jianjie-desktop）

Tauri 2 桌面应用：Rust 后端 + React 19 / Vite 前端（`prototype/`），Windows 无边框暗色影院 UI。品牌 **SeeWorld**（标志为红色 S，任务栏图标同款）；无账号系统，侧栏入口为「设置」。

## 常用命令

- 开发：根目录 `npm run dev`（= `tauri dev`，自动起 vite :1420）
- 前端构建检查：`npm --prefix prototype run build`（tsc -b + vite build）
- 前端单测：`npm test`（= prototype 的 `vitest run`，测试文件与源码同目录 `*.test.ts`）
- Rust 检查：`cargo check` / `cargo test`（workdir `src-tauri/`）
- 打包：`npm run build:exe`（仅便携 exe）；`npm run build`（默认 bundle，Windows 产出 NSIS/MSI）
- 发布：推 `main` 更新 `nightly` 预发布；推 `vX.Y.Z` tag 生成正式 Release；由 `.github/workflows/release.yml` 构建并上传 portable/setup/msi

## 架构速览

- 前端无路由：`App.tsx` 按 `ViewKey` 条件渲染视图（home/new/tv/movies/anime/my-list/recent/later/settings）；弹层 = DetailModal / Theater。
- **片库注册表模式**：全局 `Title` 对象由 App 层 `registry`（state + localStorage `jj-title-cache`，防抖 800ms 写入）统一解析 `resolveTitle(id)`。豆瓣条目 id 形如 `db-{doubanId}`，搜索命中的播放源条目 id 形如 `ps-{sourceKey}-{vodId}`——**sourceKey 内的 `-` 转义为 `~`**，因此 id 中第一个 `-` 就是分隔符（DetailModal 据此反解）。合并走 `library.ts::mergeRegisteredTitle`：空值不覆盖已有数据，集数取较大值，详情评分/票数可刷新。**搜索命中的源条目先放 `transientTitlesRef`，仅在打开/播放/加入片单时注册**；清缓存只保留 pinned 标题。**无内置演示片库**：拉取失败显示错误 + 重试，首次用户「最近观看」等列表显示空状态引导。
- 豆瓣数据链路（详见 `.agents/notes/2026-10-30-douban-data-source.md` 与 [搜索/片库决策](.agents/notes/2026-11-02-search-relevance-and-transient-registry.md)）：
  - 前端 `src/douban.ts`（类型 + invoke 封装 + Title 适配器）→ Rust 命令（`src-tauri/src/douban.rs`）。
  - 列表/搜索/详情优先官方域名，失败回退 `*.cmliussss.net` 反代；豆瓣图片走 `dbimg://` 协议代理（Windows 下 `http://dbimg.localhost/`，带 Referer 防盗链，仅放行 `*.doubanio.com`），播放源自带海报按源域名直连（CSP 已放行 http/https 图片）。
  - 列表缓存按分类存 `jj-feed-cache:{feed}`（兼容旧 `jj-feed-cache`，id + 各 part 游标 `offsets` + `exhausted`）；分类页支持服务端筛选（`douban_recommend`），筛选状态存 `jj-explore-filters`。
  - **无限瀑布流**：分类页滚动到底由 `BrowseView` 的 sentinel 触发 `loadFeedNext`（各 part 独立游标追加，追加结果回写缓存）。豆瓣请求失败返回 `null` 时不判定到底；连续 3 轮无新增才标记 exhausted。筛选结果同样分页（`fetchExploreTitles` offsets/exhausted）。
- **播放源**（`src-tauri/resources/play-sources.json`，用户可用 `%APPDATA%/com.jianjie.desktop/play-sources.json` 覆盖）：
  - 7 个影视 CMS 源：dyttzy/ffzy 核心（时长指纹广告过滤）+ lzi/bfzy/jyzy/piaoling2 备用池；jszy 保持禁用（封皮错配）。广告过滤 `adFilter: safe` 内置于 jjstream 代理（`play_proxy.rs` 的 AD_KEYWORDS + 时长指纹 + 安全阈值）；当前 `maxDropRatio=0.15`。
  - **搜索多页**：CMS 源按 `pagecount` 最多拉 4 页；搜索总预算 2.5s，首个可用结果到达后再等 `SEARCH_MERGE_WINDOW=1000ms`。前端搜索 = 豆瓣联想 + 播放源全源并发聚合；**源结果必须经 `matchesSearchQuery`/`isVariantSearchResult` 过滤**（lzi/bfzy 会忽略 `wd` 返回整站目录），再经 `mergeSearchResults` 按作品版本去重。**单字只发豆瓣联想，≥2 字符才触发全源搜索**。
  - 设置页可启停源：`play_set_source_enabled` 用 `serde_json::Value` 局部改写用户 JSON，保留未知字段并立即失效 config cache；不要用 serde 反序列化整体回写。
- **jjstream 代理**（`play_proxy.rs`）：
  - URL 形如 `http://jjstream.localhost/{key}/{url}?k={token}`，token 每次启动随机生成（`play.rs::proxy_token`），无 token 请求一律 403。
  - HLS 播放列表重写 URI 全部走代理；按线路广告过滤（`adRules` 支持 `adDurationFingerprints`、`dropUniqueHostBlocks`、`dropShortBlocks`、`maxDropRatio`），HLS 广告源需强制走 jjstream 才生效。指纹只删命中分片，前后正片保留。
  - MP4 大文件按 16MB Range 分段回源（`bound_media_range`）；响应体必须 `chunk()` 流式读取并逐块限制（chunked/无 Content-Length 不能先 `bytes()` 全读），代理/图片有 semaphore 上限。
  - SSRF 防护：域名黑名单 + 私网 IP 黑名单 + 自定义 DNS resolver 在连接层再次逐 IP 校验（`PublicDnsResolver`），关闭 DNS rebinding 窗口；代理 client 保留上游 Cookie。
- **播放/换源规则**（`useHlsPlayer.ts` + `App.tsx` + `Theater.tsx`；决策见 [播放/代理决策](.agents/notes/2026-11-02-playback-abr-retry-and-proxy-limits.md)）：
  - probe 评分为速度主导（speed 0.7 / 稳定 0.2 / 质量 0.1），自动选最优线路；probe 只读详情缓存不发网络。
  - 自动换源仅三种触发：启动无帧（3s 代理重试 → 进度感知延长 → 换线/源）、单次冻结 60s、5 分钟内 ≥3 次真实（>1s）卡顿。亚秒抖动与用户 seek 引起的加载不计数。
  - **不要用 `hls.nextLevel` 强制升档**（会关闭 ABR）；自动模式只设 `autoLevelCapping`。手动画质走 `setLevel`，Auto 时恢复上限并把控制权交还 hls.js。
  - **实时播放位置走 `liveTimeRef`**；`playback.current` 是本次播放的起始位置，播放中不更新。手动重试前必须用 `liveCurrent()` 快照写入，否则会回到起点并覆盖进度。
  - 换集/换线时 Theater 通过 effect cleanup 快照旧集的 `episodeId/episodeIndex` 补发最终进度，App 按 episodeId 对账落库。
  - **进度落库节流 60s**（`PROGRESS_FLUSH_MS`）；关闭/暂停/结束/换集前强制 flush。标题级 `jj-progress` 用于最近观看/续播；**每集独立进度存 `jj-episode-progress`（titleId → episodeId）**，显式点集优先读该集。清观看记录必须同时清两个 key。
  - **集 id 必须稳定**：`episodeIdForIndex` 在源集数超出豆瓣集数时按 `${title.id}-s1eN` 生成，**不允许回退成"当前集 id"**。
  - `play_resolve` 优先读 detail 缓存（命中即续期），缓存缺失时回源一次；`preferredLine` 必须按 `detail.lines` 重新校验可播放；`detailMatchesTitle` 校验详情名称/年份/类型，年份差 >2 或明确类型冲突直接拒绝。
- 设置页「备份与存储」可导出/导入片单、进度、标题缓存与播放设置（白名单 key），并显示本地数据大小；导出走 Rust `export_backup` 写入系统下载目录（不弹 WebView2 下载框），导入会覆盖本机数据。
- i18n：`i18n.tsx` 中 en/zh 双字典，新文案必须同时补两处。
- 持久化统一走 `lib.ts` 的 `usePersistentState`（key 前缀 `jj-`）。

## E2E

- 受控 fixture（无需 Tauri/真实网络）：`npm --prefix prototype run build && npm --prefix prototype run preview -- --port 1420`，另开终端 `node e2e/fixtures.mjs`。覆盖搜索过滤/同名版本、全源失败错误态、清缓存保留片单。
- 真实窗口：设 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223` 后 `npm run dev`，用 playwright-core `chromium.connectOverCDP('http://127.0.0.1:9223')` 连接。页面滚动容器是 `.main-scroll`；豆瓣与播放源依赖真实网络。现有套件：`smoke`、`robustness`、`lines-panel`、`lines-scroll`、`episode-resume`、`episode-progress`、`new-features`、`retry-resume`、`export-check`。
- 会改本地数据的真实套件必须先备份 `%APPDATA%\com.jianjie.desktop` 与 `%LOCALAPPDATA%\com.jianjie.desktop\EBWebView`，结束后恢复。备份导出走 Rust `export_backup` 直接写下载目录，前端显示 `data-export-path`，不再触发 WebView2 下载提示。

## 约定

- 决策记录索引：[.agents/notes/README.md](.agents/notes/README.md)；完成 Git 提交后按其中「何时写」自查，命中才写，未命中静默继续。
- 修改 `Title` 接口时注意 `douban.ts` / `play.ts` 适配器与 `content.ts` 翻译层的联动；`register` 合并规则统一走 `library.ts`。
- 前端纯逻辑（匹配/评分/集数映射/搜索去重）改动须补 `*.test.ts`；Rust 关键解析（wire/播放列表/广告过滤/配置改写）已有单测，改行为先改测试。
- 全局缓存/状态被 Rust 测试共享时用唯一 key（`unique_test_key`）。
- 持久化 key 新增/迁移时同步检查：清缓存、清观看记录、备份导入导出、`AGENTS.md` 说明四处。
