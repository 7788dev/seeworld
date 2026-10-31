import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Check, ChevronRight, Menu, Settings } from 'lucide-react'
import BrowseView from './components/BrowseView'
import DetailModal from './components/DetailModal'
import HomeView from './components/HomeView'
import RoomSwitch from './components/RoomSwitch'
import SearchView from './components/SearchView'
import Sidebar from './components/Sidebar'
import Theater from './components/Theater'
import TitleBar from './components/TitleBar'
import { initialEpisodeFor, titleName } from './content'
import type { Episode, Title, ViewKey } from './data'
import {
  DOUBAN_FEEDS,
  applyDetail,
  dbCardImg,
  dbHeroImg,
  fetchDoubanDetail,
  fetchDoubanList,
  fetchDoubanSuggest,
  subjectToTitle,
  suggestToTitle,
} from './douban'
import type { FeedState } from './douban'
import { useI18n } from './i18n'
import { cx, isDesktopApp, stripHtml, usePersistentState } from './lib'
import {
  episodeIdForIndex,
  episodeNumberOf,
  writeMatch,
  errorInfoOf,
  isPlayableEpisode,
  isPlayableLine,
  isAnimeTitle,
  matchTitleName,
  nextPlayableEpisodeIndex,
  playableEpisodeIndex,
  playProbe,
  playResolve,
  playSearch,
  playSources,
  readMatch,
  resolveSession,
} from './play'
import type {
  PlayDetail,
  PlaySearchItem,
  PlayErrorInfo,
  PlayProbeResult,
  PlayTarget,
  ResolvedSession,
} from './play'
import type { PlaybackProgress, PlaybackState, PlaybackStatus } from './types'

const TITLE_CACHE_KEY = 'jj-title-cache'
const FEED_CACHE_KEY = 'jj-feed-cache'
const FEED_TTL = 5 * 60 * 1000

interface CachedFeed {
  ids: string[]
  updatedAt: number
}

const readFeedCache = (): Record<string, CachedFeed> => {
  try {
    const stored = localStorage.getItem(FEED_CACHE_KEY)
    return stored ? (JSON.parse(stored) as Record<string, CachedFeed>) : {}
  } catch {
    return {}
  }
}

const cachedFeeds = readFeedCache()
const cachedFeedTimes = Object.fromEntries(
  Object.entries(cachedFeeds).map(([key, entry]) => [key, entry.updatedAt ?? 0]),
) as Record<string, number>

const initialFeedState = (): Record<string, FeedState> => {
  const state: Record<string, FeedState> = {}
  for (const [key, entry] of Object.entries(cachedFeeds)) {
    if (entry.ids?.length > 0) {
      state[key] = { ids: entry.ids, loading: false, error: false }
    }
  }
  state.home ??= { ids: [], loading: true, error: false }
  return state
}

const migrateCachedTitle = (title: Title): Title => {
  if (!title.id.startsWith('db-')) return title
  const poster = dbCardImg(title.poster ?? '')
  const hero = dbHeroImg(title.hero || title.poster || '')
  if (poster === title.poster && hero === title.hero && title.ageRating === '') {
    return title
  }
  return { ...title, poster, hero, ageRating: '' }
}

const readTitleCache = (): Record<string, Title> => {
  try {
    const stored = localStorage.getItem(TITLE_CACHE_KEY)
    if (!stored) return {}
    const parsed = JSON.parse(stored) as Record<string, Title>
    return Object.fromEntries(
      Object.entries(parsed).map(([id, title]) => [id, migrateCachedTitle(title)]),
    )
  } catch {
    return {}
  }
}

const emptyFeed: FeedState = { ids: [], loading: false, error: false, exhausted: false }

const FEED_VIEWS: ViewKey[] = ['new', 'tv', 'movies', 'anime']

const prefetchKey = (titleId: string, lineIndex: number, episodeIndex: number) =>
  `${titleId}|${lineIndex}|${episodeIndex}`

const probeKeyFor = (sourceKey: string, vodId: string) => `${sourceKey}|${vodId}`

export default function App() {
  const { language, t } = useI18n()
  const [view, setView] = useState<ViewKey>('home')
  const [query, setQuery] = useState('')
  const [slideIndex, setSlideIndex] = useState(0)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [playback, setPlayback] = useState<PlaybackState | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [toast, setToast] = useState<{ id: number; message: string } | null>(null)

  const [myList, setMyList] = usePersistentState<string[]>('jj-my-list', [])
  const [later, setLater] = usePersistentState<string[]>('jj-watch-later', [])
  const [downloads, setDownloads] = usePersistentState<string[]>('jj-downloads', [])
  const [liked, setLiked] = usePersistentState<string[]>('jj-liked', [])
  const [lights, setLights] = usePersistentState<boolean>('jj-lights', true)
  const [autoplayNext, setAutoplayNext] = usePersistentState<boolean>('jj-autoplay-next', true)
  const [danmakuOn, setDanmakuOn] = usePersistentState<boolean>('jj-danmaku-on', true)
  const [networkProxy, setNetworkProxy] = usePersistentState<string>('jj-network-proxy', '')
  useEffect(() => {
    if (!isDesktopApp) return
    void import('./play').then(({ setNetworkProxy }) =>
      setNetworkProxy(networkProxy.trim() ? networkProxy.trim() : null),
    )
  }, [networkProxy])
  const autoplayNextRef = useRef(true)
  useEffect(() => {
    autoplayNextRef.current = autoplayNext
  }, [autoplayNext])
  const [progressMap, setProgressMap] = usePersistentState<Record<string, PlaybackProgress>>(
    'jj-progress',
    {},
  )

  const [registry, setRegistry] = useState<Record<string, Title>>(readTitleCache)
  const [feeds, setFeeds] = useState<Record<string, FeedState>>(initialFeedState)
  const feedUpdatedRef = useRef<Record<string, number>>(cachedFeedTimes)
  const [searchResults, setSearchResults] = useState<Title[]>([])
  const [searchBusy, setSearchBusy] = useState(false)
  const [probes, setProbes] = useState<Record<string, PlayProbeResult>>({})
  const probesRef = useRef<Record<string, PlayProbeResult>>({})
  useEffect(() => {
    probesRef.current = probes
  }, [probes])
  const probeFlightsRef = useRef<Set<string>>(new Set())
  const probeTriedRef = useRef<Set<string>>(new Set())
  const [sourceNames, setSourceNames] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!isDesktopApp) return
    void playSources()
      .then((list) => {
        setSourceNames(Object.fromEntries(list.map((source) => [source.key, source.name])))
      })
      .catch(() => undefined)
  }, [])

  const feedsRef = useRef<Record<string, FeedState>>({})
  useEffect(() => {
    feedsRef.current = feeds
  }, [feeds])

  const inflightRef = useRef<Set<string>>(new Set())
  const feedOffsetsRef = useRef<Record<string, number[]>>({})
  const [feedExhaustedMap, setFeedExhaustedMap] = useState<Record<string, boolean>>({})

  useEffect(() => {
    try {
      localStorage.setItem(TITLE_CACHE_KEY, JSON.stringify(registry))
    } catch {
      // storage quota exceeded — keep only the freshest 300 entries
      try {
        const trimmed = Object.values(registry).slice(-300)
        localStorage.setItem(TITLE_CACHE_KEY, JSON.stringify(Object.fromEntries(trimmed.map((entry) => [entry.id, entry]))))
      } catch {
        // give up persisting this round
      }
    }
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
        const richer =
          (title.synopsis && !existing.synopsis) ||
          (title.cast.length > 0 && existing.cast.length === 0) ||
          (title.genres.length > 0 && existing.genres.length === 0)
        if (richer) {
          next[title.id] = { ...existing, ...title }
          changed = true
        }
      }
      return changed ? next : previous
    })
  }, [])

  const resolveTitle = useCallback((id: string): Title | undefined => registry[id], [registry])

  const notify = useCallback((message: string) => {
    setToast({ id: Date.now(), message })
  }, [])

  const loadFeed = useCallback(
    async (feedKey: string, force = false) => {
      const parts = DOUBAN_FEEDS[feedKey]
      if (!parts) return
      if (inflightRef.current.has(feedKey)) return
      const current = feedsRef.current[feedKey]
      const fresh =
        Boolean(current?.ids.length) &&
        Date.now() - (feedUpdatedRef.current[feedKey] ?? 0) < FEED_TTL
      if (!force && fresh) return
      inflightRef.current.add(feedKey)
      try {
      setFeeds((previous) => ({
        ...previous,
        [feedKey]: { ids: previous[feedKey]?.ids ?? [], loading: true, error: false },
      }))
      const results = await Promise.all(
        parts.map((part) => fetchDoubanList(part.kind, part.tag, part.limit, 0, part.sort)),
      )
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
        setFeeds((previous) => ({
          ...previous,
          [feedKey]: {
            ids: previous[feedKey]?.ids ?? [],
            loading: false,
            error: previous[feedKey]?.ids.length ? false : true,
          },
        }))
        notify(t('common.loadFailed'))
        return
      }
      register(merged)
      const ids = merged.map((title) => title.id)
      const updatedAt = Date.now()
      feedOffsetsRef.current[feedKey] = parts.map((part) => part.limit)
      setFeedExhaustedMap((previous) => ({ ...previous, [feedKey]: false }))
      feedUpdatedRef.current[feedKey] = updatedAt
      try {
        const cache = readFeedCache()
        cache[feedKey] = { ids, updatedAt }
        localStorage.setItem(FEED_CACHE_KEY, JSON.stringify(cache))
      } catch {
        // feed cache is an optimization only
      }
      setFeeds((previous) => ({
        ...previous,
        [feedKey]: { ids, loading: false, error: false },
      }))
      } finally {
        inflightRef.current.delete(feedKey)
      }
    },
    [notify, register, t],
  )

  useEffect(() => {
    void loadFeed('home', true)
  }, [loadFeed])

  useEffect(() => {
    if (FEED_VIEWS.includes(view)) void loadFeed(view)
  }, [view, loadFeed])

  // 无限瀑布流:追加下一页(各 part 独立游标,合并去重;无新增即判定到底)
  const loadFeedNext = useCallback(
    async (feedKey: string) => {
      const parts = DOUBAN_FEEDS[feedKey]
      if (!parts || inflightRef.current.has(feedKey)) return
      const offsets = feedOffsetsRef.current[feedKey]
      if (!offsets) return // 首屏尚未完成,无从追加
      inflightRef.current.add(feedKey)
      try {
        const results = await Promise.all(
          parts.map((part, index) =>
            fetchDoubanList(part.kind, part.tag, part.limit, offsets[index], part.sort),
          ),
        )
        const existing = new Set(feedsRef.current[feedKey]?.ids ?? [])
        const buckets = results.map((subjects, index) => {
          const kind = parts[index].kind
          feedOffsetsRef.current[feedKey][index] += (subjects ?? []).length
          return (subjects ?? [])
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
          setFeedExhaustedMap((previous) => ({ ...previous, [feedKey]: true }))
          return
        }
        register(merged)
        setFeeds((previous) => ({
          ...previous,
          [feedKey]: {
            ...previous[feedKey],
            ids: [...(previous[feedKey]?.ids ?? []), ...merged.map((title) => title.id)],
            loading: false,
            error: false,
          },
        }))
      } catch {
        // 追加失败静默,哨兵会再次触发
      } finally {
        inflightRef.current.delete(feedKey)
      }
    },
    [register],
  )

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
      setSearchBusy(false)
      return
    }
    setSearchBusy(true)
    const timer = window.setTimeout(async () => {
      const suggestions = await fetchDoubanSuggest(needle).catch(() => [])
      const doubanTitles = (suggestions ?? []).map(suggestToTitle)
      register(doubanTitles)
      // 播放源聚合搜索:各源并发,结果注册进片库并写入匹配缓存,点开即播
      let sourceTitles: Title[] = []
      try {
        const response = await playSearch(needle)
        sourceTitles = (response.items ?? []).slice(0, 40).map((item: PlaySearchItem) => {
          const id = `ps-${item.sourceKey}-${item.vodId}`
          writeMatch(id, {
            sourceKey: item.sourceKey,
            vodId: item.vodId,
            lineIndex: 0,
            matchedName: item.name,
          })
          const typeName = item.typeName || ''
          return {
            id,
            name: item.name,
            mediaType: /动漫|动画|番剧|综艺|纪录|剧/.test(typeName) ? 'series' : 'film',
            year: Number.parseInt(item.year, 10) || 0,
            ageRating: '',
            match: 0,
            genres: typeName ? [typeName] : [],
            synopsis: item.actor ? `主演：${stripHtml(item.actor)}` : '',
            poster: item.pic,
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
        register(sourceTitles)
      } catch {
        // 桌面端不可用或全部源失败时,仅展示豆瓣结果
      }
      // 去重合并;同名条目 AniCh 聚合源优先(多线路测速选优 + 弹幕)
      const byKey = new Map<string, Title>()
      const keyOf = (title: Title) => title.originalName || title.name
      for (const title of doubanTitles) {
        const key = keyOf(title)
        if (!byKey.has(key)) byKey.set(key, title)
      }
      for (const title of sourceTitles) {
        const key = keyOf(title)
        const existing = byKey.get(key)
        if (!existing) {
          byKey.set(key, title)
        } else if (title.id.startsWith('ps-anich-') && !existing.id.startsWith('ps-anich-')) {
          byKey.set(key, title)
        }
      }
      setSearchResults([...byKey.values()])
      setSearchBusy(false)
    }, 350)
    return () => window.clearTimeout(timer)
  }, [query, register])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 2800)
    return () => window.clearTimeout(timer)
  }, [toast])

  const progressFor = useCallback(
    (id: string): PlaybackProgress | undefined => {
      if (playback?.titleId === id) {
        return {
          current: playback.current,
          duration: playback.duration,
          episodeId: playback.episodeId,
        }
      }
      return progressMap[id]
    },
    [playback, progressMap],
  )

  const prefetchRef = useRef<{ key: string; target: PlayTarget; at: number } | null>(null)

  const closePlayback = useCallback(() => {
    prefetchRef.current = null
    setPlayback(null)
  }, [])

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
  const playbackRef = useRef<PlaybackState | null>(null)
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
            state.resumePosition = current.current
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

  const saveProgress = useCallback(
    (
      titleId: string,
      episodeId: string | undefined,
      episodeIndex: number | undefined,
      current: number,
      duration: number,
    ) => {
      if (!(duration > 0) || !Number.isFinite(duration)) return
      setProgressMap((previous) => {
        const saved = previous[titleId]
        if (
          saved &&
          saved.episodeId === episodeId &&
          saved.episodeIndex === episodeIndex &&
          saved.duration === duration &&
          Math.abs(saved.current - current) < 1
        ) {
          return previous
        }
        return {
          ...previous,
          [titleId]: { current, duration, episodeId, episodeIndex, updatedAt: Date.now() },
        }
      })
    },
    [setProgressMap],
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
      },
    ) => {
      const requestId = playReqRef.current + 1
      playReqRef.current = requestId
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
                episodeId: episodeIdForIndex(title, target.episodeIndex) ?? request.episodeId,
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
        return
      }

      void (async () => {
        try {
          const match = readMatch(title.id)
          const validMatch =
            match &&
            matchTitleName(title, match.matchedName) &&
            (!isAnimeTitle(title) || match.sourceKey === 'anich')
              ? match
              : null
          const probe =
            request.lineIndex === undefined && request.excludeSourceKey === undefined && validMatch
              ? probesRef.current[probeKeyFor(validMatch.sourceKey, validMatch.vodId)]
              : undefined
          const preferredLine = request.lineIndex ?? probe?.recommendedLineIndex ?? undefined
          let resolved: ResolvedSession
          try {
            resolved = await resolveSession(title, {
              episodeIndex,
              preferredLine,
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
          } catch (error) {
            // A stale probe recommendation must never block auto playback.
            if (preferredLine !== undefined && request.lineIndex === undefined) {
              resolved = await resolveSession(title, {
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
          const mappedEpisodeId =
            title.mediaType === 'series' ? episodeIdForIndex(title, resolved.episodeIndex) : undefined
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
                    title.mediaType === 'series' ? resolved.episodeIndex + 1 : undefined,
                  episodeId: mappedEpisodeId ?? request.episodeId,
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
            notify(t('toast.episodeClamped'))
          }
          if (resolved.sourceErrors.length > 0) {
            notify(t('toast.sourcePartial', { count: resolved.sourceErrors.length }))
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
              )
            } else if (reason === 'stall') {
              notify(t('toast.stallLineSwitched'))
            } else if (reason === 'startup') {
              notify(t('toast.startupLineSwitched'))
            }
          }
          prefetchNextEpisode(
            title,
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
      markSourceCooldown,
      notify,
      prefetchNextEpisode,
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

      const saved = progressMap[id]
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
      const startAt = episode ? 0 : (saved?.current ?? 0)

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
    },
    [beginPlayback, progressMap, resetAutoRecover, resolveTitle],
  )

  const handlePlaybackLiveTime = useCallback(
    (current: number, duration: number) => {
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
      setPlayback((value) =>
        value && (value.current !== current || value.duration !== duration)
          ? { ...value, current, duration }
          : value,
      )
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
  }, [clearStartupTimers])

  const handlePlaybackProgress = useCallback(
    (current: number, duration: number) => {
      const session = playbackRef.current
      if (!session) return
      saveProgress(session.titleId, session.episodeId, session.episodeIndex, current, duration)
      setPlayback((state) =>
        state && state.titleId === session.titleId && state.current !== current
          ? { ...state, current, duration }
          : state,
      )
    },
    [saveProgress],
  )

  const handlePlaybackStatus = useCallback((status: PlaybackStatus) => {
    setPlayback((current) => {
      if (!current || current.status === status) return current
      return {
        ...current,
        status,
        playing: status === 'playing' || status === 'buffering',
      }
    })
  }, [])

  const handleMediaError = useCallback(
    (error: PlayErrorInfo) => {
      const session = playbackRef.current
      clearStartupTimers()
      startupRef.current.done = true
      if (!session) return
      if (error.code === 'unsupported') {
        setPlayback((current) =>
          current
            ? {
                ...current,
                status: 'error',
                error,
                playing: false,
                slowStartup: false,
                autoRecovering: false,
              }
            : current,
        )
        return
      }
      if (autoRecoverRef.current.titleId !== session.titleId) {
        resetAutoRecover(session.titleId)
      }
      const state = autoRecoverRef.current
      state.reason = error.detail?.includes('stalled') ? 'stall' : 'failure'
      if (state.resumePosition === undefined) state.resumePosition = session.current
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
    resetAutoRecover(current.titleId)
    if (current.target) {
      const requestId = playReqRef.current + 1
      playReqRef.current = requestId
      startStartupTimers(requestId)
      setPlayback((state) =>
        state
          ? {
              ...state,
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
      startAt: current.current,
      detail: current.detail,
    })
  }, [beginPlayback, resetAutoRecover, resolveTitle])

  const switchLine = useCallback(
    (lineIndex: number) => {
      const current = playbackRef.current
      if (!current?.detail) return
      const title = resolveTitle(current.titleId)
      if (!title) return
      const line = current.detail.lines[lineIndex]
      if (!line) return
      if (!isPlayableLine(line)) {
        notify(t('toast.linePageOnly'))
        return
      }
      const target = Math.min(current.episodeIndex ?? 0, line.episodes.length - 1)
      const episodeIndex = playableEpisodeIndex(line, target)
      if (episodeIndex === null) {
        notify(t('toast.linePageOnly'))
        return
      }
      resetAutoRecover(current.titleId)
      beginPlayback(title, {
        episodeId: current.episodeId,
        episodeNumber: title.mediaType === 'series' ? episodeIndex + 1 : undefined,
        episodeIndex,
        lineIndex,
        startAt: current.current,
        detail: current.detail,
        stayOnSource: true,
      })
    },
    [beginPlayback, notify, resetAutoRecover, resolveTitle, t],
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
      startAt: current.current,
    })
  }, [beginPlayback, resetAutoRecover, resolveTitle])

  const selectSourceEpisode = useCallback(
    (index: number) => {
      const current = playbackRef.current
      if (!current?.detail) return
      const title = resolveTitle(current.titleId)
      if (!title) return
      const line = current.detail.lines[current.lineIndex ?? 0]
      if (!line || !isPlayableEpisode(line.episodes[index])) return
      resetAutoRecover(current.titleId)
      beginPlayback(title, {
        episodeId:
          title.mediaType === 'series'
            ? (episodeIdForIndex(title, index) ?? current.episodeId)
            : undefined,
        episodeNumber: title.mediaType === 'series' ? index + 1 : undefined,
        episodeIndex: index,
        lineIndex: current.lineIndex,
        startAt: 0,
        detail: current.detail,
        stayOnSource: true,
      })
    },
    [beginPlayback, resetAutoRecover, resolveTitle, startStartupTimers],
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
        episodeId: episodeIdForIndex(title, nextIndex) ?? current.episodeId,
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
              error: { code: 'no-source', detail: '自动换源已尝试 3 个源' },
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
    if (state.resumePosition === undefined) state.resumePosition = current.current
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
  }, [beginPlayback, clearStartupTimers, markSourceCooldown, resetAutoRecover, resolveTitle])
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
      if (state.resumePosition === undefined) state.resumePosition = current.current
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
    [handleAutoRecover, resetAutoRecover],
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
    setQuery('')
    setDrawerOpen(false)
    if (FEED_VIEWS.includes(next)) {
      setFeeds((previous) =>
        previous[next]
          ? previous
          : { ...previous, [next]: { ids: [], loading: true, error: false } },
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

  const toggleList = (id: string) => {
    const added = !myList.includes(id)
    const name = nameOf(id)
    setMyList(added ? [id, ...myList] : myList.filter((item) => item !== id))
    notify(
      added
        ? t('toast.addedToList', { name })
        : t('toast.removedFromList', { name }),
    )
  }

  const toggleLater = (id: string) => {
    const added = !later.includes(id)
    const name = nameOf(id)
    setLater(added ? [id, ...later] : later.filter((item) => item !== id))
    notify(
      added
        ? t('toast.addedToLater', { name })
        : t('toast.removedFromLater', { name }),
    )
  }

  const toggleDownload = (id: string) => {
    const added = !downloads.includes(id)
    const name = nameOf(id)
    setDownloads(added ? [id, ...downloads] : downloads.filter((item) => item !== id))
    notify(
      added
        ? t('toast.downloaded', { name })
        : t('toast.removedDownload', { name }),
    )
  }

  const toggleLike = (id: string) => {
    const added = !liked.includes(id)
    const name = nameOf(id)
    setLiked(added ? [id, ...liked] : liked.filter((item) => item !== id))
    notify(added ? t('toast.liked', { name }) : t('toast.ratingRemoved'))
  }

  const openDetail = (id: string) => {
    setDetailId(id)
  }

  const detailTitle = detailId ? resolveTitle(detailId) : null
  const playingTitle = playback ? resolveTitle(playback.titleId) : null
  const playbackProbe = playback?.target
    ? probes[probeKeyFor(playback.target.sourceKey, playback.target.vodId)]
    : undefined
  const playbackProbeLine =
    playbackProbe && playback?.lineIndex !== undefined
      ? playbackProbe.lines.find((line) => line.lineIndex === playback.lineIndex)
      : undefined

  const detailRequestsRef = useRef<Set<string>>(new Set())
  const detailDoneRef = useRef<Set<string>>(new Set())
  const ensureDetail = useCallback(
    (title: Title) => {
      if (!title.id.startsWith('db-')) return
      if (detailDoneRef.current.has(title.id) || detailRequestsRef.current.has(title.id)) return
      if (title.synopsis && title.cast.length > 0) {
        detailDoneRef.current.add(title.id)
        return
      }
      detailRequestsRef.current.add(title.id)
      const kind = title.mediaType === 'series' ? 'tv' : 'movie'
      void fetchDoubanDetail(title.id.slice(3), kind)
        .then((detail) => {
          if (!detail) return
          detailDoneRef.current.add(title.id)
          register([applyDetail(title, detail)])
        })
        .finally(() => detailRequestsRef.current.delete(title.id))
    },
    [register],
  )

  useEffect(() => {
    if (detailTitle) ensureDetail(detailTitle)
  }, [detailTitle, ensureDetail])

  const ensureProbe = useCallback(async (title: Title) => {
    if (probeTriedRef.current.has(title.id)) return
    probeTriedRef.current.add(title.id)
    try {
      let sourceKey = ''
      let vodId = ''
      const match = readMatch(title.id)
      const validMatch =
        match &&
        matchTitleName(title, match.matchedName) &&
        (!isAnimeTitle(title) || match.sourceKey === 'anich')
          ? match
          : null
      if (validMatch) {
        sourceKey = validMatch.sourceKey
        vodId = validMatch.vodId
      } else {
        const resolved = await resolveSession(title, { episodeIndex: 0 })
        sourceKey = resolved.target.sourceKey
        vodId = resolved.target.vodId
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
      console.info('[jj] play probe skipped', error)
    }
  }, [])

  useEffect(() => {
    if (!detailTitle) return
    // Debounced background prefetch: search/detail/target + probe, never blocking the modal.
    const title = detailTitle
    const timer = window.setTimeout(() => {
      void ensureProbe(title)
    }, 300)
    return () => window.clearTimeout(timer)
  }, [detailTitle, ensureProbe])

  const recentItems = useMemo(() => {
    return Object.entries(progressMap)
      .filter(([, value]) => (value?.current ?? 0) > 30)
      .sort((left, right) => (right[1].updatedAt ?? 0) - (left[1].updatedAt ?? 0))
      .map(([id]) => registry[id])
      .filter((title): title is Title => Boolean(title))
  }, [progressMap, registry])

  const homeItems = feedItems('home')

  const heroSlides = useMemo(() => {
    const films = homeItems.filter((title) => title.mediaType === 'film')
    const featured = (films.length > 0 ? films : homeItems).slice(0, 3)
    if (featured.length === 0) {
      return []
    }
    return featured.map((item, index) => ({
      featuredId: item.id,
      sideIds: [
        homeItems[(index * 2 + 3) % homeItems.length]?.id ?? '',
        homeItems[(index * 2 + 4) % homeItems.length]?.id ?? '',
      ] as [string, string],
    }))
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
          onNavigate={handleNavigate}
          onQuery={setQuery}
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
                  myList={myList}
                  progressFor={progressFor}
                  onOpen={openDetail}
                  onPlay={startWatch}
                  onToggleList={toggleList}
                  onClear={() => setQuery('')}
                />
              ) : view === 'home' ? (
                <HomeView
                  slideIndex={slideIndex}
                  slides={heroSlides}
                  items={homeItems}
                  feed={feeds.home ?? emptyFeed}
                  myList={myList}
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
                  feedItems={feedItems(view)}
                  resolveTitle={resolveTitle}
                  recentItems={recentItems}
                  sourceNames={sourceNames}
                  feedExhausted={Boolean(feedExhaustedMap[view])}
                  autoplayNext={autoplayNext}
                  onToggleAutoplay={() => setAutoplayNext((value) => !value)}
                  danmakuOn={danmakuOn}
                  onToggleDanmaku={() => setDanmakuOn((value) => !value)}
                  networkProxy={networkProxy}
                  onSaveProxy={(value) => setNetworkProxy(value)}
                  myList={myList}
                  later={later}
                  downloads={downloads}
                  progressFor={progressFor}
                  onLoadMore={() => void loadFeedNext(view)}
                  onNavigate={handleNavigate}
                  onOpen={openDetail}
                  onPlay={startWatch}
                  onToggleList={toggleList}
                  onToggleDownload={toggleDownload}
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
          inDownloads={downloads.includes(detailTitle.id)}
          liked={liked.includes(detailTitle.id)}
          progress={progressFor(detailTitle.id)}
          onClose={() => setDetailId(null)}
          onPlay={startWatch}
          onToggleList={toggleList}
          onToggleLater={toggleLater}
          onToggleDownload={toggleDownload}
          onToggleLike={toggleLike}
          onOpenRelated={setDetailId}
        />
      )}

      {playback && playingTitle && (
        <Theater
          title={playingTitle}
          playback={playback}
          probe={playbackProbe}
          sourceName={playback.sourceKey ? sourceNames[playback.sourceKey] : undefined}
          expectedDuration={playbackProbeLine?.durationSec}
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
          onSwitchSource={switchSource}
          onPlayEpisode={(episode) => startWatch(playingTitle.id, episode)}
          onSelectSourceEpisode={selectSourceEpisode}
          danmakuOn={danmakuOn}
          onToggleDanmaku={() => setDanmakuOn((value) => !value)}
          onEnded={handlePlaybackEnded}
        />
      )}

      {toast && (
        <div className="toast" role="status" key={toast.id}>
          <span className="toast-icon">
            <Check size={13} strokeWidth={3} aria-hidden />
          </span>
          {toast.message}
        </div>
      )}
    </div>
  )
}
