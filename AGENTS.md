# SeeWorld（jianjie-desktop）

Tauri 2 桌面应用：Rust 后端 + React 19 / Vite 前端（`prototype/`），Windows 无边框暗色影院 UI。品牌 **SeeWorld**（标志为红色 S，任务栏图标同款）；无账号系统，侧栏入口为「设置」。

## 常用命令

- 开发：根目录 `npm run dev`（= `tauri dev`，自动起 vite :1420）
- 前端构建检查：`npm --prefix prototype run build`（tsc -b + vite build）
- Rust 检查：`cargo check`（workdir `src-tauri/`）
- 打包：`npm run build:exe`

## 架构速览

- 前端无路由：`App.tsx` 按 `ViewKey` 条件渲染视图（home/new/tv/movies/anime/my-list/recent/later/downloads/settings）；弹层 = DetailModal / Theater。
- **片库注册表模式**：全局 `Title` 对象由 App 层 `registry`（state + localStorage `jj-title-cache`）统一解析 `resolveTitle(id)`。豆瓣条目 id 形如 `db-{doubanId}`，搜索命中的播放源条目 id 形如 `ps-{sourceKey}-{vodId}`（写入 match 缓存后点开即播）。新数据源一律转换为 `Title` 后注册，不要绕过。**无内置演示片库**：拉取失败显示错误 + 重试，首次用户「最近观看」等列表显示空状态引导。
- 豆瓣数据链路（详见 `.agents/notes/2026-10-30-douban-data-source.md`）：
  - 前端 `src/douban.ts`（类型 + invoke 封装 + Title 适配器）→ Rust 命令（`src-tauri/src/douban.rs`）。
  - 列表/搜索/详情优先官方域名，失败回退 `*.cmliussss.net` 反代；图片一律走 `dbimg://` 协议代理（带 Referer 防盗链）。
  - 列表缓存 `jj-feed-cache`；分类页支持服务端筛选（`douban_recommend`），筛选状态存 `jj-explore-filters`。
  - **无限瀑布流**：分类页滚动到底由 `BrowseView` 的 sentinel 触发 `loadFeedNext`（各 part 独立游标追加，无新增即判定到底并移除 sentinel）。豆瓣 recommend 流翻页可能返回重复内容，属源行为。
- **播放源**（`src-tauri/resources/play-sources.json`，用户可用 `%APPDATA%/com.jianjie.desktop/play-sources.json` 覆盖）：
  - 7 个影视 CMS 源（dyttzy/ffzy 核心 + lzi/bfzy/jyzy/piaoling2 备用池）+ 1 个动漫聚合源 `anich`；jszy 保持禁用（封皮错配）。广告过滤 `adFilter: safe` 内置于 jjstream 代理（`play_proxy.rs` 的 AD_KEYWORDS + 安全阈值）。
  - **anich 聚合动漫源**（`src-tauri/src/anich.rs`，接口按新版客户端 `anich Windows 1.5.27` 校准）：搜索/详情/剧集为 protobuf（本文件内手写 wire-format 解码），**`/vod/` 返回 JSON 整数数组（内容是 protobuf 字节，先还原再解析）**，每条线路含 `source`/`info`；播放直链解码 = 删除字符串第 4 个字符后 base64。`play_resolve` 对每集拉取全部线路并**并发探测选优：MP4 直链优先、H.264 优先**，HLS 会拒绝图片分片广告与时长明显不符的播放列表，返回的 `format` 必须与真实容器一致（mp4/hls）。API 入口 sends 优先；DoH 解析后多 IP 并发竞速（Cloudflare 常有一个 IP 的 HTTPS 黑洞）。**该源域名在国内通常需要代理**：设置页「网络代理」→ `set_network_proxy` 命令（仅作用于 anich 请求）。
  - **按线路广告过滤**：`play_proxy.rs` 的 `adRules` 支持 `adDurationFingerprints`（精确分片时长指纹）、`dropUniqueHostBlocks`、`dropShortBlocks`、`maxDropRatio`。已按线路校准：dyttzy = 赌场广告 5 段指纹 `5.567/2.933/5.7/3.333/1.533`；ffzy = 6 段指纹 `4.867/3.333/6.367/2.1/2.967/3.879`；lzi = 异目录中插块；bfzy = `adjump` 关键词。HLS 广告源需强制走 jjstream 才生效；指纹只删命中分片，前后正片保留。piaoling2/jyzy 的广告是内嵌画面/角标，无法从播放列表安全剔除，动漫优先 AniCh。
  - **搜索多页**：CMS 源按 `pagecount` 最多拉 4 页（修搜索结果不全）；前端搜索 = 豆瓣联想 + 播放源全源并发聚合（`ps-` 条目注册进片库）。
- **播放/换源规则**（`useHlsPlayer.ts` + `App.tsx`）：
  - 动漫匹配强制优先 AniCh（`isAnimeTitle`；非 AniCh 的 match 缓存直接丢弃并重搜）；`preferredLine` 必须按 `detail.lines` 重新校验可播放，避免 probe 的旧索引选中网页线路。
  - probe 评分为速度主导（speed 0.7 / 稳定 0.2 / 质量 0.1），自动选最优线路。
  - MP4 大文件经 jjstream 代理时按 16MB Range 分段回源（`play_proxy.rs::bound_media_range`）；不分段会触发 64MB 缓冲上限返回 502，`<video>` 报 code 4。
  - 自动换源仅三种触发：启动无帧（3s 代理重试 → 进度感知延长 → 换线/源）、单次冻结 60s、**5 分钟内 ≥3 次真实（>1s）卡顿**。亚秒抖动与用户 seek 引起的加载不计数。
- **弹幕**：动漫播放时按集拉取（`anich::anime_danmaku` = AniCh 自建源 + B 站代理聚合，需先有 detail 缓存 `anich:sites:{id}`），`DanmakuLayer.tsx` 用 canvas 渲染（滚动/顶部/底部），开关在设置页（`jj-danmaku-on`）。CMS 源返回空数组，层自动隐藏。
- **详情集名**：DetailModal 打开时通过 match 缓存调 `playDetail`，用源站真实集名/简介覆盖豆瓣占位数据。
- i18n：`i18n.tsx` 中 en/zh 双字典，新文案必须同时补两处。
- 持久化统一走 `lib.ts` 的 `usePersistentState`（key 前缀 `jj-`）。

## 约定

- 修改 `Title` 接口时注意 `douban.ts` / `play.ts` 适配器与 `content.ts` 翻译层的联动。
- anich 的 protobuf 解码是手写 wire-format，字段号与 AniCh 上游 schema 对应（见 `anich.rs` 注释）；上游若改协议需同步。
- E2E：CDP（`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223`）+ playwright-core 驱动真实窗口；页面滚动容器是 `.main-scroll`（不是 window）。
