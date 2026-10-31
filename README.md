<div align="center">
  <img src="docs/assets/logo.svg" width="72" height="72" alt="SeeWorld" />
  <h1>SEEWORLD · 见界</h1>
  <p><strong>见世界，见边界。</strong><br />
  A quiet, private cinema for Windows.</p>
  <img src="docs/assets/tech-stack.png" width="640" alt="Tauri 2 / React 19 / TypeScript / Rust / Windows" />
</div>

见界是一款面向 Windows 的私人影院桌面应用。它用豆瓣做发现与元数据，聚合多个影视 CMS 源，自动探测最优线路，把播放、片单和偏好收进一块安静的暗色界面。无需注册，打开即看。

## 特性

- **发现** — 豆瓣实时榜单、分类筛选与联想搜索；首页精选、热门新片、剧集、电影、动漫分区浏览。
- **一处片库** — 豆瓣条目与播放源条目统一注册为 `Title`，详情、续看、我的片单与最近观看互不割裂。
- **播放即最优** — 多线路并发探测，MP4 直链与 H.264 优先；启动无帧、长时间冻结或频繁卡顿时自动换线换源。
- **干净的画面** — `jjstream` 代理按线路剔除广告分片，HLS 广告源同样生效；大文件 MP4 按 16 MB Range 分段回源。
- **没有账号** — 无边框暗色影院界面，中英双语；偏好、片单、进度全部只留在本机。

## 工作方式

1. **发现** — 豆瓣列表、详情与搜索经 Rust 命令取回，统一适配为 `Title`，写入前端片库注册表。
2. **取流** — 各 CMS 源并发搜索、拉取详情与线路，按速度、稳定性与质量探测出可播线路。
3. **播放** — HLS / MP4 经 `jjstream` 代理去除广告分片、按需分段回源，再交给 hls.js 播放。

## 技术栈

| 层 | 选型 | 职责 |
| :--- | :--- | :--- |
| 桌面壳 | Tauri 2 · Rust | 原生窗口、命令调用、`dbimg://` 与 `jjstream://` 协议 |
| 界面 | React 19 · TypeScript · Vite | 视图状态机、海报流、双语与本地持久化 |
| 播放 | hls.js · HTML5 Video | HLS / MP4 统一播放与进度 |
| 数据 | 豆瓣 · 影视 CMS | 元数据与播放源 |
| 代理 | Rust · reqwest | 防盗链图片、流代理、广告过滤与 Range 回源 |

前端不使用路由，`App.tsx` 按 `ViewKey` 渲染视图；后端按数据域拆分为 `douban`、`play`、`play_proxy` 三个模块。

## 开始

环境：Windows 10 / 11、Node.js 20+、Rust（仓库固定 1.94.0）、WebView2 Runtime（Windows 11 已内置）。

```bash
npm install
npm --prefix prototype install

npm run dev          # Tauri + Vite，热更新
npm run build:exe    # 构建免安装可执行文件
```

前端类型检查与构建：

```bash
npm --prefix prototype run build
```

## 配置

- 播放源注册表位于 `src-tauri/resources/play-sources.json`；可在 `%APPDATA%\com.jianjie.desktop\play-sources.json` 放置同名文件覆盖。
- 图片统一经 `dbimg://` 代理并附带 Referer，避免豆瓣图片防盗链失效。

## 项目结构

```text
.
├─ prototype/                 React 19 + Vite 界面
│  ├─ src/components/         首页、分类、详情、Theater 等视图
│  ├─ src/player/             hls.js 播放、自动换源与进度
│  ├─ src/douban.ts           豆瓣数据与 Title 适配
│  └─ src/play.ts             播放源命令封装
├─ src-tauri/
│  ├─ src/douban.rs           豆瓣接口与图片代理
│  ├─ src/play.rs             CMS 搜索、详情与线路探测
│  ├─ src/play_proxy.rs       jjstream 流代理与广告过滤
│  └─ resources/              播放源注册表
└─ docs/                      截图与文档资源
```

## 说明

- 仅支持 Windows 10 / 11，首次启动依赖 WebView2 Runtime。
- 本项目不提供、不存储、不分发任何影视内容。元数据来自豆瓣，播放地址由第三方公开接口提供，可用性取决于源站。
- 代码仅供个人学习与技术研究，请支持正版。仓库暂未附带开源许可证。

## 致谢

[Tauri](https://tauri.app) · [React](https://react.dev) · [hls.js](https://github.com/video-dev/hls.js) · 豆瓣及所有公开数据源。

<div align="center"><sub>SEEWORLD — 见世界，见边界。</sub></div>
