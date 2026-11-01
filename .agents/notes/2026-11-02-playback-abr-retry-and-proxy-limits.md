# Agent Note: 播放 ABR、重试定位与代理流式上限

Status: implemented

## Problem

- 稳定播放 5 秒后执行 `hls.nextLevel = topLevelIndex`；hls.js 的 `nextLevel` 是手动选级，会关闭 ABR，弱网时无法降码率。
- 手动“重试”只递增 `retryNonce`，没有更新 `playback.current`；`useHlsPlayer` 按本次播放起始位置 seek，40 分钟处出错会回到 0，并随后用 0 覆盖进度。
- jjstream 在无 Content-Length 的 chunked 响应上先 `response.bytes()` 全读再检查上限，存在 OOM 风险；播放/搜索响应也无限缓冲。
- 代理没有上游 Cookie，部分需要会话的 HLS 源会失败；没有并发上限。
- 4K/多码率 HLS 无法手动画质，且 UI 不暴露 hls levels。

## Decision

- 删除强制 `nextLevel` 升档；自动模式只设 `autoLevelCapping`，ABR 保持开启（[useHlsPlayer.ts](../../prototype/src/player/useHlsPlayer.ts)）。
- 手动画质用 `setLevel`：选具体高度时 `autoLevelCapping=-1` + `currentLevel`，Auto 时恢复 1080 上限并 `currentLevel=-1`；Theater 持久化高度并按新线路 levels 重新映射（[Theater.tsx](../../prototype/src/components/Theater.tsx)）。
- `retryPlayback` 优先使用 `autoRecover` 记录的故障位置，否则用 `liveCurrent()` 快照，写入 `playback.current` 后再触发 retryNonce（[App.tsx](../../prototype/src/App.tsx)）。
- 代理/播放响应改为 `chunk()` 流式读取，边读边检查 `MAX_*` 上限；搜索/详情 8MB、playlist 2MB、代理 media 64MB（[play_proxy.rs](../../src-tauri/src/play_proxy.rs)、[play.rs](../../src-tauri/src/play.rs)）。
- 代理与图片加 semaphore；代理 client 开启 cookie_store；图片响应补 Content-Length（[play_proxy.rs](../../src-tauri/src/play_proxy.rs)、[douban.rs](../../src-tauri/src/douban.rs)）。
- 时间/缓冲 UI 更新节流到 1Hz，pause/seeked/ended 立即同步，降低 Theater 重渲染。
- WebView2 中 `pictureInPictureEnabled` 为 true 但 `requestPictureInPicture()` 不生效；已移除 PiP 按钮，恢复前必须真实验证。

## Alternatives considered

**保留强制升档，改成一段时间后 `nextLevel=-1`。** 实现更绕，且升档本身没有产品收益；ABR 自己会升。
**只用手动 `currentLevel`，不维护 auto/cap。** 换集后需要重新映射，且用户切回 Auto 时容易忘记恢复上限；现在由持久化高度 + effect 处理。
**继续 `bytes()`，只检查 Content-Length。** chunked 或忽略 Range 的服务器没有长度，仍会 OOM。
**不加 Cookie。** 对当前源可能无影响，但属于已知兼容性缺口，成本很低。
**只做画质下拉，不处理换集。** 新线路 levels 索引不同，会选错档位；现在按高度映射。

## Consequences

- 手动选具体画质会关闭 ABR（用户显式选择，可接受）；回 Auto 才恢复自适应。
- 代理 semaphore 在高并发分片请求时会让部分请求排队，极端情况下首帧变慢，但内存可控。
- 流式上限会拒绝超大响应；错误会以 502/播放失败呈现，需要真实源验证阈值是否足够。
- Cookie store 是共享 jar（按域名隔离）；仍需要 mock/真实 Cookie 源验证。
- 本轮未重跑真实窗口 E2E；重试位置、画质切换、弱网降码率、Tauri 备份下载仍需真实环境验收。