# Agent Note: 搜索相关性、同名版本与 transient 注册表

Status: implemented

## Problem

- lzi/bfzy 的 CMS 搜索忽略 `wd`，对任意查询返回整站目录；前端原样展示，搜索页充斥无关影片，且这些条目会写入 `jj-title-cache`。
- 搜索结果按 `originalName || name` 合并，豆瓣对“三体”返回的 2022/2023/2028/2030 四个版本被压成一张卡。
- 源条目在搜索阶段就进入 registry，导致标题缓存被目录条目挤占。

## Decision

- 源结果先过 `matchesSearchQuery` + `isVariantSearchResult`，单源最多 30 条（[play.ts](../../prototype/src/play.ts)）。
- 搜索合并用 `mergeSearchResults`：豆瓣按 id 保留全部版本；源按 `normalizedName + year + mediaType` 去重（[play.ts](../../prototype/src/play.ts)）。
- 源条目不直接注册；先放 `transientTitlesRef`，只在打开详情、播放、加入片单/稍后/喜欢时 `register`（[App.tsx](../../prototype/src/App.tsx)）。
- 搜索增加 error/retry 状态；清缓存前用 pinned id 重建标题缓存（[SearchView.tsx](../../prototype/src/components/SearchView.tsx)、[BrowseView.tsx](../../prototype/src/components/BrowseView.tsx)）。
- 回归：`e2e/fixtures.mjs` 覆盖无关目录/解说过滤、四个同名版本可见、清缓存保留片单。

## Alternatives considered

**只在播放链路过滤，搜索页保持原样。** 目录仍会污染用户认知与标题缓存，且搜索页是用户找片入口。
**按名称去重。** 会隐藏同名翻拍/同名电影剧集，正是本次要修的问题。
**搜索即注册全部源条目。** 标题缓存 2MB 预算会被目录占满，挤掉首页与最近观看。
**清缓存时清掉全部本地数据。** 解决孤立 id，但会让片单/进度丢失，违背“清缓存”语义。

## Consequences

- 非片名搜索（演员、英文别名）对应的源结果可能被过滤掉，由豆瓣联想兜底。
- 后端仍会向忽略 `wd` 的源请求目录页；UI/缓存污染已消除，但网络成本仍在，后续可加搜索能力检测。
- 任何新的搜索结果入口都必须同步写入 transient map，且 open/play/list 三条路径都要注册，否则会出现“能看见但点不开/片单空白”。