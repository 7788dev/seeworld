# 决策：豆瓣数据与多源播放接入

日期：2026-10-30 · 更新：2026-10-31 · 状态：已实施

## 背景

最初为硬编码演示数据的 Netflix 风格原型。目标是把「发现 → 详情 → 播放」做成真实链路：豆瓣负责元数据，播放源负责可播放地址，并保证失败时明确报错而不是回退演示数据。

## 数据链路

前端 `douban.ts`（类型 + invoke 封装 + Title 适配器）→ Rust `douban.rs`。

- 列表/搜索/详情优先官方域名，失败回退 `*.cmliussss.net` 反代。
- 图片统一经 `dbimg://` 代理并带 Referer；卡片用 `m_ratio_poster`，hero/详情用 `l_ratio_poster`。
- 缓存：Rust 内存缓存（列表/搜索 10 分钟、详情 24 小时）；前端 `jj-feed-cache`（5 分钟 TTL，首页启动刷新）。
- 拉取失败显示错误与重试；不再内置演示片库。

## 播放链路

- 7 个影视 CMS 源 + AniCh 动漫聚合，注册在 `src-tauri/resources/play-sources.json`，可用 `%APPDATA%/com.jianjie.desktop/play-sources.json` 覆盖。
- 搜索全源并发聚合；详情与线路并发探测，按速度/稳定性/质量评分，MP4 直链与 H.264 优先。
- HLS/MP4 经 `jjstream` 代理；按线路过滤广告（时长指纹、关键词、短分片），MP4 大文件按 16MB Range 分段回源。
- 动漫优先 AniCh；弹幕按集聚合 AniCh 与 B 站弹幕，Canvas 渲染。
- 自动换源仅三种触发：启动无帧、单次冻结 60 秒、5 分钟内 ≥3 次真实卡顿。

## 备选与取舍

- frodo 移动端 API 需要已失效的公开 key；详情页 HTML 解析被风控；前端直连豆瓣受 CORS/Referer 拦截；图片无 Referer 返回 418。以上方案均弃用。

## 遗留

- top250 无官方 JSON API。
- 片库注册表超过 localStorage 配额时的裁剪策略仍可细化。
- AniCh 上游协议变动需同步手写 protobuf 解码与 UA。
