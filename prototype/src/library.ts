import type { Title } from './data'

const mergedEpisodesCount = (existing?: number, incoming?: number) => {
  if (incoming === undefined) return existing
  if (existing === undefined) return incoming
  return Math.max(existing, incoming)
}

/**
 * 合并同一 id 的 Title。
 *
 * 规则：空值不覆盖已有数据；集数取较大值（连载剧集只增不减）；
 * 详情来源的评分/票数/匹配度允许刷新。返回 null 表示没有可改进的字段，
 * 调用方可以据此避免无意义的 registry 更新与整库序列化。
 */
export function mergeRegisteredTitle(existing: Title, incoming: Title): Title | null {
  const episodesCount = mergedEpisodesCount(existing.episodesCount, incoming.episodesCount)
  const ratingChanged =
    incoming.doubanRating !== undefined && incoming.doubanRating !== existing.doubanRating
  const votesChanged =
    incoming.doubanVotes !== undefined && incoming.doubanVotes !== existing.doubanVotes
  const matchChanged = incoming.match > 0 && incoming.match !== existing.match

  const improves =
    (Boolean(incoming.synopsis) && !existing.synopsis) ||
    (incoming.cast.length > 0 && existing.cast.length === 0) ||
    (incoming.genres.length > 0 && existing.genres.length === 0) ||
    (Boolean(incoming.episodes?.length) && !existing.episodes?.length) ||
    (Boolean(incoming.poster) && !existing.poster) ||
    (Boolean(incoming.hero) && !existing.hero) ||
    (Boolean(incoming.originalName) && !existing.originalName) ||
    (Boolean(incoming.region) && !existing.region) ||
    (Boolean(incoming.pubdate) && !existing.pubdate) ||
    (Boolean(incoming.creator) && !existing.creator) ||
    (incoming.year > 0 && existing.year === 0) ||
    episodesCount !== existing.episodesCount ||
    ratingChanged ||
    votesChanged ||
    matchChanged

  if (!improves) return null

  return {
    ...existing,
    ...incoming,
    name: incoming.name || existing.name,
    originalName: incoming.originalName || existing.originalName,
    synopsis: incoming.synopsis || existing.synopsis,
    poster: incoming.poster || existing.poster,
    hero: incoming.hero || existing.hero,
    creator: incoming.creator || existing.creator,
    region: incoming.region || existing.region,
    pubdate: incoming.pubdate || existing.pubdate,
    duration: incoming.duration || existing.duration,
    cast: incoming.cast.length > 0 ? incoming.cast : existing.cast,
    genres: incoming.genres.length > 0 ? incoming.genres : existing.genres,
    episodes: incoming.episodes?.length ? incoming.episodes : existing.episodes,
    year: incoming.year > 0 ? incoming.year : existing.year,
    match: incoming.match > 0 ? incoming.match : existing.match,
    doubanRating: incoming.doubanRating ?? existing.doubanRating,
    doubanVotes: incoming.doubanVotes ?? existing.doubanVotes,
    episodesCount,
  }
}