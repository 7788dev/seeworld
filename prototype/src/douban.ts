import { invoke } from '@tauri-apps/api/core'
import type { Episode, MediaType, Title, ViewKey } from './data'
import { isDesktopApp } from './lib'

export interface DbSubject {
  id: string
  title: string
  cover: string
  rate: string
  url: string
  isNew: boolean
  episodesInfo: string
}

export interface DbSuggest {
  id: string
  title: string
  subTitle: string
  img: string
  year: string
  episode: string
  kind: string
  url: string
}

export type ExploreSort = 'T' | 'U' | 'R' | 'S'

export interface ExploreValues {
  form: string
  genre: string
  region: string
  year: string
  minRating: number
  sort: ExploreSort
}

export interface DbRecommend {
  id: string
  title: string
  kind: string
  year: string
  cover: string
  hero: string
  rating: number
  votes: number
  genres: string[]
  region: string
  creator: string
  cast: string[]
  episodesInfo: string
}

export interface DbDetail {
  id: string
  title: string
  originalTitle: string
  kind: string
  year: string
  rating: number
  votes: number
  genres: string[]
  actors: string[]
  directors: string[]
  intro: string
  picLarge: string
  picNormal: string
  durations: string[]
  episodesCount: number
  pubdate: string[]
  countries: string[]
  aka: string[]
  cardSubtitle: string
}

export interface DoubanFeedPart {
  kind: 'tv' | 'movie'
  tag: string
  limit: number
  sort?: 'recommend' | 'time' | 'rank'
}

export interface FeedState {
  ids: string[]
  loading: boolean
  error: boolean
  /// 请求成功但确实没有内容；与“加载失败”区分，避免空态被当成故障。
  empty?: boolean
  /// 部分 part/源失败但仍有内容。
  partial?: boolean
  exhausted?: boolean
}

export const DOUBAN_FEEDS: Record<string, DoubanFeedPart[]> = {
  home: [
    { kind: 'movie', tag: '热门', limit: 12 },
    { kind: 'tv', tag: '热门', limit: 12 },
  ],
  new: [
    { kind: 'movie', tag: '热门', limit: 25, sort: 'time' },
    { kind: 'tv', tag: '热门', limit: 25, sort: 'time' },
  ],
  tv: [{ kind: 'tv', tag: '热门', limit: 50 }],
  movies: [{ kind: 'movie', tag: '热门', limit: 50 }],
  anime: [
    { kind: 'tv', tag: '日本动画', limit: 25 },
    { kind: 'movie', tag: '动画', limit: 25 },
  ],
}

const isWindowsWebview = () =>
  typeof navigator !== 'undefined' && /windows/i.test(navigator.userAgent)

// Unwraps any dbimg proxy form so callers can safely re-proxy already-cached URLs.
export const unwrapDbImg = (url: string) => {
  if (!url) return ''
  const prefix = url.startsWith('http://dbimg.localhost/')
    ? 'http://dbimg.localhost/'
    : url.startsWith('https://dbimg.localhost/')
      ? 'https://dbimg.localhost/'
      : url.startsWith('dbimg://')
        ? 'dbimg://'
        : null
  if (!prefix) return url
  let rest = url.slice(prefix.length)
  if (prefix === 'dbimg://' && rest.startsWith('localhost/')) {
    rest = rest.slice('localhost/'.length)
  }
  if (rest.startsWith('http://') || rest.startsWith('https://')) return rest
  try {
    const decoded = decodeURIComponent(rest)
    return /^https?:\/\//i.test(decoded) ? decoded : `https://${decoded}`
  } catch {
    return rest
  }
}

export const dbImg = (url: string) => {
  const source = unwrapDbImg(url)
  if (!source || !isDesktopApp) return source
  if (isWindowsWebview()) return `http://dbimg.localhost/${encodeURIComponent(source)}`
  return `dbimg://${source.replace(/^https?:\/\//i, '')}`
}

export const dbCardImg = (url: string) =>
  dbImg(unwrapDbImg(url).replace(/\/s_ratio_poster\//, '/m_ratio_poster/'))

export const dbHeroImg = (url: string) =>
  dbImg(unwrapDbImg(url).replace(/\/(?:s|m)_ratio_poster\//, '/l_ratio_poster/'))

export const dbStillImg = (url: string) =>
  dbImg(unwrapDbImg(url).replace('/photo/m/public/', '/photo/l/public/'))

// 播放源常用豆瓣图床；只有 doubanio 域名能走 dbimg 代理，其他域名保持原直链。
export const sourcePoster = (url: string) => {
  if (!url) return ''
  const raw = unwrapDbImg(url)
  const absolute = raw.startsWith('//') ? `https:${raw}` : raw
  try {
    const host = new URL(absolute).hostname
    if (host === 'doubanio.com' || host.endsWith('.doubanio.com')) return dbCardImg(absolute)
  } catch {
    // keep the original URL when it is not parseable
  }
  return absolute
}

export const placeholderEpisodes = (
  baseId: string,
  count: number,
  runtime = '45m',
): Episode[] =>
  Array.from({ length: Math.min(Math.max(0, count), 200) }, (_, index) => ({
    id: `${baseId}-s1e${index + 1}`,
    season: 1,
    number: index + 1,
    name: `E${index + 1}`,
    runtime,
    synopsis: '',
  }))

/// 占位剧集按需生成：启动时若为每个缓存剧集都同步生成最多 200 集，
/// 大量剧集条目会拖慢首屏。缓存只需保留 episodesCount，真正打开详情/播放时再展开。
const lazyEpisodes = new WeakMap<Title, Episode[]>()

export const episodesOf = (title: Title): Episode[] => {
  if (title.episodes?.length) return title.episodes
  if (title.mediaType !== 'series' || !title.episodesCount) return []
  const cached = lazyEpisodes.get(title)
  if (cached) return cached
  const episodes = placeholderEpisodes(title.id, title.episodesCount, title.duration ?? '45m')
  lazyEpisodes.set(title, episodes)
  return episodes
}

const rateToNumber = (rate: string) => {
  const value = Number.parseFloat(rate)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

const splitTitleLines = (name: string): string[] => {
  if (name.length <= 10) return [name]
  const mid = Math.ceil(name.length / 2)
  return [name.slice(0, mid), name.slice(mid)]
}

export const normalizeDuration = (raw?: string) => {
  if (!raw) return undefined
  const hours = /(\d+)\s*小时/.exec(raw)?.[1]
  const minutes = /(\d+)\s*分钟/.exec(raw)?.[1]
  if (hours && minutes) return `${hours}h ${minutes}m`
  if (hours) return `${hours}h`
  if (minutes) return `${minutes}m`
  return undefined
}

const call = async <T,>(command: string, args: Record<string, unknown>): Promise<T | null> => {
  if (!isDesktopApp) return null
  try {
    console.info(`[jj] invoke ${command}`, args)
    const result = await invoke<T>(command, args)
    console.info(`[jj] invoke ${command} ok`, Array.isArray(result) ? `(${result.length} items)` : '')
    return result
  } catch (error) {
    console.warn(`[jj] invoke ${command} failed`, error)
    return null
  }
}

export const fetchDoubanList = (
  kind: 'tv' | 'movie',
  tag: string,
  limit = 24,
  start = 0,
  sort: DoubanFeedPart['sort'] = 'recommend',
) => call<DbSubject[]>('douban_list', { kind, tag, limit, start, sort })

export const fetchDoubanSuggest = (q: string) => call<DbSuggest[]>('douban_suggest', { q })

export const fetchDoubanDetail = (id: string, kind?: 'tv' | 'movie') =>
  call<DbDetail>('douban_detail', { id, kind })

export const subjectToTitle = (subject: DbSubject, kind: 'tv' | 'movie'): Title => {
  const rating = rateToNumber(subject.rate)
  const name = subject.title
  return {
    id: `db-${subject.id}`,
    name,
    mediaType: kind === 'tv' ? 'series' : 'film',
    year: 0,
    ageRating: '',
    match: rating ? Math.round(rating * 10) : 0,
    doubanRating: rating,
    genres: [],
    synopsis: '',
    poster: dbCardImg(subject.cover),
    hero: dbHeroImg(subject.cover),
    titleStyle: 'condensed',
    titleLines: splitTitleLines(name),
    cardTitleSize: 'sm',
    language: '',
    creator: '',
    cast: [],
    isNew: subject.isNew,
    addedOrder: 0,
    episodesCount: episodeCountFrom(subject.episodesInfo),
  }
}

export const suggestToTitle = (item: DbSuggest): Title => {
  const rating = 0
  const episodeCount = Number.parseInt(item.episode, 10)
  const isSeries = Number.isFinite(episodeCount) && episodeCount > 0
  const year = Number.parseInt(item.year, 10)
  return {
    id: `db-${item.id}`,
    name: item.title,
    mediaType: isSeries ? 'series' : 'film',
    year: Number.isFinite(year) ? year : 0,
    ageRating: '',
    match: rating,
    // suggest 的 sub_title 是"类型/年份"元信息而非原名,写进去会污染名称匹配与去重。
    genres: [],
    synopsis: '',
    poster: dbCardImg(item.img),
    hero: dbHeroImg(item.img),
    titleStyle: 'condensed',
    titleLines: splitTitleLines(item.title),
    cardTitleSize: 'sm',
    language: '',
    creator: '',
    cast: [],
    addedOrder: 0,
  }
}

export const fetchDoubanRecommend = (
  form: 'movie' | 'tv',
  tags: string[],
  sort: ExploreSort,
  minRating: number,
  start = 0,
  count = 48,
) =>
  call<DbRecommend[]>('douban_recommend', {
    form,
    tags,
    sort,
    minRating,
    start,
    count,
  })

const episodeCountFrom = (raw: string) => {
  const match = /(\d+)\s*集/.exec(raw)
  const count = match ? Number.parseInt(match[1], 10) : 0
  return count > 0 ? count : undefined
}

export const recommendToTitle = (item: DbRecommend): Title => {
  const rating = item.rating > 0 ? item.rating : undefined
  const year = Number.parseInt(item.year, 10)
  return {
    id: `db-${item.id}`,
    name: item.title,
    mediaType: item.kind === 'tv' ? 'series' : 'film',
    year: Number.isFinite(year) ? year : 0,
    ageRating: '',
    match: rating ? Math.round(rating * 10) : 0,
    doubanRating: rating,
    doubanVotes: item.votes > 0 ? item.votes : undefined,
    genres: item.genres,
    synopsis: '',
    poster: dbCardImg(item.cover),
    hero: dbStillImg(item.hero || item.cover),
    region: item.region || undefined,
    creator: item.creator,
    cast: item.cast,
    titleStyle: 'condensed',
    titleLines: splitTitleLines(item.title),
    cardTitleSize: 'sm',
    language: '',
    addedOrder: 0,
    isNew: false,
    episodesCount: episodeCountFrom(item.episodesInfo),
  }
}

export const exploreRequests = (
  view: ViewKey,
  values: ExploreValues,
): { endpoint: 'movie' | 'tv'; tags: string[] }[] => {
  if (view !== 'new' && view !== 'tv' && view !== 'movies' && view !== 'anime') return []
  const baseTags = [values.genre, values.region, values.year].filter(
    (tag) => tag.trim().length > 0,
  )
  const anime = view === 'anime' || values.form === 'anime'
  const tags = anime ? ['动画', ...baseTags] : baseTags
  if (view === 'movies') return [{ endpoint: 'movie', tags }]
  if (view === 'tv') {
    // 通用 tag 接口没有独立的“剧集/综艺”布尔参数；综艺通过类型 tag 表达。
    const tvTags = values.form === 'variety' ? ['综艺', ...baseTags] : baseTags
    return [{ endpoint: 'tv', tags: tvTags }]
  }
  if (view === 'anime') {
    if (values.form === 'series') return [{ endpoint: 'tv', tags }]
    if (values.form === 'film') return [{ endpoint: 'movie', tags }]
    return [
      { endpoint: 'movie', tags },
      { endpoint: 'tv', tags },
    ]
  }
  if (values.form === 'movie') return [{ endpoint: 'movie', tags }]
  if (values.form === 'tv') return [{ endpoint: 'tv', tags }]
  if (values.form === 'anime') {
    return [
      { endpoint: 'movie', tags },
      { endpoint: 'tv', tags },
    ]
  }
  return [
    { endpoint: 'movie', tags },
    { endpoint: 'tv', tags },
  ]
}

export interface ExplorePage {
  items: Title[]
  error: boolean
  offsets: number[]
  exhausted: boolean
}

export const fetchExploreTitles = async (
  view: ViewKey,
  values: ExploreValues,
  offsets: number[] = [],
  count = 48,
): Promise<ExplorePage> => {
  const requests = exploreRequests(view, values)
  if (requests.length === 0) {
    return { items: [], error: false, offsets: [], exhausted: true }
  }
  const starts = requests.map((_, index) => offsets[index] ?? 0)
  const results = await Promise.all(
    requests.map((request, index) =>
      fetchDoubanRecommend(
        request.endpoint,
        request.tags,
        values.sort,
        values.minRating,
        starts[index],
        count,
      ),
    ),
  )
  const nextOffsets = [...starts]
  const exhaustedFlags: boolean[] = []
  const buckets = results.map((items, index) => {
    if (items === null) {
      // 失败的分页保留原游标，下一次重试同一页，而不是跳过。
      exhaustedFlags[index] = false
      return []
    }
    nextOffsets[index] = starts[index] + items.length
    exhaustedFlags[index] = items.length < count
    return items.map(recommendToTitle)
  })
  const seen = new Set<string>()
  const merged: Title[] = []
  const longest = buckets.reduce((max, bucket) => Math.max(max, bucket.length), 0)
  for (let index = 0; index < longest; index += 1) {
    for (const bucket of buckets) {
      const title = bucket[index]
      if (!title || seen.has(title.id)) continue
      seen.add(title.id)
      merged.push(title)
    }
  }
  const allFailed = results.every((result) => result === null)
  return {
    items: merged,
    error: allFailed,
    offsets: nextOffsets,
    exhausted: !allFailed && exhaustedFlags.every(Boolean),
  }
}

export const applyDetail = (base: Title, detail: DbDetail): Title => {
  const mediaType: MediaType = detail.kind === 'tv' ? 'series' : 'film'
  const duration = normalizeDuration(detail.durations[0])
  const rating = detail.rating > 0 ? detail.rating : base.doubanRating
  const posterSource = detail.picLarge || detail.picNormal || base.poster || ''
  const heroSource = detail.picLarge || detail.picNormal || base.hero || ''
  // 剧集数交给 episodesCount，由 episodesOf 按需展开，避免详情一到
  // 就在注册表里生成几十上百个占位对象。
  const episodes: Episode[] =
    mediaType === 'series' && detail.episodesCount > 0 ? [] : (base.episodes ?? [])
  const year = Number.parseInt(detail.year, 10)
  return {
    ...base,
    name: detail.title || base.name,
    originalName: detail.originalTitle || base.originalName,
    mediaType,
    ageRating: '',
    year: Number.isFinite(year) ? year : base.year,
    match: rating ? Math.round(rating * 10) : base.match,
    doubanRating: rating,
    doubanVotes: detail.votes > 0 ? detail.votes : base.doubanVotes,
    genres: detail.genres.length ? detail.genres : base.genres,
    synopsis: detail.intro || base.synopsis,
    cast: detail.actors.length ? detail.actors.slice(0, 6) : base.cast,
    creator: detail.directors.join(' / ') || base.creator,
    duration: duration ?? base.duration,
    poster: dbCardImg(posterSource),
    hero: dbHeroImg(heroSource),
    episodes,
    region: detail.countries[0] || base.region,
    pubdate: detail.pubdate[0] || base.pubdate,
    episodesCount: detail.episodesCount > 0 ? detail.episodesCount : base.episodesCount,
  }
}