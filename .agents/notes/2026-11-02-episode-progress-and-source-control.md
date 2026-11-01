# Agent Note: 每集进度、播放源启停与分 feed 缓存

Status: implemented

## Problem

- `jj-progress` 每个标题只存一条当前集；切回上一集会从 0 开始，旧集进度无法复用。
- 设置页不能启停播放源，用户只能手改 `%APPDATA%/com.jianjie.desktop/play-sources.json`；用 serde 反序列化再整体写回会丢未知字段。
- feed 缓存是单个 `jj-feed-cache` 对象，追加一页会重写所有分类的 ids/offsets。

## Decision

- 保留标题级 `jj-progress`（最近观看/续播/清空语义），新增 `jj-episode-progress`：`titleId → episodeId → PlaybackProgress`；显式点集优先读该集，缺失时回退标题级同集记录（[App.tsx](../../prototype/src/App.tsx)）。
- 60s 落库与关闭/隐藏 flush 同时写两个 key；清观看记录同时清 `jj-progress` 与 `jj-episode-progress`（[BrowseView.tsx](../../prototype/src/components/BrowseView.tsx)）。
- 源启停命令 `play_set_source_enabled` 读用户 JSON 为 `serde_json::Value`，只插入/更新目标源的 `enabled`；不存在的源才追加完整 SourceConfig。写后立即清空 config cache（[play.rs](../../src-tauri/src/play.rs)）。
- feed 缓存改为 `jj-feed-cache:{feedKey}` 每分类独立 key；读取兼容旧单 key，清缓存同时清理前缀 key（[App.tsx](../../prototype/src/App.tsx)、[BrowseView.tsx](../../prototype/src/components/BrowseView.tsx)）。
- 设置页新增备份导出/导入（白名单 key，包含标题缓存与每集进度）和本地数据大小显示；导出由 Rust `export_backup` 写系统下载目录并返回路径，不使用浏览器 `<a download>`，避免 WebView2 原生下载提示。

## Alternatives considered

**只存每集进度，去掉标题级进度。** 最近观看、继续观看、卡片进度条都依赖标题级当前集，会大改 UI 与迁移。
**把每集进度塞进标题级对象里。** 现有 `PlaybackProgress` 和卡片读取逻辑都要改；独立 key 迁移更安全。
**用 serde 反序列化 SourceConfig 再整体写回。** 会丢掉用户手写的 note/未知字段，违反可覆盖配置的承诺。
**继续单 key feed 缓存。** 实现简单但滚动时写放大，且一个分类损坏会丢所有分类。

## Consequences

- `jj-episode-progress` 会随观看集数增长；当前没有按时间裁剪，长期使用需要加容量上限或归档策略。
- 旧版本只有标题级进度：显式点集会回退标题级同集记录，但不能恢复更早集的历史。
- `play_set_source_enabled` 与备份下载都需要在真实 Tauri 窗口验收：WebView2 下载行为、配置文件保留字段、切换后搜索/代理立即生效。
- 备份导入是白名单覆盖，不会导入 feed/match 缓存；换机后首次列表仍需重新拉取。