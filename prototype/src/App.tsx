import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ArrowLeft, ArrowUp, Check, ChevronRight, Info, Menu, Settings } from 'lucide-react'
import BrowseView from './components/BrowseView'
import DetailModal from './components/DetailModal'
import HomeView from './components/HomeView'
import RoomSwitch from './components/RoomSwitch'
import SearchView from './components/SearchView'
import Sidebar from './components/Sidebar'
import TitleBar from './components/TitleBar'
import { initialEpisodeFor, titleName } from './content'
import type { Episode, Title, ViewKey } from './data'
import { formatTime } from './data'
import {
  DOUBAN_FEEDS,
  applyDetail,
  dbCardImg,
  dbHeroImg,

  fetchDoubanDetail,
  fetchDoubanList,
  fetchDoubanSuggest,
  sourcePoster,
  subjectToTitle,
  suggestToTitle,
} from './douban'
import type { FeedState } from './douban'
import { useI18n } from './i18n'
import { mergeRegisteredTitle } from './library'
import { cx, isDesktopApp, isProgressFinished, stripHtml, usePersistentState } from './lib'
import {
  episodeIdForIndex,
  episodeNumberOf,
  aggregateSourceLines,
  errorInfoOf,
  isPlayableEpisode,
  isPlayableLine,
  isVariantSearchResult,
  matchesSearchQuery,
  matchFitsTitle,
  mergeSearchResults,
  nextPlayableEpisodeIndex,
  playableEpisodeIndex,
  playDetail,
  playProbe,
  playResolve,
  playSearch,
  playSources,
  readMatch,
  resolveSession,
  setPlaySourceEnabled,
  sourceTypeIsSeries,
  withTimeout,
} from './play'
import type {
  AggregateLine,
  PlayDetail,
  PlaySearchItem,
  PlayErrorInfo,
  PlayProbeResult,
  PlaySourceInfo,
  PlayTarget,
  ResolvedSession,
} from './play'
import type { PlaybackProgress, PlaybackState, PlaybackStatus } from './types'

const TITLE_CACHE_KEY = 'jj-title-cache'
/// 播放进度落库间隔：5s 太密（整列表跟着重渲染），60s 是"防丢"与"少渲染"的折中。
const PROGRESS_FLUSH_MS = 60_000
const FEED_CACHE_KEY = 'jj-feed-cache'
const FEED_CACHE_PREFIX = 'jj-feed-cache:'
const FEED_TTL = 5 * 60 * 1000
const TITLE_CACHE_BUDGET = 2_000_000
const FEED_EMPTY_ROUNDS_LIMIT = 3
/// 豆瓣列表条目 year=0，自动匹配前先补一次详情；超过该时限则按“年份未知”的严格规则继续。
const PLAY_ENRICH_TIMEOUT_MS = 3_500

const Theater = lazy(() => import('./components/Theater'))

interface CachedFeed {
  ids: string[]
  updatedAt: number
  offsets?: number[]
  exhausted?: boolean
}

const parseCachedFeed = (value: unknown): CachedFeed | null => {
  if (!value || typeof value !== 'object') return null
  const entry = value as Partial<CachedFeed>
  if (!Array.isArray(entry.ids)) return null
  const ids = entry.ids.filter((id): id is string => typeof id === 'string')
  if (ids.length === 0) return null
  const offsets =
    Array.isArray(entry.offsets) &&
    entry.offsets.length > 0 &&
    entry.offsets.every((offset) => typeof offset === 'number' && Number.isFinite(offset))
      ? entry.offsets
      : undefined
  return {
    ids,
    // 旧缓存没有 offsets，视为过期，强制刷新一次后才能继续翻页。
    updatedAt:
      offsets && typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt)
        ? entry.updatedAt
        : 0,
    offsets,
    exhausted: entry.exhausted === true,
  }
}

const readFeedCache = (): Record<string, CachedFeed> => {
  const result: Record<string, CachedFeed> = {}
  // 兼容旧的单 key 缓存。
  try {
    const stored = localStorage.getItem(FEED_CACHE_KEY)
    if (stored) {
      const parsed: unknown = JSON.parse(stored)
      if (parsed && typeof parsed === 'object') {
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          const entry = parseCachedFeed(value)
          if (entry) result[key] = entry
        }
      }
    }
  } catch {
    // ignore corrupt legacy cache
  }
  // 新格式：每个 feed 独立 key，滚动时只重写当前分类。
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (!key?.startsWith(FEED_CACHE_PREFIX)) continue
      const entry = parseCachedFeed(JSON.parse(localStorage.getItem(key) ?? 'null'))
      if (entry) result[key.slice(FEED_CACHE_PREFIX.length)] = entry
    }
  } catch {
    // ignore corrupt per-feed cache
  }
  return result
}

const cachedFeeds = readFeedCache()

const sanitizeString = (value: unknown) => (typeof value === 'string' ? value : '')
const sanitizeNumber = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
const sanitizeStrings = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

const migrateCachedTitle = (value: unknown): Title | null => {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const id = sanitizeString(raw.id)
  const name = sanitizeString(raw.name)
  if (!id || !name) return null
  const mediaType = raw.mediaType === 'series' ? 'series' : 'film'
  const episodesCount =
    typeof raw.episodesCount === 'number' && Number.isFinite(raw.episodesCount) && raw.episodesCount > 0
      ? raw.episodesCount
      : undefined
  const episodes = (Array.isArray(raw.episodes) ? raw.episodes : [])
    .map((value): Episode | null => {
      if (!value || typeof value !== 'object') return null
      const episode = value as Record<string, unknown>
      if (typeof episode.id !== 'string' || typeof episode.number !== 'number') return null
      return {
        id: episode.id,
        season: typeof episode.season === 'number' ? episode.season : 1,
        number: episode.number,
        name:
          typeof episode.name === 'string' && episode.name
            ? episode.name
            : `E${episode.number}`,
        runtime: typeof episode.runtime === 'string' ? episode.runtime : '',
        synopsis: typeof episode.synopsis === 'string' ? episode.synopsis : '',
      }
    })
    .filter((episode): episode is Episode => Boolean(episode))
  let poster = sanitizeString(raw.poster)
  let hero = sanitizeString(raw.hero) || poster
  if (id.startsWith('db-')) {
    poster = dbCardImg(poster)
    hero = dbHeroImg(hero)
  }
  return {
    id,
    name,
    mediaType,
    year: sanitizeNumber(raw.year),
    seasons: typeof raw.seasons === 'number' ? raw.seasons : undefined,
    duration: typeof raw.duration === 'string' ? raw.duration : undefined,
    ageRating: id.startsWith('db-') ? '' : sanitizeString(raw.ageRating),
    match: sanitizeNumber(raw.match),
    genres: sanitizeStrings(raw.genres),
    synopsis: sanitizeString(raw.synopsis),
    poster,
    hero,
    titleStyle: ['glow', 'gothic', 'condensed', 'royal', 'fantasy'].includes(
      String(raw.titleStyle),
    )
      ? (raw.titleStyle as Title['titleStyle'])
      : 'condensed',
    titleLines:
      sanitizeStrings(raw.titleLines).length > 0 ? sanitizeStrings(raw.titleLines) : [name],
    cardTitleSize: ['sm', 'md', 'lg'].includes(String(raw.cardTitleSize))
      ? (raw.cardTitleSize as Title['cardTitleSize'])
      : undefined,
    language: id.startsWith('db-') ? '' : sanitizeString(raw.language),
    creator: sanitizeString(raw.creator),
    cast: sanitizeStrings(raw.cast),
    episodeLabel: typeof raw.episodeLabel === 'string' ? raw.episodeLabel : undefined,
    // 不在启动时展开占位剧集：episodesCount 已足够，episodesOf 会在需要时懒生成。
    episodes,
    isNew: raw.isNew === true,
    addedOrder: sanitizeNumber(raw.addedOrder),
    doubanRating:
      typeof raw.doubanRating === 'number' && Number.isFinite(raw.doubanRating)
        ? raw.doubanRating
        : undefined,
    doubanVotes:
      typeof raw.doubanVotes === 'number' && Number.isFinite(raw.doubanVotes)
        ? raw.doubanVotes
        : undefined,
    originalName: typeof raw.originalName === 'string' ? raw.originalName : undefined,
    region: typeof raw.region === 'string' ? raw.region : undefined,
    pubdate: typeof raw.pubdate === 'string' ? raw.pubdate : undefined,
    episodesCount,
  }
}

const readTitleCache = (): Record<string, Title> => {
  try {
    const stored = localStorage.getItem(TITLE_CACHE_KEY)
    if (!stored) return {}
    const parsed: unknown = JSON.parse(stored)
    if (!parsed || typeof parsed !== 'object') return {}
    const entries = Object.entries(parsed as Record<string, unknown>)
      .map(([id, value]) => {
        const title = migrateCachedTitle(value)
        return title ? ([id, title] as const) : null
      })
      .filter((entry): entry is readonly [string, Title] => Boolean(entry))
    return Object.fromEntries(entries)
  } catch {
    return {}
  }
}

const initialRegistry = readTitleCache()
const cachedFeedTimes = Object.fromEntries(
  Object.entries(cachedFeeds).map(([key, entry]) => [
    key,
    entry.offsets?.length && entry.ids.every((id) => initialRegistry[id]) ? entry.updatedAt : 0,
  ]),
) as Record<string, number>
const cachedFeedOffsets = Object.fromEntries(
  Object.entries(cachedFeeds)
    .filter(([, entry]) => entry.offsets?.length)
    .map(([key, entry]) => [key, entry.offsets as number[]]),
) as Record<string, number[]>
const cachedFeedExhausted = Object.fromEntries(
  Object.entries(cachedFeeds)
    .filter(([, entry]) => entry.exhausted)
    .map(([key]) => [key, true]),
) as Record<string, boolean>

const initialFeedState = (): Record<string, FeedState> => {
  const state: Record<string, FeedState> = {}
  for (const [key, entry] of Object.entries(cachedFeeds)) {
    const ids = entry.ids.filter((id) => initialRegistry[id])
    if (ids.length > 0) {
      state[key] = {
        ids,
        loading: false,
        error: false,
        empty: false,
        partial: false,
        exhausted: entry.exhausted === true,
      }
    }
  }
  state.home ??= { ids: [], loading: true, error: false, empty: false, partial: false }
  return state
}

const compactTitleForCache = (title: Title): Title => ({ ...title, episodes: undefined })

const persistTitleCache = (registry: Record<string, Title>, pinnedIds?: Set<string>) => {
  const entries = Object.entries(registry)
  const pinned = pinnedIds
    ? entries.filter(([id]) => pinnedIds.has(id))
    : ([] as [string, Title][])
  const rest = pinnedIds ? entries.filter(([id]) => !pinnedIds.has(id)) : entries
  let keep = rest.length
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const subset = [...pinned, ...rest.slice(Math.max(0, rest.length - keep))]
    try {
      const payload = JSON.stringify(
        Object.fromEntries(subset.map(([id, title]) => [id, compactTitleForCache(title)])),
      )
      if (payload.length <= TITLE_CACHE_BUDGET || keep <= 50) {
        localStorage.setItem(TITLE_CACHE_KEY, payload)
        return
      }
    } catch {
      // Stringify can fail only when the in-memory data is not serializable; retry smaller.
    }
    keep = Math.max(50, Math.floor(keep / 2))
  }
}

const emptyFeed: FeedState = {
  ids: [],
  loading: false,
  error: false,
  empty: false,
  partial: false,
  exhausted: false,
}

const asStringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

const asProgressMap = (value: unknown): Record<string, PlaybackProgress> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([id, raw]): [string, PlaybackProgress] | null => {
      if (!raw || typeof raw !== 'object') return null
      const entry = raw as Record<string, unknown>
      if (typeof entry.current !== 'number' || typeof entry.duration !== 'number') return null
      if (!Number.isFinite(entry.current) || !Number.isFinite(entry.duration)) return null
      return [
        id,
        {
          current: entry.current,
          duration: entry.duration,
          episodeId: typeof entry.episodeId === 'string' ? entry.episodeId : undefined,
          episodeIndex:
            typeof entry.episodeIndex === 'number' && Number.isFinite(entry.episodeIndex)
              ? entry.episodeIndex
              : undefined,
          updatedAt:
            typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt)
              ? entry.updatedAt
              : undefined,
          finished:
            entry.finished === true || isProgressFinished(entry.current, entry.duration),
        },
      ]
    })
    .filter((entry): entry is [string, PlaybackProgress] => Boolean(entry))
  return Object.fromEntries(entries)
}

const asEpisodeProgressMap = (
  value: unknown,
): Record<string, Record<string, PlaybackProgress>> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([titleId, raw]): [string, Record<string, PlaybackProgress>] | null => {
      const episodes = asProgressMap(raw)
      return Object.keys(episodes).length > 0 ? [titleId, episodes] : null
    })
    .filter(
      (entry): entry is [string, Record<string, PlaybackProgress>] => Boolean(entry),
    )
  return Object.fromEntries(entries)
}

const FEED_VIEWS: ViewKey[] = ['new', 'tv', 'movies', 'anime']

const prefetchKey = (titleId: string, lineIndex: number, episodeIndex: number) =>
  `${titleId}|${lineIndex}|${episodeIndex}`

const probeKeyFor = (sourceKey: string, vodId: string) => `${sourceKey}|${vodId}`

export default function App() {
  const { language, t } = useI18n()
  const tRef = useRef(t)
  tRef.current = t
  const [view, setView] = useState<ViewKey>('home')
  const [query, setQuery] = useState('')
  const [queryComposing, setQueryComposing] = useState(false)
  const [slideIndex, setSlideIndex] = useState(0)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [playback, setPlayback] = useState<PlaybackState | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [toast, setToast] = useState<{
    id: number
    message: string
    tone: 'success' | 'info' | 'warn'
  } | null>(null)

  const updateQuery = useCallback((next: string) => {
    if (!next) setQueryComposing(false)
    setQuery(next)
    if (next.trim()) {
      // 搜索页和浏览页共用 .main-scroll；从深滚动位置输入搜索时，
      // 不重置会把用户带到结果中部，看起来像“没有结果”。
      window.requestAnimationFrame(() => {
        const scroller = document.querySelector<HTMLElement>('.main-scroll')
        if (scroller) scroller.scrollTop = 0
      })
    }
  }, [])

  const [myList, setMyList] = usePersistentState<string[]>('jj-my-list', [], asStringList)
  const [later, setLater] = usePersistentState<string[]>('jj-watch-later', [], asStringList)
  const [liked, setLiked] = usePersistentState<string[]>('jj-liked', [], asStringList)
  const [lights, setLights] = usePersistentState<boolean>(
    'jj-lights',
    true,
    (value) => typeof value === 'boolean' ? value : true,
  )
  const [autoplayNext, setAutoplayNext] = usePersistentState<boolean>(
    'jj-autoplay-next',
    true,
    (value) => typeof value === 'boolean' ? value : true,
  )
  const autoplayNextRef = useRef(true)
  useEffect(() => {
    autoplayNextRef.current = autoplayNext
  }, [autoplayNext])
  const [progressMap, setProgressMap] = usePersistentState<Record<string, PlaybackProgress>>(
    'jj-progress',
    {},
    asProgressMap,
  )
  const progressMapRef = useRef(progressMap)
  progressMapRef.current = progressMap
  const [episodeProgress, setEpisodeProgress] = usePersistentState<
    Record<string, Record<string, PlaybackProgress>>
  >('jj-episode-progress', {}, asEpisodeProgressMap)
  const episodeProgressRef = useRef(episodeProgress)
  episodeProgressRef.current = episodeProgress
  const pinnedTitleIds = useMemo(
    // 观看进度里的标题也必须钉住：标题缓存按 2MB 预算裁剪时，
    // 若只保护片单/稍后看，最近观看会在重启后整条消失。
    () => new Set([...myList, ...later, ...liked, ...Object.keys(progressMap)]),
    [myList, later, liked, progressMap],
  )
  const pinnedTitleIdsRef = useRef(pinnedTitleIds)
  pinnedTitleIdsRef.current = pinnedTitleIds

  const [registry, setRegistry] = useState<Record<string, Title>>(initialRegistry)
  // 搜索结果里来自 CMS 的条目先放内存镜像；用户真正打开/播放时才写入 registry，
  // 避免一次搜索把整站目录塞进 2MB 的 jj-title-cache。
  const transientTitlesRef = useRef<Map<string, Title>>(new Map())
  const [feeds, setFeeds] = useState<Record<string, FeedState>>(initialFeedState)
  const feedUpdatedRef = useRef<Record<string, number>>(cachedFeedTimes)
  const [searchResults, setSearchResults] = useState<Title[]>([])
  const [searchBusy, setSearchBusy] = useState(false)
  const [searchSourceErrors, setSearchSourceErrors] = useState(0)
  const [searchError, setSearchError] = useState(false)
  const [searchNonce, setSearchNonce] = useState(0)
  const [probes, setProbes] = useState<Record<string, PlayProbeResult>>({})
  const probesRef = useRef<Record<string, PlayProbeResult>>({})
  useEffect(() => {
    probesRef.current = probes
  }, [probes])
  const probeFlightsRef = useRef<Set<string>>(new Set())
  const probeTriedRef = useRef<Set<string>>(new Set())
  const [sourceInfos, setSourceInfos] = useState<PlaySourceInfo[]>([])
  const [sourcesLoaded, setSourcesLoaded] = useState(!isDesktopApp)
  const [sourcesFailed, setSourcesFailed] = useState(false)
  const loadSources = useCallback(async () => {
    if (!isDesktopApp) {
      setSourcesLoaded(true)
      return
    }
    setSourcesLoaded(false)
    setSourcesFailed(false)
    try {
      const list = await playSources()
      setSourceInfos(list)
      setSourcesLoaded(true)
    } catch {
      setSourcesFailed(true)
      setSourcesLoaded(true)
    }
  }, [])
  const sourceNames = useMemo(
    () => Object.fromEntries(sourceInfos.map((source) => [source.key, source.name])),
    [sourceInfos],
  )
  // 线路面板的跨源聚合线路(每 title 会话内聚合一次)
  const [aggregateLines, setAggregateLines] = useState<AggregateLine[]>([])
  const aggregateLinesRef = useRef<AggregateLine[]>([])
  useEffect(() => {
    aggregateLinesRef.current = aggregateLines
  }, [aggregateLines])
  const aggregateTitleRef = useRef('')
  const aggregateRequestRef = useRef(0)

  useEffect(() => {
    void loadSources()
  }, [loadSources])

  const feedsRef = useRef<Record<string, FeedState>>({})
  useEffect(() => {
    feedsRef.current = feeds
  }, [feeds])

  const inflightRef = useRef<Set<string>>(new Set())
  const prefetchedFeedsRef = useRef<Set<string>>(new Set())
  const feedOffsetsRef = useRef<Record<string, number[]>>(cachedFeedOffsets)
  const feedEmptyRoundsRef = useRef<Record<string, number>>({})
  // 内存镜像：瀑布流每追加一页都重读并解析整个 jj-feed-cache 是纯 I/O 浪费。
  const feedCacheRef = useRef<Record<string, CachedFeed>>(cachedFeeds)
  const [feedExhaustedMap, setFeedExhaustedMap] = useState<Record<string, boolean>>(
    cachedFeedExhausted,
  )

  const writeFeedCache = useCallback(
    (feedKey: string, ids: string[], offsets: number[], exhausted: boolean) => {
      const entry: CachedFeed = {
        ids,
        updatedAt: Date.now(),
        offsets,
        exhausted,
      }
      feedCacheRef.current = { ...feedCacheRef.current, [feedKey]: entry }
      try {
        // 每个分类独立 key：追加一页只序列化当前分类，不再重写全部分类。
        localStorage.setItem(`${FEED_CACHE_PREFIX}${feedKey}`, JSON.stringify(entry))
      } catch {
        // feed cache is an optimization only
      }
    },
    [],
  )

  useEffect(() => {
    // 防抖写入:搜索/瀑布流会高频注册条目,全量序列化不能每次都做。
    // 只依赖 registry：progressMap 每 60s 变化时不应触发整库序列化；
    // pinned 集合通过 ref 读取，写盘时仍然生效。
    const timer = window.setTimeout(
      () => persistTitleCache(registry, pinnedTitleIdsRef.current),
      800,
    )
    return () => window.clearTimeout(timer)
  }, [registry])

  const register = useCallback((incoming: Title[]) => {
    if (incoming.length === 0) return
    setRegistry((previous) => {
      let changed = false
      const next = { ...previous }
      for (const title of incoming) {
        const existing = next[title.id]
        if (!existing) {
          next[title.id] = title
          changed = true
          continue
        }
        // 只有能补齐既有数据缺口/刷新详情字段时才合并；
        // 空值不覆盖已有内容，集数取更大值，评分/票数允许更新。
        const merged = mergeRegisteredTitle(existing, title)
        if (merged) {
          next[title.id] = merged
          changed = true
        }
      }
      return changed ? next : previous
    })
  }, [])

  const resolveTitle = useCallback(
    (id: string): Title | undefined => registry[id] ?? transientTitlesRef.current.get(id),
    [registry],
  )

  const detailPromisesRef = useRef<Map<string, Promise<Title | null>>>(new Map())
  const detailDoneRef = useRef<Set<string>>(new Set())
  /// 拉取豆瓣详情并注册增强后的 Title。返回 Promise 供播放前补年份复用；
  /// 同一 id 的并发调用共享同一个请求，避免详情弹窗与开播各拉一次。
  const ensureDetail = useCallback(
    (title: Title): Promise<Title | null> => {
      if (!title.id.startsWith('db-')) return Promise.resolve(title)
      const inFlight = detailPromisesRef.current.get(title.id)
      if (inFlight) return inFlight
      const hasSeriesEpisodes = title.mediaType !== 'series' || Boolean(title.episodes?.length)
      if (
        detailDoneRef.current.has(title.id) ||
        (title.year > 0 && title.synopsis && title.cast.length > 0 && hasSeriesEpisodes)
      ) {
        detailDoneRef.current.add(title.id)
        return Promise.resolve(title)
      }
      const kind = title.mediaType === 'series' ? 'tv' : 'movie'
      const promise = fetchDoubanDetail(title.id.slice(3), kind)
        .then((detail) => {
          if (!detail) return null
          detailDoneRef.current.add(title.id)
          const enriched = applyDetail(title, detail)
          register([enriched])
          return enriched
        })
        .catch(() => null)
        .finally(() => detailPromisesRef.current.delete(title.id))
      detailPromisesRef.current.set(title.id, promise)
      return promise
    },
    [register],
  )

  // 语义化提示：列表增删是成功，换源/钳制是信息或警告，
  // 全部配一个绿色对勾会让"部分源失败"看起来像成功。
  const notify = useCallback(
    (message: string, tone: 'success' | 'info' | 'warn' = 'success') => {
      setToast({ id: Date.now(), message, tone })
    },
    [],
  )

  const loadFeed = useCallback(
    async (feedKey: string, force = false) => {
      const parts = DOUBAN_FEEDS[feedKey]
      if (!parts) return false
      if (inflightRef.current.has(feedKey)) return false
      const current = feedsRef.current[feedKey]
      const fresh =
        Boolean(current?.ids.length) &&
        Date.now() - (feedUpdatedRef.current[feedKey] ?? 0) < FEED_TTL
      if (!force && fresh) return true
      const existingIds = current?.ids ?? []
      inflightRef.current.add(feedKey)
      try {
        setFeeds((previous) => ({
          ...previous,
          [feedKey]: {
            ids: previous[feedKey]?.ids ?? [],
            loading: true,
            error: false,
            empty: false,
            partial: false,
          },
        }))
        const results = await Promise.all(
          parts.map((part) => fetchDoubanList(part.kind, part.tag, part.limit, 0, part.sort)),
        )
        const anyFailed = results.some((subjects) => subjects === null)
        const seen = new Set<string>()
        const buckets = results.map((subjects, index) => {
          const kind = parts[index].kind
          return (subjects ?? [])
            .filter((subject) => {
              if (seen.has(subject.id)) return false
              seen.add(subject.id)
              return true
            })
            .map((subject) => subjectToTitle(subject, kind))
        })
        const merged: Title[] = []
        const longest = buckets.reduce((max, bucket) => Math.max(max, bucket.length), 0)
        for (let index = 0; index < longest; index += 1) {
          for (const bucket of buckets) {
            if (bucket[index]) merged.push(bucket[index])
          }
        }
        if (merged.length === 0) {
          const failed = existingIds.length === 0 && anyFailed
          setFeeds((previous) => ({
            ...previous,
            [feedKey]: {
              ids: existingIds,
              loading: false,
              error: failed,
              // 成功返回空数组是“确实没有内容”，不是网络故障。
              empty: existingIds.length === 0 && !anyFailed,
              partial: existingIds.length > 0 && anyFailed,
            },
          }))
          if (failed) notify(tRef.current('common.loadFailed'))
          return false
        }
        register(merged)
        const mergedIds = merged.map((title) => title.id)
        // 部分源失败时保留旧条目，避免首屏只刷新到一半就“少了一截”。
        const ids = anyFailed
          ? [...mergedIds, ...existingIds.filter((id) => !mergedIds.includes(id))]
          : mergedIds
        // 失败的 part 从 0 重新开始，下一轮才不会跳过第一页。
        // 成功但返回不足 limit 时按实际条数前进，避免跳过末尾几条。
        const offsets = results.map((subjects) =>
          subjects === null ? 0 : subjects.length,
        )
        feedOffsetsRef.current[feedKey] = offsets
        feedEmptyRoundsRef.current[feedKey] = 0
        feedUpdatedRef.current[feedKey] = Date.now()
        setFeedExhaustedMap((previous) => ({ ...previous, [feedKey]: false }))
        writeFeedCache(feedKey, ids, offsets, false)
        setFeeds((previous) => ({
          ...previous,
          [feedKey]: {
            ids,
            loading: false,
            error: false,
            empty: false,
            partial: anyFailed,
            exhausted: false,
          },
        }))
        return true
      } catch (error) {
        console.warn('[jj] feed load failed', feedKey, error)
        setFeeds((previous) => ({
          ...previous,
          [feedKey]: {
            ids: existingIds,
            loading: false,
            error: existingIds.length === 0,
            empty: false,
            partial: existingIds.length > 0,
          },
        }))
        notify(tRef.current('common.loadFailed'))
        return false
      } finally {
        inflightRef.current.delete(feedKey)
      }
    },
    [notify, register, writeFeedCache],
  )

  useEffect(() => {
    void loadFeed('home', true)
  }, [loadFeed])

  useEffect(() => {
    if (FEED_VIEWS.includes(view)) void loadFeed(view)
  }, [view, loadFeed])

  // 无限瀑布流:追加下一页(各 part 独立游标,合并去重;连续无新增才判定到底)
  const loadFeedNext = useCallback(
    async (feedKey: string) => {
      const parts = DOUBAN_FEEDS[feedKey]
      if (!parts || inflightRef.current.has(feedKey)) return false
      const offsets = feedOffsetsRef.current[feedKey]
      if (
        !offsets ||
        offsets.length !== parts.length ||
        offsets.some((offset) => !Number.isFinite(offset))
      ) {
        return false // 首屏尚未完成或旧缓存缺少游标
      }
      inflightRef.current.add(feedKey)
      try {
        const results = await Promise.all(
          parts.map((part, index) =>
            fetchDoubanList(part.kind, part.tag, part.limit, offsets[index], part.sort),
          ),
        )
        // fetchDoubanList 失败返回 null（不是 throw）：此时不能判定到底，保持哨兵等重试。
        let anyFailed = false
        const existing = new Set(feedsRef.current[feedKey]?.ids ?? [])
        const buckets = results.map((subjects, index) => {
          const kind = parts[index].kind
          if (subjects === null) {
            anyFailed = true
            return []
          }
          feedOffsetsRef.current[feedKey][index] += subjects.length
          return subjects
            .map((subject) => subjectToTitle(subject, kind))
            .filter((title) => {
              if (existing.has(title.id)) return false
              existing.add(title.id)
              return true
            })
        })
        const merged: Title[] = []
        const longest = buckets.reduce((max, bucket) => Math.max(max, bucket.length), 0)
        for (let index = 0; index < longest; index += 1) {
          for (const bucket of buckets) {
            if (bucket[index]) merged.push(bucket[index])
          }
        }
        if (merged.length === 0) {
          if (anyFailed) return false
          // 豆瓣 recommend 流会返回重复页；连续 3 轮无新增才判定到底。
          const rounds = (feedEmptyRoundsRef.current[feedKey] ?? 0) + 1
          feedEmptyRoundsRef.current[feedKey] = rounds
          if (rounds >= FEED_EMPTY_ROUNDS_LIMIT) {
            setFeedExhaustedMap((previous) => ({ ...previous, [feedKey]: true }))
            const ids = feedsRef.current[feedKey]?.ids ?? []
            writeFeedCache(feedKey, ids, feedOffsetsRef.current[feedKey], true)
          }
          return false
        }
        feedEmptyRoundsRef.current[feedKey] = 0
        register(merged)
        const ids = [...(feedsRef.current[feedKey]?.ids ?? []), ...merged.map((title) => title.id)]
        // 追加也代表 feed 有更新：否则 5 分钟后重启会把已追加的深度判成过期。
        feedUpdatedRef.current[feedKey] = Date.now()
        writeFeedCache(feedKey, ids, feedOffsetsRef.current[feedKey], false)
        setFeeds((previous) => ({
          ...previous,
          [feedKey]: {
            ...previous[feedKey],
            ids,
            loading: false,
            error: false,
            empty: false,
            partial: anyFailed,
            exhausted: false,
          },
        }))
        return true
      } catch {
        // 追加失败静默,哨兵会在退避后再次触发
        return false
      } finally {
        inflightRef.current.delete(feedKey)
      }
    },
    [register, writeFeedCache],
  )

  const loadMoreForView = useCallback(() => loadFeedNext(view), [loadFeedNext, view])

  useEffect(() => {
    if (!FEED_VIEWS.includes(view)) return
    const feed = feeds[view]
    if (!feed || feed.loading || feed.error || feed.ids.length === 0) return
    if (feedExhaustedMap[view] || prefetchedFeedsRef.current.has(view)) return
    prefetchedFeedsRef.current.add(view)
    void loadFeedNext(view)
  }, [view, feeds, feedExhaustedMap, loadFeedNext])

  const feedItems = useCallback(
    (feedKey: string): Title[] => {
      const feed = feeds[feedKey]
      if (!feed) return []
      return feed.ids
        .map((id) => registry[id])
        .filter((title): title is Title => Boolean(title))
    },
    [feeds, registry],
  )

  const searching = query.trim().length > 0

  useEffect(() => {
    const needle = query.trim()
    if (!needle) {
      setSearchResults([])
      transientTitlesRef.current.clear()
      setSearchBusy(false)
      setSearchSourceErrors(0)
      setSearchError(false)
      return
    }
    if (queryComposing) {
      setSearchBusy(true)
      return
    }
    // 单字只发豆瓣联想（轻量、能补全），不触发 7 源 × 最多 4 页的播放源风暴。
    const wantSourceSearch = needle.length >= 2
    setSearchBusy(true)
    setSearchError(false)
    setSearchSourceErrors(0)
    let cancelled = false
    const timer = window.setTimeout(() => {
      const doubanTitles: Title[] = []
      const sourceTitles: Title[] = []
      let pending = wantSourceSearch ? 2 : 1
      let doubanFailed = false
      let sourceFailed = false
      let sourceErrorCount = 0
      let sourceCount = 0
      const publish = () => {
        if (cancelled) return
        const merged = mergeSearchResults(doubanTitles, sourceTitles)
        // 新查询还没有任何结果时先保留旧结果，等所有分支 settle 再决定空态，
        // 避免输入过程中列表被清空导致闪烁。
        if (merged.length === 0 && pending > 0) return
        transientTitlesRef.current = new Map(merged.map((title) => [title.id, title]))
        setSearchResults(merged)
        setSearchError(
          doubanFailed ||
            sourceFailed ||
            (merged.length === 0 && sourceCount > 0 && sourceErrorCount >= sourceCount),
        )
      }
      const settle = () => {
        if (cancelled) return
        pending -= 1
        if (pending <= 0) setSearchBusy(false)
        publish()
      }
      const mapSourceItems = (items: PlaySearchItem[]) =>
        // CMS 并不都支持 wd（lzi/bfzy 会返回整站目录），必须在展示前过滤。
        items
          .filter(
            (item) =>
              matchesSearchQuery(needle, item.name) && !isVariantSearchResult(item.name),
          )
          .slice(0, 30)
          .map((item) => {
            const id = `ps-${item.sourceKey.replace(/-/g, '~')}-${item.vodId}`
            const typeName = item.typeName || ''
            return {
              id,
              name: item.name,
              mediaType: sourceTypeIsSeries(typeName) ? 'series' : 'film',
              year: Number.parseInt(item.year, 10) || 0,
              ageRating: '',
              match: 0,
              genres: typeName ? [typeName] : [],
              synopsis: item.actor ? `主演：${stripHtml(item.actor)}` : '',
              poster: sourcePoster(item.pic),
              titleStyle: 'condensed',
              titleLines: [item.name],
              language: item.lang || '',
              creator: item.director || '',
              cast: item.actor ? item.actor.split(',').filter(Boolean).slice(0, 4) : [],
              addedOrder: 0,
              region: item.area,
              remarks: item.remarks,
            } as Title
          })
      const mergeSourceItems = (items: PlaySearchItem[]) => {
        // 旧 query 的后台补搜不得污染当前结果与片库。
        if (cancelled) return
        const known = new Set(sourceTitles.map((title) => title.id))
        const extra = mapSourceItems(items).filter((title) => !known.has(title.id))
        if (extra.length === 0) return
        sourceTitles.push(...extra)
        publish()
      }
      // 豆瓣联想与播放源搜索并行；任意一方先返回就先展示，不互相阻塞。
      void (async () => {
        try {
          const suggestions = await fetchDoubanSuggest(needle)
          if (cancelled) return
          if (!suggestions) {
            doubanFailed = true
          } else {
            const mapped = suggestions.map(suggestToTitle)
            doubanTitles.push(...mapped)
            register(mapped)
          }
        } catch {
          if (!cancelled) doubanFailed = true
        } finally {
          settle()
        }
      })()
      if (!wantSourceSearch) return
      void (async () => {
        try {
          const response = await playSearch(needle)
          if (cancelled) return
          sourceErrorCount = response.errors?.length ?? 0
          sourceCount = response.sourceCount ?? 0
          setSearchSourceErrors(sourceErrorCount)
          sourceTitles.push(...mapSourceItems(response.items ?? []))
          publish()
        } catch {
          // 桌面端不可用或全部源失败时，仍展示豆瓣结果，但搜索页要能提示错误。
          if (!cancelled) sourceFailed = true
        } finally {
          // 先结束 busy：结果已经可见，不能因为补搜让"正在搜索"再挂几秒。
          settle()
        }
        if (sourceErrorCount === 0 || cancelled) return
        // 慢源转后台写缓存；稍后再查一次，通常能命中缓存补齐结果。
        await new Promise((resolve) => window.setTimeout(resolve, 1200))
        if (cancelled) return
        try {
          const retry = await playSearch(needle)
          if (cancelled) return
          sourceErrorCount = retry.errors?.length ?? 0
          sourceCount = retry.sourceCount ?? sourceCount
          setSearchSourceErrors(sourceErrorCount)
          mergeSourceItems(retry.items ?? [])
        } catch {
          if (!cancelled) sourceFailed = true
          publish()
        }
      })()
    }, 350)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [query, queryComposing, register, searchNonce])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 2800)
    return () => window.clearTimeout(timer)
  }, [toast])

  // localStorage 配额/不可用不应静默丢数据；每个会话只提示一次，避免刷屏。
  const storageWarnedRef = useRef(false)
  useEffect(() => {
    const onStorageError = () => {
      if (storageWarnedRef.current) return
      storageWarnedRef.current = true
      notify(tRef.current('toast.storageFailed'), 'warn')
    }
    window.addEventListener('jj-storage-error', onStorageError)
    return () => window.removeEventListener('jj-storage-error', onStorageError)
  }, [notify])

  // 只读 progressMap：播放中的实时位置由 Theater 自己显示，
  // 列表不需要跟着每 5s 的 playback.current 重算（否则整页卡片陪跑重渲染）。
  const progressFor = useCallback(
    (id: string): PlaybackProgress | undefined => progressMap[id],
    [progressMap],
  )

  const saveProgress = useCallback(
    (
      titleId: string,
      episodeId: string | undefined,
      episodeIndex: number | undefined,
      current: number,
      duration: number,
    ) => {
      if (!(duration > 0) || !Number.isFinite(duration)) return
      const finished = isProgressFinished(current, duration)
      const entry: PlaybackProgress = {
        current,
        duration,
        episodeId,
        episodeIndex,
        updatedAt: Date.now(),
        finished,
      }
      const same = (saved: PlaybackProgress | undefined) =>
        Boolean(
          saved &&
            saved.episodeId === episodeId &&
            saved.episodeIndex === episodeIndex &&
            saved.duration === duration &&
            Boolean(saved.finished) === finished &&
            Math.abs(saved.current - current) < 1,
        )
      setProgressMap((previous) => {
        if (same(previous[titleId])) return previous
        return { ...previous, [titleId]: entry }
      })
      // 剧集按 titleId → episodeId 单独保存：切回上一集时不会被当前集进度覆盖。
      if (episodeId) {
        setEpisodeProgress((previous) => {
          const episodes = previous[titleId] ?? {}
          if (same(episodes[episodeId])) return previous
          return { ...previous, [titleId]: { ...episodes, [episodeId]: entry } }
        })
      }
    },
    [setEpisodeProgress, setProgressMap],
  )

  // 播放中最近一次进度快照 + 落库节流时间戳。
  const liveProgressRef = useRef<{
    titleId: string
    episodeId?: string
    episodeIndex?: number
    current: number
    duration: number
  } | null>(null)
  const lastProgressFlushRef = useRef(0)

  const flushLiveProgress = useCallback(
    (force = false) => {
      const live = liveProgressRef.current
      if (!live) return
      const now = Date.now()
      if (!force && now - lastProgressFlushRef.current < PROGRESS_FLUSH_MS) return
      lastProgressFlushRef.current = now
      saveProgress(live.titleId, live.episodeId, live.episodeIndex, live.current, live.duration)
    },
    [saveProgress],
  )

  const prefetchRef = useRef<{ key: string; target: PlayTarget; at: number } | null>(null)

  const closePlayback = useCallback(() => {
    prefetchRef.current = null
    // 关闭前把节流中的进度补写一次，避免"看了 50 秒直接退出"丢位置。
    flushLiveProgress(true)
    // 切集瞬间（新集还没出首帧）关闭：liveProgressRef 仍是上一集，
    // 只落旧集会让人重开时退回已经看完的上一集。
    const session = playbackRef.current
    const live = liveProgressRef.current
    if (
      session &&
      live &&
      session.titleId === live.titleId &&
      session.episodeId !== live.episodeId &&
      live.duration > 0
    ) {
      saveProgress(
        session.titleId,
        session.episodeId,
        session.episodeIndex,
        Math.max(0, session.current || 0),
        live.duration,
      )
    }
    liveProgressRef.current = null
    setPlayback(null)
  }, [flushLiveProgress, saveProgress])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing = target ? ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) : false

      if (event.key === 'Escape') {
        if (playback) {
          closePlayback()
          return
        }
        if (detailId) {
          setDetailId(null)
          return
        }
        if (drawerOpen) {
          setDrawerOpen(false)
          return
        }
        if (query) setQuery('')
      }

      if (!typing && event.key === '/' && !playback && !detailId) {
        event.preventDefault()
        document.querySelector<HTMLInputElement>('.search-input')?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [playback, closePlayback, detailId, drawerOpen, query])

  const playReqRef = useRef(0)
  const lastStartRef = useRef<{ key: string; at: number }>({ key: '', at: 0 })
  const playbackRef = useRef<PlaybackState | null>(null)
  // 播放器实时位置（Theater 每秒上报一次）：自动换源定位用，避免逐秒 setState。
  const liveTimeRef = useRef<{ current: number; duration: number } | null>(null)
  const liveCurrent = useCallback(
    () => liveTimeRef.current?.current ?? playbackRef.current?.current ?? 0,
    [],
  )
  const autoRecoverRef = useRef({
    titleId: '',
    failedSources: new Set<string>(),
    triedLines: new Set<number>(),
    lineAttempts: 0,
    scheduled: false,
    currentSource: '',
    resumePosition: undefined as number | undefined,
    reason: 'failure' as 'failure' | 'stall' | 'startup',
    recovering: false,
    autoAttempts: 0,
    resumeReachedAt: undefined as number | undefined,
  })
  const autoRecoverHandlerRef = useRef<(() => void) | null>(null)
  const cooldownRef = useRef<Record<string, number>>({})
  const startupRef = useRef<{
    seq: number
    done: boolean
    startedAt: number
    lastActivity: number
    extensions: number
    slowTimer?: number
    autoTimer?: number
  }>({ seq: 0, done: true, startedAt: 0, lastActivity: 0, extensions: 0 })
  const reSearchRef = useRef<{ titleId: string; done: boolean }>({ titleId: '', done: false })
  const recoverEpochRef = useRef(0)
  useEffect(() => {
    playbackRef.current = playback
  }, [playback])

  // 窗口关闭/切后台时尽量补写一次实时进度，避免丢掉最后 5 秒。
  useEffect(() => {
    const flush = () => {
      const session = playbackRef.current
      const live = liveTimeRef.current
      if (!session || !live || !(live.duration > 0) || !(live.current > 0)) return
      try {
        const stored: unknown = JSON.parse(localStorage.getItem('jj-progress') ?? '{}')
        const progress =
          stored && typeof stored === 'object' && !Array.isArray(stored)
            ? (stored as Record<string, PlaybackProgress>)
            : {}
        progress[session.titleId] = {
          current: live.current,
          duration: live.duration,
          episodeId: session.episodeId,
          episodeIndex: session.episodeIndex,
          updatedAt: Date.now(),
          finished: isProgressFinished(live.current, live.duration),
        }
        localStorage.setItem('jj-progress', JSON.stringify(progress))
        if (session.episodeId) {
          const rawEpisodes: unknown = JSON.parse(
            localStorage.getItem('jj-episode-progress') ?? '{}',
          )
          const episodes =
            rawEpisodes && typeof rawEpisodes === 'object' && !Array.isArray(rawEpisodes)
              ? (rawEpisodes as Record<string, Record<string, PlaybackProgress>>)
              : {}
          const perTitle = episodes[session.titleId] ?? {}
          perTitle[session.episodeId] = progress[session.titleId] as PlaybackProgress
          episodes[session.titleId] = perTitle
          localStorage.setItem('jj-episode-progress', JSON.stringify(episodes))
        }
      } catch {
        // best-effort only
      }
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('beforeunload', flush)
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('beforeunload', flush)
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  const prefetchNextEpisode = useCallback(
    (
      title: Title,
      detail: PlayDetail,
      lineIndex: number,
      episodeIndex: number,
      sourceKey: string,
      vodId: string,
    ) => {
      if (title.mediaType !== 'series') return
      const line = detail.lines[lineIndex]
      if (!line) return
      const nextIndex = nextPlayableEpisodeIndex(line, episodeIndex + 1)
      if (nextIndex === null) return
      const key = prefetchKey(title.id, lineIndex, nextIndex)
      if (prefetchRef.current?.key === key) return
      // Warm the next episode target only; manifests/segments stay lazy.
      void playResolve(sourceKey, vodId, lineIndex, nextIndex)
        .then((target) => {
          prefetchRef.current = { key, target, at: Date.now() }
        })
        .catch(() => undefined)
    },
    [],
  )

  const markSourceCooldown = useCallback((sourceKey?: string) => {
    if (!sourceKey) return
    cooldownRef.current[sourceKey] = Date.now() + 60_000
  }, [])

  const resetAutoRecover = useCallback((titleId: string) => {
    autoRecoverRef.current = {
      titleId,
      failedSources: new Set(),
      triedLines: new Set(),
      lineAttempts: 0,
      scheduled: false,
      currentSource: '',
      resumePosition: undefined,
      reason: 'failure',
      recovering: false,
      autoAttempts: 0,
      resumeReachedAt: undefined,
    }
  }, [])

  const scheduleAutoRecover = useCallback(() => {
    const state = autoRecoverRef.current
    if (state.scheduled) return
    state.scheduled = true
    window.setTimeout(() => {
      state.scheduled = false
      autoRecoverHandlerRef.current?.()
    }, 700)
  }, [])

  const clearStartupTimers = useCallback(() => {
    const startup = startupRef.current
    if (startup.slowTimer !== undefined) window.clearTimeout(startup.slowTimer)
    if (startup.autoTimer !== undefined) window.clearTimeout(startup.autoTimer)
    startup.slowTimer = undefined
    startup.autoTimer = undefined
  }, [])

  const startStartupTimers = useCallback(
    (seq: number) => {
      clearStartupTimers()
      const startup = startupRef.current
      startup.seq = seq
      startup.done = false
      startup.startedAt = Date.now()
      startup.lastActivity = Date.now()
      startup.extensions = 0
      startup.slowTimer = window.setTimeout(() => {
        if (startupRef.current.seq !== seq || startupRef.current.done) return
        setPlayback((current) =>
          current ? { ...current, slowStartup: true } : current,
        )
      }, 5000)
      // 10s 没有首帧才判死;但若缓冲仍在推进(慢分片正常下载),延长等待,
      // 避免把"慢而活"的源误杀成启动失败(国内部分源站首片要 8s+)。
      const armStartupCheck = (delayMs: number) => {
        startup.autoTimer = window.setTimeout(() => {
          if (startupRef.current.seq !== seq || startupRef.current.done) return
          const current = playbackRef.current
          const state = autoRecoverRef.current
          if (
            Date.now() - startupRef.current.lastActivity < 5000 &&
            startupRef.current.extensions < 3
          ) {
            startupRef.current.extensions += 1
            console.info('[jj] startup extended: buffer still progressing', {
              ext: startupRef.current.extensions,
              sourceKey: current?.sourceKey,
            })
            armStartupCheck(8000)
            return
          }
          state.reason = 'startup'
          if (state.resumePosition === undefined && current) {
            state.resumePosition = liveCurrent()
          }
          console.info('[jj] startup timeout -> switch line/source', {
            titleId: current?.titleId,
            sourceKey: current?.sourceKey,
            lineIndex: current?.lineIndex,
            position: current?.current,
          })
          state.recovering = false
          setPlayback((value) =>
            value
              ? {
                  ...value,
                  slowStartup: false,
                  autoRecovering: true,
                  status: 'loading',
                  error: undefined,
                }
              : value,
          )
          autoRecoverHandlerRef.current?.()
        }, delayMs)
      }
      armStartupCheck(10000)
    },
    [clearStartupTimers],
  )

  const handleStartupActivity = useCallback(() => {
    const startup = startupRef.current
    if (startup.done) return
    startup.lastActivity = Date.now()
  }, [])

  useEffect(() => {
    if (playback) return
    startupRef.current.done = true
    clearStartupTimers()
  }, [playback, clearStartupTimers])

  useEffect(() => {
    const onOnline = () => {
      const current = playbackRef.current
      if (!current?.autoRecovering) return
      console.info('[jj] network online -> resume recovery', {
        titleId: current.titleId,
        position: current.current,
      })
      autoRecoverRef.current.recovering = false
      autoRecoverHandlerRef.current?.()
    }
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [])

  // 聚合所有候选源的线路(每 title 一次):线路面板据此展示全集源/单集源与跨源切换。
  const refreshAggregateLines = useCallback(
    (title: Title, seedDetail?: PlayDetail) => {
      if (aggregateTitleRef.current === title.id && aggregateLinesRef.current.length > 0) return
      aggregateTitleRef.current = title.id
      const requestId = aggregateRequestRef.current + 1
      aggregateRequestRef.current = requestId
      void aggregateSourceLines(title, {
        sourceNames,
        maxSources: 6,
        seedDetails: seedDetail ? [seedDetail] : [],
      })
        .then((result) => {
          if (aggregateTitleRef.current !== title.id) return
          if (aggregateRequestRef.current !== requestId) return
          setAggregateLines(result.lines)
        })
        .catch(() => undefined)
    },
    [sourceNames],
  )

  const beginPlayback = useCallback(
    (
      title: Title,
      request: {
        episodeId?: string
        episodeNumber?: number
        episodeIndex?: number
        lineIndex?: number
        startAt?: number
        excludeSourceKey?: string
        excludeSourceKeys?: string[]
        detail?: PlayDetail
        autoSwitch?: boolean
        stayOnSource?: boolean
        previousSourceKey?: string
        maxCandidates?: number
        autoReason?: 'failure' | 'stall' | 'startup'
        preferredSourceKey?: string
      },
    ) => {
      // 换集/换源前先把上一集的节流进度落库，否则旧集最后 60s 会丢。
      flushLiveProgress(true)
      const requestId = playReqRef.current + 1
      playReqRef.current = requestId
      liveTimeRef.current = null
      if (aggregateTitleRef.current !== title.id) {
        aggregateTitleRef.current = title.id
        aggregateRequestRef.current += 1
        aggregateLinesRef.current = []
        setAggregateLines([])
      }
      const episodeIndex =
        request.episodeIndex ??
        (request.episodeNumber !== undefined
          ? Math.max(0, request.episodeNumber - 1)
          : undefined)
      const cooled = request.stayOnSource
        ? []
        : Object.entries(cooldownRef.current)
            .filter(([, expires]) => expires > Date.now())
            .map(([key]) => key)
      const excludeSourceKeys = Array.from(
        new Set([...(request.excludeSourceKeys ?? []), ...cooled]),
      )
      if (autoRecoverRef.current.titleId !== title.id) resetAutoRecover(title.id)

      setPlayback({
        titleId: title.id,
        episodeId: request.episodeId,
        episodeNumber:
          request.episodeNumber ?? (episodeIndex !== undefined ? episodeIndex + 1 : undefined),
        episodeIndex,
        lineIndex: request.lineIndex,
        current: request.startAt ?? 0,
        duration: 0,
        playing: false,
        volume: 0.72,
        muted: false,
        status: 'resolving',
        detail: request.detail,
        retryNonce: 0,
      })
      startStartupTimers(requestId)

      const prefetched = prefetchRef.current
      prefetchRef.current = null
      if (
        prefetched &&
        request.detail &&
        request.lineIndex !== undefined &&
        episodeIndex !== undefined &&
        prefetched.key === prefetchKey(title.id, request.lineIndex, episodeIndex) &&
        Date.now() - prefetched.at < 10 * 60 * 1000
      ) {
        const target = prefetched.target
        setPlayback((current) =>
          current && current.titleId === title.id
            ? {
                ...current,
                detail: request.detail,
                target,
                sourceKey: target.sourceKey,
                lineIndex: target.lineIndex,
                episodeIndex: target.episodeIndex,
                episodeNumber:
                  title.mediaType === 'series' ? target.episodeIndex + 1 : undefined,
                episodeId: episodeIdForIndex(title, target.episodeIndex),
                current: request.startAt ?? 0,
                status: 'loading',
                error: undefined,
              }
            : current,
        )
        prefetchNextEpisode(
          title,
          request.detail,
          target.lineIndex,
          target.episodeIndex,
          target.sourceKey,
          target.vodId,
        )
        refreshAggregateLines(title, request.detail)
        return
      }

      void (async () => {
        try {
          // 豆瓣列表接口不返回年份：开播前补一次详情，避免把同名翻拍/续集当成正片。
          // 超时则按“年份未知”的严格匹配规则继续，不无限阻塞起播。
          let activeTitle = title
          if (title.id.startsWith('db-') && title.year <= 0 && !request.detail) {
            const enriched = await withTimeout(
              ensureDetail(title),
              PLAY_ENRICH_TIMEOUT_MS,
              '豆瓣详情加载超时',
            ).catch(() => null)
            if (playReqRef.current !== requestId) return
            if (enriched) activeTitle = enriched
          }
          const match = readMatch(activeTitle.id)
          const validMatch =
            match && matchFitsTitle(activeTitle, match) ? match : null
          const probe =
            request.lineIndex === undefined && request.excludeSourceKey === undefined && validMatch
              ? probesRef.current[probeKeyFor(validMatch.sourceKey, validMatch.vodId)]
              : undefined
          const preferredLine = request.lineIndex ?? probe?.recommendedLineIndex ?? undefined
          let resolved: ResolvedSession
          try {
            resolved = await resolveSession(activeTitle, {
              episodeIndex,
              preferredLine,
              preferredSourceKey: request.preferredSourceKey,
              excludeSourceKey: request.excludeSourceKey,
              excludeSourceKeys,
              maxCandidates: request.maxCandidates,
              detail: request.detail,
              onSourceFailure: (sourceKey, sourceError) => {
                const state = autoRecoverRef.current
                if (state.titleId === title.id) state.failedSources.add(sourceKey)
                markSourceCooldown(sourceKey)
                console.info('[jj] play source failed', sourceKey, sourceError)
              },
            })
          } catch (error) {
            // A stale probe recommendation must never block auto playback.
            if (preferredLine !== undefined && request.lineIndex === undefined) {
              resolved = await resolveSession(activeTitle, {
                episodeIndex,
                excludeSourceKey: request.excludeSourceKey,
                excludeSourceKeys,
                maxCandidates: request.maxCandidates,
                onSourceFailure: (sourceKey, sourceError) => {
                  const state = autoRecoverRef.current
                  if (state.titleId === title.id) state.failedSources.add(sourceKey)
                  markSourceCooldown(sourceKey)
                  console.info('[jj] play source failed', sourceKey, sourceError)
                },
              })
            } else {
              throw error
            }
          }
          if (playReqRef.current !== requestId) return
          refreshAggregateLines(activeTitle, resolved.detail)
          const mappedEpisodeId =
            activeTitle.mediaType === 'series'
              ? episodeIdForIndex(activeTitle, resolved.episodeIndex)
              : undefined
          setPlayback((current) =>
            current && current.titleId === title.id
              ? {
                  ...current,
                  detail: resolved.detail,
                  target: resolved.target,
                  sourceKey: resolved.target.sourceKey,
                  lineIndex: resolved.lineIndex,
                  episodeIndex: resolved.episodeIndex,
                  episodeNumber:
                    activeTitle.mediaType === 'series' ? resolved.episodeIndex + 1 : undefined,
                  episodeId: mappedEpisodeId,
                  current: request.startAt ?? 0,
                  status: 'loading',
                  error: undefined,
                  autoRecovering: false,
                }
              : current,
          )
          recoverEpochRef.current += 1
          // Keep autoRecoverRef.recovering until playback is stable near the resume point.
          if (
            resolved.clamped &&
            episodeIndex !== undefined &&
            resolved.episodeIndex !== episodeIndex
          ) {
            notify(t('toast.episodeClamped'), 'warn')
          }
          if (resolved.sourceErrors.length > 0) {
            // play_search 对“慢源转后台”也会返回 error；起播成功后不应再弹警告，
            // 只有真正失败的源才提示，避免每次播放都被噪声打断。
            const serious = resolved.sourceErrors.filter(
              (sourceError) => !/超过搜索时限|后台继续/.test(sourceError.message),
            )
            if (serious.length > 0) {
              notify(t('toast.sourcePartial', { count: serious.length }), 'warn')
            }
          }
          const recover = autoRecoverRef.current
          if (recover.titleId === title.id && recover.currentSource !== resolved.target.sourceKey) {
            if (recover.currentSource) {
              recover.triedLines = new Set()
              recover.lineAttempts = 0
            }
            recover.currentSource = resolved.target.sourceKey
          }
          if (request.autoSwitch) {
            const switchedSource =
              resolved.target.sourceKey !== request.previousSourceKey
            const reason = request.autoReason ?? 'failure'
            if (switchedSource) {
              const key =
                reason === 'stall'
                  ? 'toast.stallSourceSwitched'
                  : reason === 'startup'
                    ? 'toast.startupSourceSwitched'
                    : 'toast.sourceSwitched'
              notify(
                t(key, {
                  name: sourceNames[resolved.target.sourceKey] ?? resolved.target.sourceKey,
                }),
                'info',
              )
            } else if (reason === 'stall') {
              notify(t('toast.stallLineSwitched'), 'info')
            } else if (reason === 'startup') {
              notify(t('toast.startupLineSwitched'), 'info')
            }
          }
          prefetchNextEpisode(
            activeTitle,
            resolved.detail,
            resolved.lineIndex,
            resolved.episodeIndex,
            resolved.target.sourceKey,
            resolved.target.vodId,
          )
        } catch (error) {
          if (playReqRef.current !== requestId) return
          clearStartupTimers()
          startupRef.current.done = true
          const state = autoRecoverRef.current
          state.recovering = false
          if (request.autoSwitch) {
            // Stay in recovery: no error overlay until candidates are exhausted.
            setPlayback((current) =>
              current && current.titleId === title.id
                ? {
                    ...current,
                    status: 'loading',
                    error: undefined,
                    playing: false,
                    slowStartup: false,
                    autoRecovering: true,
                  }
                : current,
            )
            scheduleAutoRecover()
            return
          }
          if (reSearchRef.current.titleId !== title.id) {
            reSearchRef.current = { titleId: title.id, done: false }
          }
          if (!reSearchRef.current.done) {
            reSearchRef.current.done = true
            console.info('[jj] candidates exhausted -> re-search once', {
              titleId: title.id,
            })
            setPlayback((current) =>
              current && current.titleId === title.id
                ? {
                    ...current,
                    status: 'loading',
                    error: undefined,
                    playing: false,
                    slowStartup: false,
                    autoRecovering: true,
                  }
                : current,
            )
            window.setTimeout(() => {
              if (playReqRef.current !== requestId) return
              const active = playbackRef.current
              if (!active || active.titleId !== title.id) return
              autoRecoverRef.current.reason = 'failure'
              autoRecoverRef.current.resumePosition = request.startAt ?? 0
              autoRecoverHandlerRef.current?.()
            }, 2500)
            return
          }
          console.info('[jj] candidates exhausted', {
            titleId: title.id,
            failed: [...state.failedSources],
          })
          setPlayback((current) =>
            current && current.titleId === title.id
              ? {
                  ...current,
                  status: 'error',
                  error: errorInfoOf(error),
                  playing: false,
                  slowStartup: false,
                  autoRecovering: false,
                }
              : current,
          )
        }
      })()
    },
    [
      clearStartupTimers,
      ensureDetail,
      flushLiveProgress,
      markSourceCooldown,
      notify,
      prefetchNextEpisode,
      refreshAggregateLines,
      resetAutoRecover,
      scheduleAutoRecover,
      sourceNames,
      startStartupTimers,
      t,
    ],
  )

  const startWatch = useCallback(
    (id: string, episode?: Episode) => {
      const title = resolveTitle(id)
      if (!title) return
      // 搜索结果里的源条目只在真正打开/播放时进入 registry，避免目录污染标题缓存。
      const transient = transientTitlesRef.current.get(id)
      if (transient) register([transient])
      // 双击卡片/播放按钮不应发起两套解析；同一作品同一集 600ms 内只受理一次。
      const startKey = `${id}|${episode?.id ?? ''}`
      const now = Date.now()
      if (lastStartRef.current.key === startKey && now - lastStartRef.current.at < 600) return
      lastStartRef.current = { key: startKey, at: now }

      const saved = progressMapRef.current[id]
      const finished = saved?.finished === true
      const initialEpisode = initialEpisodeFor(title)
      const savedNumber = saved?.episodeId
        ? episodeNumberOf(title, saved.episodeId)
        : undefined
      const episodeId = episode?.id ?? saved?.episodeId ?? initialEpisode?.id
      const episodeIndex =
        episode !== undefined
          ? Math.max(0, episode.number - 1)
          : savedNumber !== undefined
            ? Math.max(0, savedNumber - 1)
            : saved?.episodeIndex
      // 用户显式点选某一集时优先用该集的独立进度；否则沿用标题级“当前集”进度。
      const perEpisode = episodeId
        ? episodeProgressRef.current[id]?.[episodeId]
        : undefined
      const titleCandidate =
        saved &&
        (saved.episodeId === episodeId ||
          (saved.episodeId === undefined &&
            episode?.number !== undefined &&
            saved.episodeIndex === episode.number - 1))
          ? saved
          : undefined
      const explicitSaved =
        episode !== undefined
          ? [perEpisode, titleCandidate]
              .filter((entry): entry is PlaybackProgress => Boolean(entry))
              .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))[0]
          : undefined
      const explicitFinished = explicitSaved?.finished === true
      const startAt =
        episode !== undefined
          ? explicitFinished
            ? 0
            : (explicitSaved?.current ?? 0)
          : finished
            ? 0
            : (saved?.current ?? 0)

      resetAutoRecover(title.id)
      reSearchRef.current = { titleId: title.id, done: false }
      beginPlayback(title, {
        episodeId: title.mediaType === 'series' ? episodeId : undefined,
        episodeNumber:
          title.mediaType === 'series'
            ? (episodeIndex !== undefined ? episodeIndex + 1 : initialEpisode?.number)
            : undefined,
        episodeIndex: title.mediaType === 'series' ? episodeIndex : undefined,
        startAt,
      })
      setDetailId(null)
      setDrawerOpen(false)
      // 静默从上次位置开始会让人以为"怎么从中间播"；超过 30s 才提示，避免噪声。
      const canResume = episode !== undefined ? !explicitFinished : !finished
      if (canResume && startAt > 30) {
        notify(t('toast.resumed', { time: formatTime(startAt) }), 'info')
      }
    },
    [beginPlayback, notify, register, resetAutoRecover, resolveTitle, t],
  )

  const handlePlaybackLiveTime = useCallback(
    (current: number, duration: number) => {
      liveTimeRef.current = { current, duration }
      const state = autoRecoverRef.current
      if (state.recovering && state.resumePosition !== undefined) {
        if (Math.abs(current - state.resumePosition) <= 3) {
          state.resumeReachedAt ??= Date.now()
          if (Date.now() - state.resumeReachedAt >= 3000) {
            // Stable near the resume point: recovery is complete.
            state.recovering = false
            state.resumePosition = undefined
            state.resumeReachedAt = undefined
          }
        } else {
          state.resumeReachedAt = undefined
        }
      }
    },
    [],
  )

  const handlePlaybackFirstFrame = useCallback(() => {
    const startup = startupRef.current
    if (startup.done) return
    startup.done = true
    console.info('[jj] first frame', {
      ms: Date.now() - startup.startedAt,
      titleId: playbackRef.current?.titleId,
    })
    clearStartupTimers()
    setPlayback((value) =>
      value ? { ...value, slowStartup: false, autoRecovering: false } : value,
    )
    // probe 自愈:若当前源的探测全失败但实际已能起播,后台重探一次,
    // 让线路面板的速度/画质标注恢复正常(旧结果会话内不缓存失败态)。
    const session = playbackRef.current
    const title = session ? resolveTitle(session.titleId) : null
    if (session?.target && title) {
      const key = probeKeyFor(session.target.sourceKey, session.target.vodId)
      const existing = probesRef.current[key]
      const allFailed = existing && existing.lines.length > 0 && existing.lines.every((line) => !line.ok)
      if ((!existing || allFailed) && !probeFlightsRef.current.has(key)) {
        probeFlightsRef.current.add(key)
        void playProbe(session.target.sourceKey, session.target.vodId)
          .then((result) => setProbes((previous) => ({ ...previous, [key]: result })))
          .catch(() => undefined)
          .finally(() => probeFlightsRef.current.delete(key))
      }
    }
  }, [clearStartupTimers, resolveTitle])

  // 换集瞬间 Theater 会补发上一集的最终快照（episodeId 是旧集）：
  // 这种快照只写进进度表，绝不写回当前播放状态，否则新集会被旧位置污染。
  //
  // 落库节流：Theater 每 5s 上报一次，若每次都写进 progressMap，整个列表会跟着
  // 每 5s 重渲染一次（播放时列表被 Theater 盖住，纯属白烧 CPU）。改为 60s 落一次，
  // 关闭/暂停/结束时强制落一次，最坏只丢 60s 进度。
  const handlePlaybackProgress = useCallback(
    (current: number, duration: number, episodeId?: string, episodeIndex?: number) => {
      const session = playbackRef.current
      if (!session) return
      const matchesSession = episodeId === undefined || episodeId === session.episodeId
      if (matchesSession) {
        liveProgressRef.current = {
          titleId: session.titleId,
          episodeId: session.episodeId,
          episodeIndex: session.episodeIndex,
          current,
          duration,
        }
        flushLiveProgress()
        // 不再把 current 写回 App state：Theater 自己显示实时位置，
        // 这里每 5s setPlayback 会让整个列表重新 diff，和 60s 落库节流的目标相违。
      } else {
        saveProgress(session.titleId, episodeId, episodeIndex, current, duration)
      }
    },
    [flushLiveProgress, saveProgress],
  )

  const handlePlaybackStatus = useCallback(
    (status: PlaybackStatus) => {
      // 暂停/结束是天然落库点：此刻用户很可能离开，不该等 60s 节流。
      if (status === 'paused' || status === 'ended') flushLiveProgress(true)
      // paused/ready/ended 说明启动阶段已经结束（ready 可能是自动播放被拦截，
      // 视频在等用户点击）。继续跑启动看门狗会在 10s 后误换源。
      if (status === 'paused' || status === 'ended' || status === 'ready') {
        clearStartupTimers()
        startupRef.current.done = true
        setPlayback((current) =>
          current
            ? {
                ...current,
                slowStartup: false,
                autoRecovering: false,
                status,
                playing: status === 'paused' || status === 'ended' ? false : current.playing,
              }
            : current,
        )
        return
      }
      setPlayback((current) => {
        if (!current || current.status === status) return current
        return {
          ...current,
          status,
          playing: status === 'playing' || status === 'buffering',
        }
      })
    },
    [clearStartupTimers, flushLiveProgress],
  )

  const handleMediaError = useCallback(
    (error: PlayErrorInfo) => {
      const session = playbackRef.current
      clearStartupTimers()
      startupRef.current.done = true
      if (!session) return
      // unsupported 也先尝试同源其他线路/其他源，不要立刻把用户钉在错误遮罩上。
      // 只有自动恢复耗尽后，resolve 层才会给出最终 unsupported/no-source。
      if (autoRecoverRef.current.titleId !== session.titleId) {
        resetAutoRecover(session.titleId)
      }
      const state = autoRecoverRef.current
      state.reason = error.detail?.includes('stalled') ? 'stall' : 'failure'
      if (state.resumePosition === undefined) state.resumePosition = liveCurrent()
      console.info(
        error.detail?.includes('stalled')
          ? '[jj] stalled 8s -> auto switch'
          : '[jj] load failed -> auto switch',
        {
          titleId: session.titleId,
          sourceKey: session.sourceKey,
          lineIndex: session.lineIndex,
          position: session.current,
          detail: error.detail,
        },
      )
      if (!navigator.onLine) {
        console.info('[jj] network offline -> waiting for online', {
          titleId: session.titleId,
          position: state.resumePosition,
        })
        setPlayback((current) =>
          current
            ? {
                ...current,
                status: 'loading',
                error: undefined,
                playing: false,
                slowStartup: false,
                autoRecovering: true,
              }
            : current,
        )
        return
      }
      if (session.sourceKey) {
        state.failedSources.add(session.sourceKey)
        markSourceCooldown(session.sourceKey)
      }
      state.recovering = false
      // Unified path: never show an error overlay before auto switching is exhausted.
      setPlayback((current) =>
        current
          ? {
              ...current,
              status: 'loading',
              error: undefined,
              playing: false,
              slowStartup: false,
              autoRecovering: true,
            }
          : current,
      )
      scheduleAutoRecover()
    },
    [clearStartupTimers, markSourceCooldown, resetAutoRecover, scheduleAutoRecover],
  )

  const retryPlayback = useCallback(() => {
    const current = playbackRef.current
    if (!current) return
    const title = resolveTitle(current.titleId)
    if (!title) return
    // 实时位置只存在 liveTimeRef；自动换源失败后 liveTimeRef 可能已被失败尝试写成 0，
// 此时应优先保留 autoRecover 记录的故障位置。重试前必须快照，否则会回到起点。
    const recover = autoRecoverRef.current
    const resumeAt =
      recover.titleId === current.titleId && recover.resumePosition !== undefined
        ? recover.resumePosition
        : liveCurrent()
    resetAutoRecover(current.titleId)
    if (current.target) {
      const requestId = playReqRef.current + 1
      playReqRef.current = requestId
      startStartupTimers(requestId)
      setPlayback((state) =>
        state
          ? {
              ...state,
              current: resumeAt,
              error: undefined,
              status: 'loading',
              slowStartup: false,
              autoRecovering: false,
              retryNonce: (state.retryNonce ?? 0) + 1,
            }
          : state,
      )
      return
    }
    beginPlayback(title, {
      episodeId: current.episodeId,
      episodeNumber: current.episodeNumber,
      episodeIndex: current.episodeIndex,
      startAt: resumeAt,
      detail: current.detail,
    })
  }, [beginPlayback, liveCurrent, resetAutoRecover, resolveTitle])

  const switchLine = useCallback(
    (lineIndex: number) => {
      const current = playbackRef.current
      if (!current?.detail) return
      const title = resolveTitle(current.titleId)
      if (!title) return
      const line = current.detail.lines[lineIndex]
      if (!line) return
      if (!isPlayableLine(line)) {
        notify(t('toast.linePageOnly'), 'warn')
        return
      }
      const target = Math.min(current.episodeIndex ?? 0, line.episodes.length - 1)
      const episodeIndex = playableEpisodeIndex(line, target)
      if (episodeIndex === null) {
        notify(t('toast.linePageOnly'), 'warn')
        return
      }
      resetAutoRecover(current.titleId)
      beginPlayback(title, {
        episodeId: current.episodeId,
        episodeNumber: title.mediaType === 'series' ? episodeIndex + 1 : undefined,
        episodeIndex,
        lineIndex,
        startAt: liveCurrent(),
        detail: current.detail,
        stayOnSource: true,
      })
    },
    [beginPlayback, liveCurrent, notify, resetAutoRecover, resolveTitle, t],
  )

  const switchSource = useCallback(() => {
    const current = playbackRef.current
    if (!current) return
    const title = resolveTitle(current.titleId)
    if (!title) return
    const episodeIndex = current.episodeIndex ?? 0
    resetAutoRecover(current.titleId)
    beginPlayback(title, {
      episodeId: current.episodeId,
      episodeNumber: title.mediaType === 'series' ? episodeIndex + 1 : undefined,
      episodeIndex,
      excludeSourceKey: current.sourceKey,
      startAt: liveCurrent(),
    })
  }, [beginPlayback, liveCurrent, resetAutoRecover, resolveTitle])

  const selectSourceEpisode = useCallback(
    (index: number) => {
      const current = playbackRef.current
      if (!current?.detail) return
      const title = resolveTitle(current.titleId)
      if (!title) return
      const line = current.detail.lines[current.lineIndex ?? 0]
      if (!line || !isPlayableEpisode(line.episodes[index])) return
      const episodeId =
        title.mediaType === 'series' ? episodeIdForIndex(title, index) : undefined
      const titleSaved = progressMapRef.current[title.id]
      const saved =
        (episodeId ? episodeProgressRef.current[title.id]?.[episodeId] : undefined) ??
        (titleSaved?.episodeId === episodeId ? titleSaved : undefined)
      resetAutoRecover(current.titleId)
      beginPlayback(title, {
        episodeId,
        episodeNumber: title.mediaType === 'series' ? index + 1 : undefined,
        episodeIndex: index,
        lineIndex: current.lineIndex,
        startAt: saved && !saved.finished ? saved.current : 0,
        detail: current.detail,
        stayOnSource: true,
      })
    },
    [beginPlayback, resetAutoRecover, resolveTitle],
  )

  // 线路面板跨源切换:直接使用聚合时缓存的 detail,并强制 resolveSession 选中该源。
  const switchToLine = useCallback(
    (sourceKey: string, lineIndex: number) => {
      const current = playbackRef.current
      if (!current) return
      const title = resolveTitle(current.titleId)
      if (!title) return
      const entry = aggregateLinesRef.current.find(
        (item) => item.sourceKey === sourceKey && item.lineIndex === lineIndex,
      )
      resetAutoRecover(current.titleId)
      beginPlayback(title, {
        episodeId: current.episodeId,
        episodeIndex: current.episodeIndex,
        lineIndex,
        startAt: liveCurrent(),
        detail: entry?.detail,
        stayOnSource: true,
        preferredSourceKey: sourceKey,
      })
    },
    [beginPlayback, liveCurrent, resetAutoRecover, resolveTitle],
  )

  const handlePlaybackEnded = useCallback(() => {
    const current = playbackRef.current
    if (!current) return
    const title = resolveTitle(current.titleId)
    if (!title || title.mediaType !== 'series') {
      setPlayback((state) => (state ? { ...state, status: 'ended', playing: false } : state))
      return
    }
    const line = current.detail?.lines?.[current.lineIndex ?? 0]
    const nextIndex = line
      ? nextPlayableEpisodeIndex(line, (current.episodeIndex ?? 0) + 1)
      : null
    if (line && nextIndex !== null) {
      if (!autoplayNextRef.current) {
        setPlayback((state) => (state ? { ...state, status: 'ended', playing: false } : state))
        return
      }
      resetAutoRecover(title.id)
      beginPlayback(title, {
        episodeId: episodeIdForIndex(title, nextIndex),
        episodeNumber: nextIndex + 1,
        episodeIndex: nextIndex,
        lineIndex: current.lineIndex,
        startAt: 0,
        detail: current.detail,
        stayOnSource: true,
      })
      return
    }
    setPlayback((state) => (state ? { ...state, status: 'ended', playing: false } : state))
  }, [beginPlayback, resetAutoRecover, resolveTitle])

  const handleAutoRecover = useCallback(() => {
    const current = playbackRef.current
    if (!current) return
    const title = resolveTitle(current.titleId)
    if (!title) return
    if (autoRecoverRef.current.titleId !== current.titleId) {
      resetAutoRecover(current.titleId)
    }
    const state = autoRecoverRef.current
    if (!navigator.onLine) {
      console.info('[jj] network offline -> waiting for online', {
        titleId: current.titleId,
        position: state.resumePosition ?? current.current,
      })
      setPlayback((value) =>
        value
          ? {
              ...value,
              status: 'loading',
              error: undefined,
              slowStartup: false,
              autoRecovering: true,
            }
          : value,
      )
      return
    }
    if (state.recovering) return
    state.recovering = true
    state.autoAttempts += 1
    const epochAtStart = recoverEpochRef.current
    const finishNoSource = () => {
      if (recoverEpochRef.current !== epochAtStart) {
        // A newer target resolved while this decision was in flight.
        return
      }
      state.recovering = false
      clearStartupTimers()
      startupRef.current.done = true
      console.info('[jj] candidates exhausted', {
        titleId: current.titleId,
        failed: [...state.failedSources],
        attempts: state.autoAttempts,
      })
      setPlayback((value) =>
        value
          ? {
              ...value,
              status: 'error',
              error: { code: 'no-source' },
              playing: false,
              slowStartup: false,
              autoRecovering: false,
              target: undefined,
            }
          : value,
      )
    }
    if (state.autoAttempts > 4) {
      finishNoSource()
      return
    }
    if (!current.sourceKey && !current.detail && state.autoAttempts > 1) {
      finishNoSource()
      return
    }
    if (current.sourceKey && state.currentSource !== current.sourceKey) {
      state.currentSource = current.sourceKey
      state.triedLines = new Set()
      state.lineAttempts = 0
    }
    if (state.resumePosition === undefined) state.resumePosition = liveCurrent()
    const position = state.resumePosition
    if (state.failedSources.size >= 3) {
      finishNoSource()
      return
    }
    // Playback failure: try one more playable line on the same source first.
    if (state.lineAttempts < 1 && current.detail) {
      const lineIndex = current.lineIndex ?? 0
      const nextLine = current.detail.lines.findIndex(
        (line, index) => index !== lineIndex && isPlayableLine(line) && !state.triedLines.has(index),
      )
      if (nextLine >= 0) {
        state.triedLines.add(nextLine)
        state.lineAttempts += 1
        console.info('[jj] switch line', {
          reason: state.reason,
          titleId: current.titleId,
          from: current.lineIndex,
          to: nextLine,
          position,
        })
        beginPlayback(title, {
          episodeId: current.episodeId,
          episodeNumber: current.episodeNumber,
          episodeIndex: current.episodeIndex,
          lineIndex: nextLine,
          startAt: position,
          detail: current.detail,
          autoSwitch: true,
          stayOnSource: true,
          previousSourceKey: current.sourceKey,
          autoReason: state.reason,
        })
        return
      }
    }
    if (current.sourceKey) {
      state.failedSources.add(current.sourceKey)
      markSourceCooldown(current.sourceKey)
    }
    if (state.failedSources.size >= 3) {
      finishNoSource()
      return
    }
    state.lineAttempts = 0
    state.triedLines = new Set()
    state.currentSource = ''
    console.info('[jj] switch source', {
      reason: state.reason,
      titleId: current.titleId,
      from: current.sourceKey,
      tried: [...state.failedSources],
      position,
    })
    beginPlayback(title, {
      episodeId: current.episodeId,
      episodeNumber: current.episodeNumber,
      episodeIndex: current.episodeIndex,
      startAt: position,
      excludeSourceKey: current.sourceKey,
      excludeSourceKeys: [...state.failedSources],
      autoSwitch: true,
      previousSourceKey: current.sourceKey,
      maxCandidates: Math.max(1, 3 - state.failedSources.size),
      autoReason: state.reason,
    })
  }, [beginPlayback, clearStartupTimers, liveCurrent, markSourceCooldown, resetAutoRecover, resolveTitle])
  autoRecoverHandlerRef.current = handleAutoRecover
  const triggerStallSwitch = useCallback(
    (message: string, extra: Record<string, unknown>) => {
      const current = playbackRef.current
      if (!current) return
      if (autoRecoverRef.current.titleId !== current.titleId) {
        resetAutoRecover(current.titleId)
      }
      const state = autoRecoverRef.current
      state.reason = 'stall'
      state.recovering = false
      if (state.resumePosition === undefined) state.resumePosition = liveCurrent()
      console.info(message, {
        ...extra,
        titleId: current.titleId,
        sourceKey: current.sourceKey,
        lineIndex: current.lineIndex,
        position: current.current,
      })
      setPlayback((value) =>
        value
          ? {
              ...value,
              status: 'loading',
              error: undefined,
              playing: false,
              slowStartup: false,
              autoRecovering: true,
            }
          : value,
      )
      handleAutoRecover()
    },
    [handleAutoRecover, liveCurrent, resetAutoRecover],
  )

  const handleShortBuffer = useCallback((stallMs: number) => {
    const current = playbackRef.current
    if (!current) return
    console.info('[jj] real rebuffer, keep waiting', {
      titleId: current.titleId,
      sourceKey: current.sourceKey,
      lineIndex: current.lineIndex,
      position: current.current,
      stallMs,
    })
  }, [])

  const handleRebufferSwitch = useCallback(
    (count: number) => {
      triggerStallSwitch('[jj] rebuffer 2/5min -> switch', { count })
    },
    [triggerStallSwitch],
  )

  const handleSingleStall = useCallback(() => {
    triggerStallSwitch('[jj] single stall 60s -> switch', {})
  }, [triggerStallSwitch])

  const handleNavigate = (next: ViewKey) => {
    setView(next)
    updateQuery('')
    setDrawerOpen(false)
    window.requestAnimationFrame(() => {
      const scroller = document.querySelector<HTMLElement>('.main-scroll')
      if (scroller) scroller.scrollTop = 0
    })
    if (FEED_VIEWS.includes(next)) {
      setFeeds((previous) =>
        previous[next]
          ? previous
          : {
            ...previous,
            [next]: {
              ids: [],
              loading: true,
              error: false,
              empty: false,
              partial: false,
            },
          },
      )
    }
  }

  const nameOf = useCallback(
    (id: string) => {
      const title = resolveTitle(id)
      return title ? titleName(title, language) : ''
    },
    [language, resolveTitle],
  )

  const toggleList = useCallback(
    (id: string) => {
      const transient = transientTitlesRef.current.get(id)
      if (transient) register([transient])
      const added = !myList.includes(id)
      const name = nameOf(id)
      setMyList(added ? [id, ...myList] : myList.filter((item) => item !== id))
      notify(
        added
          ? t('toast.addedToList', { name })
          : t('toast.removedFromList', { name }),
      )
    },
    [myList, nameOf, notify, register, setMyList, t],
  )

  const toggleLater = useCallback(
    (id: string) => {
      const transient = transientTitlesRef.current.get(id)
      if (transient) register([transient])
      const added = !later.includes(id)
      const name = nameOf(id)
      setLater(added ? [id, ...later] : later.filter((item) => item !== id))
      notify(
        added
          ? t('toast.addedToLater', { name })
          : t('toast.removedFromLater', { name }),
      )
    },
    [later, nameOf, notify, register, setLater, t],
  )

  const toggleLike = useCallback(
    (id: string) => {
      const transient = transientTitlesRef.current.get(id)
      if (transient) register([transient])
      const added = !liked.includes(id)
      const name = nameOf(id)
      setLiked(added ? [id, ...liked] : liked.filter((item) => item !== id))
      notify(added ? t('toast.liked', { name }) : t('toast.ratingRemoved'))
    },
    [liked, nameOf, notify, register, setLiked, t],
  )

  const toggleSource = useCallback(
    async (key: string) => {
      const source = sourceInfos.find((entry) => entry.key === key)
      if (!source) return
      try {
        const list = await setPlaySourceEnabled(key, !source.enabled)
        setSourceInfos(list)
        notify(
          t(source.enabled ? 'toast.sourceDisabled' : 'toast.sourceEnabled', {
            name: source.name,
          }),
          'info',
        )
      } catch {
        notify(t('toast.sourceToggleFailed'), 'warn')
      }
    },
    [notify, sourceInfos, t],
  )

  const openDetail = useCallback(
    (id: string) => {
      const transient = transientTitlesRef.current.get(id)
      if (transient) register([transient])
      setDetailId(id)
    },
    [register],
  )

  const detailTitle = detailId ? resolveTitle(detailId) : null
  const playingTitle = playback ? resolveTitle(playback.titleId) : null
  const playbackProbe = playback?.target
    ? probes[probeKeyFor(playback.target.sourceKey, playback.target.vodId)]
    : undefined
  const playbackProbeLine =
    playbackProbe && playback?.lineIndex !== undefined
      ? playbackProbe.lines.find((line) => line.lineIndex === playback.lineIndex)
      : undefined

  useEffect(() => {
    if (detailTitle) void ensureDetail(detailTitle)
  }, [detailTitle, ensureDetail])

  const ensureProbe = useCallback(async (title: Title) => {
    if (probeTriedRef.current.has(title.id)) return
    probeTriedRef.current.add(title.id)
    try {
      let sourceKey = ''
      let vodId = ''
      const match = readMatch(title.id)
      const validMatch =
        match && matchFitsTitle(title, match) ? match : null
      // 详情页只对“已经有匹配结果”的标题做后台探测；
      // 没有匹配时不在这里跑全源搜索，避免打开详情 3 秒就触发一次解析风暴。
      if (!validMatch) {
        probeTriedRef.current.delete(title.id)
        return
      }
      sourceKey = validMatch.sourceKey
      vodId = validMatch.vodId
      // probe 只读本地详情缓存；先把详情拉进缓存，首次探测才不会空转。
      try {
        await playDetail(sourceKey, vodId)
      } catch {
        // resolveSession/播放阶段还会再次尝试
      }
      const key = probeKeyFor(sourceKey, vodId)
      if (probesRef.current[key] || probeFlightsRef.current.has(key)) return
      probeFlightsRef.current.add(key)
      try {
        const result = await playProbe(sourceKey, vodId)
        setProbes((previous) => ({ ...previous, [key]: result }))
      } finally {
        probeFlightsRef.current.delete(key)
      }
    } catch (error) {
      probeTriedRef.current.delete(title.id)
      console.info('[jj] play probe skipped', error)
    }
  }, [])

  useEffect(() => {
    if (!detailTitle) return
    // Debounced background prefetch: search/detail/target + probe, never blocking the modal.
    // 6s:短暂路过详情页不值得付出全源搜索与分片探测的流量。
    const title = detailTitle
    const timer = window.setTimeout(() => {
      void ensureProbe(title)
    }, 6000)
    return () => window.clearTimeout(timer)
  }, [detailTitle, ensureProbe])

  const recentItems = useMemo(() => {
    return Object.entries(progressMap)
      .filter(([, value]) => (value?.current ?? 0) > 30 && !value?.finished)
      .sort((left, right) => (right[1].updatedAt ?? 0) - (left[1].updatedAt ?? 0))
      .map(([id]) => registry[id])
      .filter((title): title is Title => Boolean(title))
  }, [progressMap, registry])

  const homeItems = useMemo(() => feedItems('home'), [feedItems])
  const browseFeedItems = useMemo(
    () => (view === 'home' ? homeItems : feedItems(view)),
    [feedItems, homeItems, view],
  )

  const heroSlides = useMemo(() => {
    const films = homeItems.filter((title) => title.mediaType === 'film')
    const featured = (films.length > 0 ? films : homeItems).slice(0, 3)
    if (featured.length === 0) {
      return []
    }
    return featured.map((item, index) => {
      // 侧卡从"非当前 featured"的池子里取：只有 1 部片时宁可留空，
      // 也不要把同一张卡在 hero 右侧再摆一遍。
      const pool = homeItems.filter((entry) => entry.id !== item.id)
      const first = pool.length > 0 ? pool[index * 2 % pool.length].id : ''
      const second = pool.length > 1 ? pool[(index * 2 + 1) % pool.length].id : ''
      return { featuredId: item.id, sideIds: [first, second] as [string, string] }
    })
  }, [feeds.home?.loading, homeItems])

  const heroFocusId = heroSlides[Math.min(slideIndex, heroSlides.length - 1)]?.featuredId
  useEffect(() => {
    if (!heroFocusId) return
    const title = resolveTitle(heroFocusId)
    if (title) ensureDetail(title)
  }, [ensureDetail, heroFocusId, resolveTitle])

  const related = useMemo(() => {
    if (!detailTitle) return []
    const pool = Object.values(registry).filter((title) => title.id !== detailTitle.id)
    const genreHits = pool.filter((title) =>
      title.genres.some((genre) => detailTitle.genres.includes(genre)),
    )
    return (genreHits.length > 0 ? genreHits : pool).slice(0, 3)
  }, [detailTitle, registry])

  return (
    <div className={cx('scene', !lights && 'room-dim')}>
      <div className="room-bg" aria-hidden />
      <div className="room-tint" aria-hidden />
      <RoomSwitch on={lights} onToggle={() => setLights(!lights)} />

      <div className="app-frame">
        {isDesktopApp && <TitleBar />}

        <div className="app-panel">
        <Sidebar
          active={view}
          query={query}
          open={drawerOpen}
          composing={queryComposing}
          onNavigate={handleNavigate}
          onQuery={updateQuery}
          onCompositionChange={setQueryComposing}
          onClose={() => setDrawerOpen(false)}
        />

        <main className="main">
          <div className="main-scroll">
            <div className="topline">
              <div className="topline-left">
                <button
                  type="button"
                  className="mobile-menu"
                  aria-label={t('nav.open')}
                  onClick={() => setDrawerOpen(true)}
                >
                  <Menu size={19} />
                </button>

                {searching || view !== 'home' ? (
                  <button
                    type="button"
                    className="crumb-back"
                    onClick={() => handleNavigate('home')}
                  >
                    <ArrowLeft size={15} aria-hidden />
                    {t('top.home')}
                  </button>
                ) : (
                  <div className="topline-title">
                    <h1>{t('top.featured')}</h1>
                    <button
                      type="button"
                      className="section-chevron"
                      aria-label={t('top.nextFeatured')}
                      onClick={() =>
                        setSlideIndex((index) =>
                          heroSlides.length ? (index + 1) % heroSlides.length : 0,
                        )
                      }
                    >
                      <ChevronRight size={18} strokeWidth={2.1} />
                    </button>
                  </div>
                )}
              </div>

              <button
                type="button"
                className="settings-button"
                aria-label={t('nav.settings')}
                title={t('nav.settings')}
                onClick={() => handleNavigate('settings')}
              >
                <Settings size={16} strokeWidth={1.8} aria-hidden />
              </button>
            </div>

            <div className="view-shell" key={`${view}-${searching ? 'search' : 'browse'}`}>
              {searching ? (
                <SearchView
                  query={query.trim()}
                  results={searchResults}
                  busy={searchBusy}
                  partialErrors={searchSourceErrors}
                  error={searchError}
                  myList={myList}
                  progressFor={progressFor}
                  onOpen={openDetail}
                  onPlay={startWatch}
                  onToggleList={toggleList}
                  onClear={() => updateQuery('')}
                  onRetry={() => setSearchNonce((value) => value + 1)}
                />
              ) : view === 'home' ? (
                <HomeView
                  slideIndex={slideIndex}
                  slides={heroSlides}
                  items={homeItems}
                  continueItems={recentItems.slice(0, 6)}
                  feed={feeds.home ?? emptyFeed}
                  myList={myList}
                  progressFor={progressFor}
                  resolveTitle={resolveTitle}
                  onSlide={setSlideIndex}
                  onNavigate={handleNavigate}
                  onOpen={openDetail}
                  onPlay={startWatch}
                  onToggleList={toggleList}
                  onRetry={() => void loadFeed('home', true)}
                />
              ) : (
                <BrowseView
                  view={view}
                  feed={feeds[view] ?? emptyFeed}
                  feedItems={browseFeedItems}
                  resolveTitle={resolveTitle}
                  recentItems={recentItems}
                  sources={sourceInfos}
                  sourcesLoaded={sourcesLoaded}
                  sourcesFailed={sourcesFailed}
                  onReloadSources={() => void loadSources()}
                  onToggleSource={toggleSource}
                  feedExhausted={Boolean(feedExhaustedMap[view])}
                  autoplayNext={autoplayNext}
                  onToggleAutoplay={() => setAutoplayNext((value) => !value)}
                  myList={myList}
                  later={later}
                  progressFor={progressFor}
                  onLoadMore={loadMoreForView}
                  onNavigate={handleNavigate}
                  onOpen={openDetail}
                  onPlay={startWatch}
                  onToggleList={toggleList}
                  onRetry={() => void loadFeed(view, true)}
                  onRegister={register}
                />
              )}
            </div>
          </div>
        </main>
        </div>
      </div>

      {detailTitle && (
        <DetailModal
          title={detailTitle}
          related={related}
          inList={myList.includes(detailTitle.id)}
          inLater={later.includes(detailTitle.id)}
          liked={liked.includes(detailTitle.id)}
          progress={progressFor(detailTitle.id)}
          onClose={() => setDetailId(null)}
          onPlay={startWatch}
          onToggleList={toggleList}
          onToggleLater={toggleLater}
          onToggleLike={toggleLike}
          onOpenRelated={setDetailId}
        />
      )}

      {playback && playingTitle && (
        <Suspense fallback={null}>
          <Theater
            title={playingTitle}
            playback={playback}
            probe={playbackProbe}
            sourceName={playback.sourceKey ? sourceNames[playback.sourceKey] : undefined}
            allLines={aggregateLines}
            expectedDuration={
              playingTitle?.mediaType === 'film' ? playbackProbeLine?.durationSec : undefined
            }
            onClose={closePlayback}
            onProgress={handlePlaybackProgress}
            onLiveTime={handlePlaybackLiveTime}
            onFirstFrame={handlePlaybackFirstFrame}
            onStatus={handlePlaybackStatus}
            onMediaError={handleMediaError}
            onShortBuffer={handleShortBuffer}
            onRebufferSwitch={handleRebufferSwitch}
            onSingleStall={handleSingleStall}
            onStartupActivity={handleStartupActivity}
            onRetry={retryPlayback}
            onSwitchLine={switchLine}
            onSwitchToLine={switchToLine}
            onSwitchSource={switchSource}
            onPlayEpisode={(episode) => startWatch(playingTitle.id, episode)}
            onSelectSourceEpisode={selectSourceEpisode}
            onEnded={handlePlaybackEnded}
          />
        </Suspense>
      )}

      {toast && (
        <div className={cx('toast', `toast--${toast.tone}`)} role="status" key={toast.id}>
          <span className="toast-icon">
            {toast.tone === 'warn' ? (
              <AlertTriangle size={13} strokeWidth={2.6} aria-hidden />
            ) : toast.tone === 'info' ? (
              <Info size={13} strokeWidth={2.6} aria-hidden />
            ) : (
              <Check size={13} strokeWidth={3} aria-hidden />
            )}
          </span>
          {toast.message}
        </div>
      )}

      <BackToTop view={view} />
    </div>
  )
}

function BackToTop({ view }: { view: ViewKey }) {
  const { t } = useI18n()
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const scroller = document.querySelector('.main-scroll') as HTMLElement | null
    if (!scroller) return
    const update = () => setVisible(scroller.scrollTop > 360)
    update()
    scroller.addEventListener('scroll', update, { passive: true })
    return () => scroller.removeEventListener('scroll', update)
  }, [view])

  if (!visible) return null

  return (
    <button
      type="button"
      className="back-to-top"
      aria-label={t('common.backToTop')}
      title={t('common.backToTop')}
      onClick={() => {
        const scroller = document.querySelector('.main-scroll')
        if (scroller) scroller.scrollTo({ top: 0, behavior: 'smooth' })
      }}
    >
      <ArrowUp size={18} strokeWidth={2.2} aria-hidden />
    </button>
  )
}
