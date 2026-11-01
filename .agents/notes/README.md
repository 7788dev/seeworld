# Agent Notes

这里只放影响项目的持久决策：为什么这样做、放弃了什么。代码本身能自解释的实现细节不单独成文。

## 决策索引

- [豆瓣数据与多源播放接入](2026-10-30-douban-data-source.md)
- [搜索相关性、同名版本与 transient 注册表](2026-11-02-search-relevance-and-transient-registry.md)
- [每集进度、播放源启停与分 feed 缓存](2026-11-02-episode-progress-and-source-control.md)
- [播放 ABR、重试定位与代理流式上限](2026-11-02-playback-abr-retry-and-proxy-limits.md)
- [GitHub 自动构建与 Release 发布](2026-11-02-github-release-pipeline.md)

## 何时写

- 拍板选库、架构、协议、目录或有取舍的 UI 行为：写 `implemented` note，并链接关键代码路径。
- 方案讨论后被否决：写 `rejected` note，说明否决理由。
- 同一问题/同一流程第二次出现：优先更新已有 note，或在根 `AGENTS.md` 加 1–3 行规则并链接理由。
- 机械小改、纯样式调整、代码已自解释的实现：不写。
- 一个事实只写一处；已有 note 覆盖时更新它，不重复建档。

## 格式

```markdown
# Agent Note: <标题>

Status: implemented | proposed | rejected | archived

## Problem
<不看答案也能读懂的矛盾/约束>

## Decision
<已落地事实，现在时，链接关键代码>

## Alternatives considered
**方案。** 为什么输。

## Consequences
<代价、买到了什么、仍需验证什么>
```

proposed note 使用 `Problem / Proposal / Alternatives considered / Acceptance criteria / Risks`。日期用首次提出日，文件名 `yyyy-mm-dd-topic.md`。

## 维护

- 跨文件引用一律相对链接；移动文件时修复入链与 Status。
- 过期 note 移入 `archived/`，冻结正文；删除前检查未提交的唯一记录与入链。
- 根指南保持 < 100 行；细节放 note，根指南只留规则与链接。