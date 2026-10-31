# SeeWorld（jianjie-desktop）

Tauri 2 桌面应用：Rust 后端 + React 19 / Vite 前端（`prototype/`），Windows 无边框暗色影院 UI。品牌 **SeeWorld**（标志为红色 S，任务栏图标同款）；无账号系统，侧栏入口为「设置」。

## 常用命令

- 开发：根目录 `npm run dev`（= `tauri dev`，自动起 vite :1420）
- 前端构建检查：`npm --prefix prototype run build`（tsc -b + vite build）
- 前端单测：`npm test`（= prototype 的 `vitest run`，测试文件与源码同目录 `*.test.ts`）
- Rust 检查：`cargo check` / `cargo test`（workdir `src-tauri/`）
- 打包：`npm run build:exe`

## 架构速览

- 前端无路由：`App.tsx` 按 `ViewKey` 条件渲染视图（home/new/tv/movies/anime/my-list/recent/later/settings）；弹层 = DetailModal / Theater。
- **片库注册表模式**：全局 `Title` 对象由 App 层 `registry`（state + localStorage `jj-title-cache`，防抖 800ms 写入）统一解析 `resolveTitle(id)`。豆瓣条目 id 形如 `db-{doubanId}`，搜索命中的播放源条目 id 形如 `ps-{sourceKey}-{vodId}`——**sourceKey 内的 `-` 转义为 `~`**，因此 id 中第一个 `-` 就是分隔符（DetailModal 据此反解）。合并按字段级进行：空值不覆盖已有数据。**无内置演示片库**：拉取失败显示错误 + 重试，首次用户「最近观看」等列表显示空状态引导。
- 豆瓣数据链路（详见 `.agents/notes/2026-10-30-douban-data-source.md`）：
  - 前端 `src/douban.ts`（类型 + invoke 封装 + Title 适配器）→ Rust 命令（`src-tauri/src/douban.rs`）。
  - 列表/搜索/详情优先官方域名，失败回退 `*.cmliussss.net` 反代；豆瓣图片走 `dbimg://` 协议代理（Windows 下 `http://dbimg.localhost/`，带 Referer 防盗链，仅放行 `*.doubanio.com`），播放源自带海报按源域名直连（CSP 已放行 http/https 图片）。
  - 列表缓存 `jj-feed-cache`（id + 各 part 游标 `offsets` + `exhausted`）；分类页支持服务端筛选（`douban_recommend`），筛选状态存 `jj-explore-filters`。
  - **无限瀑布流**：分类页滚动到底由 `BrowseView` 的 sentinel 触发 `loadFeedNext`（各 part 独立游标追加，追加结果回写缓存）。豆瓣请求失败返回 `null` 时不判定到底；连续 3 轮无新增才标记 exhausted。豆瓣 recommend 流翻页可能返回重复内容，属源行为。
- **播放源**（`src-tauri/resources/play-sources.json`，用户可用 `%APPDATA%/com.jianjie.desktop/play-sources.json` 覆盖）：
  - 7 个影视 CMS 源：dyttzy/ffzy 核心（时长指纹广告过滤）+ lzi/bfzy/jyzy/piaoling2 备用池；jszy 保持禁用（封皮错配）。广告过滤 `adFilter: safe` 内置于 jjstream 代理（`play_proxy.rs` 的 AD_KEYWORDS + 时长指纹 + 安全阈值）。
  - **搜索多页**：CMS 源按 `pagecount` 最多拉 4 页（修搜索结果不全）；搜索总预算 2.5s，慢源转后台写缓存。前端搜索 = 豆瓣联想 + 播放源全源并发聚合（`ps-` 条目注册进片库）。
- **jjstream 代理**（`play_proxy.rs`）：
  - URL 形如 `http://jjstream.localhost/{key}/{url}?k={token}`，token 每次启动随机生成（`play.rs::proxy_token`），无 token 请求一律 403。
  - HLS 播放列表重写 URI 全部走代理；按线路广告过滤（`adRules` 支持 `adDurationFingerprints`、`dropUniqueHostBlocks`、`dropShortBlocks`、`maxDropRatio`），HLS 广告源需强制走 jjstream 才生效。指纹只删命中分片，前后正片保留。
  - MP4 大文件按 16MB Range 分段回源（`bound_media_range`）；不分段会触发 64MB 缓冲上限返回 502，`<video>` 报 code 4。
  - SSRF 防护：域名黑名单 + 私网 IP 黑名单 + 自定义 DNS resolver 在连接层再次逐 IP 校验（`PublicDnsResolver`），关闭 DNS rebinding 窗口。
- **播放/换源规则**（`useHlsPlayer.ts` + `App.tsx` + `Theater.tsx`）：
  - probe 评分为速度主导（speed 0.7 / 稳定 0.2 / 质量 0.1），自动选最优线路；probe 只读详情缓存不发网络。
  - 自动换源仅三种触发：启动无帧（3s 代理重试 → 进度感知延长 → 换线/源）、单次冻结 60s、5 分钟内 ≥3 次真实（>1s）卡顿。亚秒抖动与用户 seek 引起的加载不计数。
  - **实时播放位置走 `liveTimeRef`**（Theater 每秒上报、不触发 React 渲染）；React state 里的 `playback.current` 仅按 5s 节流与关键节点更新。换集/换线时 Theater 通过 effect cleanup 快照旧集的 `episodeId/episodeIndex` 补发最终进度，App 按 episodeId 对账落库，防止旧集进度写到新集。
  - `preferredLine` 必须按 `detail.lines` 重新校验可播放，避免 probe 的旧索引选中网页线路。
- i18n：`i18n.tsx` 中 en/zh 双字典，新文案必须同时补两处。
- 持久化统一走 `lib.ts` 的 `usePersistentState`（key 前缀 `jj-`）。

## E2E

CDP 驱动真实窗口：设 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223` 后 `npm run dev`，用 playwright-core `chromium.connectOverCDP('http://127.0.0.1:9223')` 连接。页面滚动容器是 `.main-scroll`（不是 window）；豆瓣与播放源依赖真实网络。

## 约定

- 修改 `Title` 接口时注意 `douban.ts` / `play.ts` 适配器与 `content.ts` 翻译层的联动。
- 前端纯逻辑（匹配/评分/集数映射）改动须补 `*.test.ts`；Rust 关键解析（wire/播放列表/广告过滤）已有单测，改行为先改测试。
- 全局缓存/状态被 Rust 测试共享时用唯一 key（`unique_test_key`）。
