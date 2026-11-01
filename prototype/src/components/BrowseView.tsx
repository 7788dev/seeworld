import {
  Bookmark,
  Check,
  Clock3,
  Download,
  Globe2,
  Info,
  ListPlus,
  Loader2,
  RefreshCw,
  SearchX,
  Settings,
  Trash2,
  Upload,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, ReactNode } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { Title, ViewKey } from '../data'
import { fetchExploreTitles } from '../douban'
import type { ExploreValues, FeedState } from '../douban'
import { filterConfigFor, isFilterActive, sanitizeFilters } from '../filters'
import { useI18n } from '../i18n'
import { cx, isDesktopApp, usePersistentState } from '../lib'
import type { PlaySourceInfo } from '../play'
import type { PlaybackProgress } from '../types'
import FilterBar from './FilterBar'
import PosterSkeleton from './PosterSkeleton'
import TitleCard from './TitleCard'

interface BrowseViewProps {
  view: Exclude<ViewKey, 'home'>
  feed: FeedState
  feedItems: Title[]
  resolveTitle: (id: string) => Title | undefined
  recentItems: Title[]
  sources: PlaySourceInfo[]
  sourcesLoaded: boolean
  sourcesFailed: boolean
  onReloadSources: () => void
  onToggleSource: (key: string) => Promise<void>
  feedExhausted: boolean
  myList: string[]
  later: string[]
  progressFor: (id: string) => PlaybackProgress | undefined
  onLoadMore: () => Promise<boolean>
  autoplayNext: boolean
  onToggleAutoplay: () => void
  onNavigate: (view: ViewKey) => void
  onOpen: (id: string) => void
  onPlay: (id: string) => void
  onToggleList: (id: string) => void
  onRetry: () => void
  onRegister: (titles: Title[]) => void
}

const byIds = (ids: string[], resolveTitle: (id: string) => Title | undefined) =>
  ids.map((id) => resolveTitle(id)).filter((title): title is Title => Boolean(title))

const viewMetaKeys = {
  new: {
    eyebrow: 'view.new.eyebrow',
    title: 'view.new.title',
    subtitle: 'view.new.subtitle',
  },
  tv: {
    eyebrow: 'view.tv.eyebrow',
    title: 'view.tv.title',
    subtitle: 'view.tv.subtitle',
  },
  movies: {
    eyebrow: 'view.movies.eyebrow',
    title: 'view.movies.title',
    subtitle: 'view.movies.subtitle',
  },
  anime: {
    eyebrow: 'view.anime.eyebrow',
    title: 'view.anime.title',
    subtitle: 'view.anime.subtitle',
  },
  'my-list': {
    eyebrow: 'view.myList.eyebrow',
    title: 'view.myList.title',
    subtitle: 'view.myList.subtitle',
  },
  settings: {
    eyebrow: 'view.settings.eyebrow',
    title: 'view.settings.title',
    subtitle: 'view.settings.subtitle',
  },
  recent: {
    eyebrow: 'view.recent.eyebrow',
    title: 'view.recent.title',
    subtitle: 'view.recent.subtitle',
  },
  later: {
    eyebrow: 'view.later.eyebrow',
    title: 'view.later.title',
    subtitle: 'view.later.subtitle',
  },
} as const

function PageHeader({
  eyebrow,
  title,
  subtitle,
  aside,
}: {
  eyebrow: string
  title: string
  subtitle: string
  aside?: ReactNode
}) {
  return (
    <header className="page-head">
      <div className="page-head-copy">
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="page-subtitle">{subtitle}</p>
      </div>
      {aside && <div className="page-head-aside">{aside}</div>}
    </header>
  )
}

function EmptyState({
  icon,
  title,
  copy,
  actionLabel,
  onAction,
}: {
  icon: ReactNode
  title: string
  copy: string
  actionLabel?: string
  onAction?: () => void
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">{icon}</span>
      <h2>{title}</h2>
      <p>{copy}</p>
      {actionLabel && onAction && (
        <button type="button" className="btn btn--glass" onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </div>
  )
}

const DATA_ACTIONS = [
  {
    key: 'progress',
    labelKey: 'settings.clearProgress',
    descKey: 'settings.clearProgressDesc',
    storageKeys: ['jj-progress', 'jj-episode-progress'],
  },
  {
    key: 'lists',
    labelKey: 'settings.clearLists',
    descKey: 'settings.clearListsDesc',
    storageKeys: ['jj-my-list', 'jj-watch-later', 'jj-liked'],
  },
  {
    key: 'cache',
    labelKey: 'settings.clearCache',
    descKey: 'settings.clearCacheDesc',
    // title-cache 不直接删除：先只保留片单/稍后看/进度需要的条目，
    // 否则清完缓存后“我的片单/最近观看”会全部变成空列表。
    storageKeys: ['jj-feed-cache', 'jj-play-match', 'jj-explore-filters'],
  },
] as const

const readStringIds = (key: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '[]')
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : []
  } catch {
    return []
  }
}

const clearFeedCaches = () => {
  try {
    const keys: string[] = []
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (key === 'jj-feed-cache' || key?.startsWith('jj-feed-cache:')) keys.push(key)
    }
    for (const key of keys) localStorage.removeItem(key)
  } catch {
    // storage may be unavailable
  }
}

/** 清缓存时保留 pinned 标题的元数据，避免片单/进度出现“有 id 没卡片”。 */
const preservePinnedTitleCache = () => {
  try {
    const pinned = new Set<string>([
      ...readStringIds('jj-my-list'),
      ...readStringIds('jj-watch-later'),
      ...readStringIds('jj-liked'),
    ])
    const rawProgress: unknown = JSON.parse(localStorage.getItem('jj-progress') ?? '{}')
    if (rawProgress && typeof rawProgress === 'object' && !Array.isArray(rawProgress)) {
      for (const id of Object.keys(rawProgress)) pinned.add(id)
    }
    const rawCache = localStorage.getItem('jj-title-cache')
    if (!rawCache) return
    const parsed: unknown = JSON.parse(rawCache)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
    const kept = Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(([id]) => pinned.has(id)),
    )
    localStorage.setItem('jj-title-cache', JSON.stringify(kept))
  } catch {
    // 缓存损坏时宁可让后续重新拉取，也不要阻止清理动作
  }
}

const BACKUP_KEYS = [
  'jj-my-list',
  'jj-watch-later',
  'jj-liked',
  'jj-title-cache',
  'jj-progress',
  'jj-episode-progress',
  'jj-language',
  'jj-autoplay-next',
  'jj-lights',
  'jj-player-volume',
  'jj-player-muted',
  'jj-player-rate',
  'jj-explore-filters',
] as const

const localStorageBytes = () => {
  let bytes = 0
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (!key || !key.startsWith('jj-')) continue
      bytes += (key.length + (localStorage.getItem(key)?.length ?? 0)) * 2
    }
  } catch {
    // storage may be unavailable
  }
  return bytes
}

const formatBytes = (bytes: number) =>
  bytes <= 0
    ? '0 KB'
    : bytes >= 1024 * 1024
      ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
      : `${Math.max(1, Math.round(bytes / 1024))} KB`

function SettingsPanel({
  sources,
  sourcesLoaded,
  sourcesFailed,
  onReloadSources,
  onToggleSource,
  autoplayNext,
  onToggleAutoplay,
}: {
  sources: PlaySourceInfo[]
  sourcesLoaded: boolean
  sourcesFailed: boolean
  onReloadSources: () => void
  onToggleSource: (key: string) => Promise<void>
  autoplayNext: boolean
  onToggleAutoplay: () => void
}) {
  const { language, setLanguage, t } = useI18n()
  const [version, setVersion] = useState('')
  // 破坏性操作一律二次确认：第一次点击只进入 armed 状态，4 秒后自动撤销。
  const [pending, setPending] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const importRef = useRef<HTMLInputElement>(null)
  const [storageBytes, setStorageBytes] = useState(0)
  const [importStatus, setImportStatus] = useState<'idle' | 'failed' | 'done'>('idle')
  const [exportResult, setExportResult] = useState<{ path?: string; error?: boolean }>({})
  const [sourceBusy, setSourceBusy] = useState<string | null>(null)

  const toggleSource = async (key: string) => {
    if (sourceBusy) return
    setSourceBusy(key)
    try {
      await onToggleSource(key)
    } finally {
      setSourceBusy(null)
    }
  }

  useEffect(() => {
    setStorageBytes(localStorageBytes())
  }, [])

  const exportBackup = async () => {
    const data: Record<string, string> = {}
    for (const key of BACKUP_KEYS) {
      const value = localStorage.getItem(key)
      if (value !== null) data[key] = value
    }
    const payload = JSON.stringify(
      {
        app: 'seeworld',
        version: 1,
        exportedAt: new Date().toISOString(),
        data,
      },
      null,
      2,
    )
    try {
      if (isDesktopApp) {
        // 原生命令直接写下载目录，避免 WebView2 弹出“下载文件”提示。
        const fileName = `seeworld-backup-${new Date()
          .toISOString()
          .replace(/[:.]/g, '-')}.json`
        const path = await invoke<string>('export_backup', { data: payload, fileName })
        setExportResult({ path })
        return
      }
      // 浏览器开发预览的兜底；桌面应用不会走这里。
      const blob = new Blob([payload], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `seeworld-backup-${new Date().toISOString().slice(0, 10)}.json`
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      setExportResult({ path: link.download })
    } catch {
      setExportResult({ error: true })
    }
  }

  const importBackup = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      const text = await file.text()
      if (text.length > 5_000_000) throw new Error('backup too large')
      const parsed: unknown = JSON.parse(text)
      const root =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null
      const data =
        root && root.data && typeof root.data === 'object' && !Array.isArray(root.data)
          ? (root.data as Record<string, unknown>)
          : root
      if (!data) throw new Error('invalid backup')
      let written = 0
      for (const key of BACKUP_KEYS) {
        const value = data[key]
        if (typeof value === 'string') {
          localStorage.setItem(key, value)
          written += 1
        } else if (value !== undefined) {
          localStorage.setItem(key, JSON.stringify(value))
          written += 1
        }
      }
      if (written === 0) throw new Error('empty backup')
      setImportStatus('done')
      window.setTimeout(() => window.location.reload(), 450)
    } catch {
      setImportStatus('failed')
    }
  }

  useEffect(() => {
    if (!pending) return
    const timer = window.setTimeout(() => setPending(null), 4000)
    return () => window.clearTimeout(timer)
  }, [pending])

  useEffect(() => {
    if (!isDesktopApp) return
    void import('@tauri-apps/api/app')
      .then((mod) => mod.getVersion().then(setVersion))
      .catch(() => undefined)
  }, [])

  return (
    <>
      <PageHeader
        eyebrow={t('view.settings.eyebrow')}
        title={t('view.settings.title')}
        subtitle={t('view.settings.subtitle')}
      />
      <div className="account-grid">
        <section className="account-card account-language">
          <div className="account-language-intro">
            <span className="account-language-icon">
              <Globe2 size={18} aria-hidden />
            </span>
            <div>
              <h2>{t('settings.language')}</h2>
              <p>{t('settings.languageDesc')}</p>
            </div>
          </div>
          <div className="language-options" role="group" aria-label={t('settings.language')}>
            <button
              type="button"
              className={cx('language-option', language === 'zh' && 'is-active')}
              aria-pressed={language === 'zh'}
              onClick={() => setLanguage('zh')}
            >
              <span className="language-option-copy">
                <strong>中文</strong>
                <em>简体中文</em>
              </span>
              <Check className="language-option-check" size={13} aria-hidden />
            </button>
            <button
              type="button"
              className={cx('language-option', language === 'en' && 'is-active')}
              aria-pressed={language === 'en'}
              onClick={() => setLanguage('en')}
            >
              <span className="language-option-copy">
                <strong>English</strong>
                <em>English (US)</em>
              </span>
              <Check className="language-option-check" size={13} aria-hidden />
            </button>
          </div>
        </section>

        <section className="account-card account-playback">
          <div className="account-language-intro">
            <span className="account-language-icon">
              <Settings size={18} aria-hidden />
            </span>
            <div>
              <h2>{t('settings.playback')}</h2>
              <p>{t('settings.playbackDesc')}</p>
            </div>
          </div>
          <div className="settings-toggles">
            <button
              type="button"
              className={cx('settings-toggle', autoplayNext && 'is-active')}
              aria-pressed={autoplayNext}
              onClick={onToggleAutoplay}
            >
              <span className="settings-toggle-copy">
                <strong>{t('settings.autoplay')}</strong>
                <em>{t('settings.autoplayDesc')}</em>
              </span>
              <span className="settings-toggle-state">
                {autoplayNext ? t('settings.on') : t('settings.off')}
              </span>
            </button>
          </div>
        </section>

        <section className="account-card account-sources">
          <div className="account-language-intro">
            <span className="account-language-icon">
              <Info size={18} aria-hidden />
            </span>
            <div>
              <h2>{t('settings.sources')}</h2>
              <p>{t('settings.sourcesDesc')}</p>
            </div>
          </div>
          {sources.length > 0 ? (
            <ul className="settings-sources">
              {sources.map((source) => (
                <li key={source.key}>
                  <span>{source.name}</span>
                  <span className="settings-source-meta">
                    <em>{source.key}</em>
                    <button
                      type="button"
                      className={cx('settings-source-toggle', source.enabled && 'is-on')}
                      aria-pressed={source.enabled}
                      aria-label={`${source.name} ${source.enabled ? t('settings.off') : t('settings.on')}`}
                      disabled={sourceBusy === source.key}
                      aria-busy={sourceBusy === source.key}
                      onClick={() => void toggleSource(source.key)}
                    >
                      {source.enabled ? t('settings.on') : t('settings.off')}
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          ) : !isDesktopApp ? (
            <p className="settings-empty">{t('settings.sourcesUnavailable')}</p>
          ) : !sourcesLoaded ? (
            <p className="settings-empty">{t('common.loading')}</p>
          ) : sourcesFailed ? (
            <div className="settings-empty">
              <p>{t('settings.sourcesFailed')}</p>
              <button type="button" className="btn btn--glass btn--small" onClick={onReloadSources}>
                <RefreshCw size={13} aria-hidden /> {t('common.retry')}
              </button>
            </div>
          ) : (
            <p className="settings-empty">{t('settings.sourcesUnavailable')}</p>
          )}
        </section>

        <section className="account-card account-data">
          <div className="account-language-intro">
            <span className="account-language-icon">
              <Trash2 size={18} aria-hidden />
            </span>
            <div>
              <h2>{t('settings.data')}</h2>
              <p>{t('settings.dataDesc')}</p>
            </div>
          </div>
          <div className="settings-toggles">
            {DATA_ACTIONS.map((action) => (
              <button
                key={action.key}
                type="button"
                className={cx('settings-toggle', 'settings-toggle--danger', pending === action.key && 'is-armed')}
                onClick={() => {
                  if (pending !== action.key) {
                    setPending(action.key)
                    return
                  }
                  if (action.key === 'cache') {
                    preservePinnedTitleCache()
                    clearFeedCaches()
                  }
                  for (const storageKey of action.storageKeys) {
                    try {
                      localStorage.removeItem(storageKey)
                    } catch {
                      // storage may be unavailable
                    }
                  }
                  setDone(true)
                  setPending(null)
                  window.setTimeout(() => window.location.reload(), 350)
                }}
              >
                <span className="settings-toggle-copy">
                  <strong>{t(action.labelKey)}</strong>
                  <em>{pending === action.key ? t('settings.confirmAgain') : t(action.descKey)}</em>
                </span>
                <span className="settings-toggle-state">
                  {pending === action.key ? '!' : ''}
                </span>
              </button>
            ))}
          </div>
          {done && <p className="settings-empty">{t('settings.clearedReloading')}</p>}
        </section>

        <section className="account-card account-backup">
          <div className="account-language-intro">
            <span className="account-language-icon">
              <Download size={18} aria-hidden />
            </span>
            <div>
              <h2>{t('settings.dataTools')}</h2>
              <p>{t('settings.dataToolsDesc')}</p>
            </div>
          </div>
          <div className="settings-toggles">
            <button type="button" className="settings-toggle" onClick={() => void exportBackup()}>
              <span className="settings-toggle-copy">
                <strong>{t('settings.export')}</strong>
                <em>{t('settings.storageUsage', { size: formatBytes(storageBytes) })}</em>
              </span>
              <span className="settings-toggle-state">
                <Download size={14} aria-hidden />
              </span>
            </button>
            <button
              type="button"
              className="settings-toggle"
              onClick={() => importRef.current?.click()}
            >
              <span className="settings-toggle-copy">
                <strong>{t('settings.import')}</strong>
                <em>{t('settings.dataToolsDesc')}</em>
              </span>
              <span className="settings-toggle-state">
                <Upload size={14} aria-hidden />
              </span>
            </button>
            <input
              ref={importRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(event) => void importBackup(event)}
            />
          </div>
          {exportResult.path && (
            <p
              className="settings-empty settings-export-status"
              role="status"
              data-export-path={exportResult.path}
            >
              {t('settings.exportedTo', { path: exportResult.path })}
            </p>
          )}
          {exportResult.error && (
            <p className="settings-empty" role="alert">{t('settings.exportFailed')}</p>
          )}
          {importStatus === 'failed' && (
            <p className="settings-empty" role="alert">{t('settings.importFailed')}</p>
          )}
          {importStatus === 'done' && (
            <p className="settings-empty" role="status">{t('settings.importDone')}</p>
          )}
        </section>

        <section className="account-card account-about">
          <h2>{t('settings.about')}</h2>
          <p>{t('settings.aboutDesc')}</p>
          <span className="settings-version">
            SeeWorld Desktop{version ? ` · v${version}` : ''}
          </span>
        </section>
      </div>
    </>
  )
}

export default function BrowseView({
  view,
  feed,
  feedItems,
  resolveTitle,
  recentItems,
  sources,
  sourcesLoaded,
  sourcesFailed,
  onReloadSources,
  onToggleSource,
  feedExhausted,
  myList,
  later,
  progressFor,
  onLoadMore,
  autoplayNext,
  onToggleAutoplay,
  onNavigate,
  onOpen,
  onPlay,
  onToggleList,
  onRetry,
  onRegister,
}: BrowseViewProps) {
  const { t } = useI18n()
  const isDoubanView =
    view === 'new' || view === 'tv' || view === 'movies' || view === 'anime'
  const filterConfig = filterConfigFor(view)
  const [filterStore, setFilterStore] = usePersistentState<Record<string, ExploreValues>>(
    'jj-explore-filters',
    {},
    (value) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, ExploreValues>)
        : {},
  )
  const filterValues = useMemo(
    () => (filterConfig ? sanitizeFilters(filterConfig, filterStore[view]) : undefined),
    [filterConfig, filterStore, view],
  )
  const filtersActive = Boolean(filterConfig && isFilterActive(view, filterValues))
  const loadingMoreRef = useRef(false)
  const retryRef = useRef({ failures: 0, nextAt: 0 })
  const [explore, setExplore] = useState<{
    items: Title[]
    loading: boolean
    error: boolean
    exhausted: boolean
  }>({ items: [], loading: filtersActive, error: false, exhausted: false })
  const [exploreVersion, setExploreVersion] = useState(0)
  const exploreOffsetsRef = useRef<number[]>([])
  const exploreRequestRef = useRef(0)
  const exploreRef = useRef(explore)
  exploreRef.current = explore

  useEffect(() => {
    if (!filterValues || !filtersActive) {
      exploreRequestRef.current += 1
      exploreOffsetsRef.current = []
      loadingMoreRef.current = false
      setExplore((previous) =>
        previous.items.length === 0 && !previous.loading && !previous.error && !previous.exhausted
          ? previous
          : { items: [], loading: false, error: false, exhausted: false },
      )
      return
    }
    const requestId = exploreRequestRef.current + 1
    exploreRequestRef.current = requestId
    exploreOffsetsRef.current = []
    loadingMoreRef.current = false
    retryRef.current = { failures: 0, nextAt: 0 }
    let cancelled = false
    setExplore({ items: [], loading: true, error: false, exhausted: false })
    const timer = window.setTimeout(() => {
      void fetchExploreTitles(view, filterValues)
        .then((result) => {
          if (cancelled || exploreRequestRef.current !== requestId) return
          exploreOffsetsRef.current = result.offsets
          if (result.items.length > 0) onRegister(result.items)
          setExplore({
            items: result.items,
            loading: false,
            error: result.error,
            exhausted: result.exhausted,
          })
        })
        .catch(() => {
          if (cancelled || exploreRequestRef.current !== requestId) return
          setExplore({ items: [], loading: false, error: true, exhausted: false })
        })
    }, 220)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [exploreVersion, filterValues, filtersActive, onRegister, view])

  const updateFilters = (next: ExploreValues) => {
    exploreRequestRef.current += 1
    setExplore({ items: [], loading: true, error: false, exhausted: false })
    setFilterStore((previous) => ({ ...previous, [view]: next }))
  }

  const resetFilters = () => {
    exploreRequestRef.current += 1
    setFilterStore((previous) => {
      const next = { ...previous }
      delete next[view]
      return next
    })
  }

  const loadExploreMore = useCallback(async (): Promise<boolean> => {
    const current = exploreRef.current
    if (!filtersActive || !filterValues || current.loading || current.error || current.exhausted) {
      return false
    }
    const requestId = exploreRequestRef.current
    const result = await fetchExploreTitles(view, filterValues, exploreOffsetsRef.current)
    if (exploreRequestRef.current !== requestId) return false
    exploreOffsetsRef.current = result.offsets
    if (result.items.length > 0) onRegister(result.items)
    const known = new Set(current.items.map((title) => title.id))
    const appended = result.items.filter((title) => !known.has(title.id))
    setExplore((previous) => {
      const seen = new Set(previous.items.map((title) => title.id))
      const extra = result.items.filter((title) => {
        if (seen.has(title.id)) return false
        seen.add(title.id)
        return true
      })
      return {
        ...previous,
        items: extra.length > 0 ? [...previous.items, ...extra] : previous.items,
        loading: false,
        error: result.error,
        exhausted: result.exhausted,
      }
    })
    return appended.length > 0
  }, [filterValues, filtersActive, onRegister, view])

  // 无限瀑布流:哨兵进入视口(几何检查 + 滚动监听,不依赖 observer 触发时序)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  useEffect(() => {
    const node = sentinelRef.current
    if (!node) return
    let cancelled = false
    const tryLoad = () => {
      if (cancelled || loadingMoreRef.current) return
      if (Date.now() < retryRef.current.nextAt) return
      const canLoadExplore =
        isDoubanView &&
        filtersActive &&
        Boolean(filterValues) &&
        !explore.loading &&
        !explore.error &&
        !explore.exhausted &&
        explore.items.length > 0
      const canLoadFeed =
        isDoubanView &&
        !filtersActive &&
        !feed.loading &&
        !feed.error &&
        !feedExhausted &&
        feedItems.length > 0
      if (!canLoadExplore && !canLoadFeed) return
      const rect = node.getBoundingClientRect()
      if (rect.top > window.innerHeight + 1200 || rect.bottom < -1200) return
      loadingMoreRef.current = true
      setLoadingMore(true)
      const task = canLoadExplore ? loadExploreMore() : onLoadMore()
      task
        .then((appended) => {
          if (appended) {
            retryRef.current = { failures: 0, nextAt: 0 }
            return
          }
          const failures = retryRef.current.failures + 1
          retryRef.current = {
            failures,
            nextAt: Date.now() + Math.min(60_000, 2_000 * 2 ** Math.min(failures, 5)),
          }
        })
        .catch(() => {
          const failures = retryRef.current.failures + 1
          retryRef.current = {
            failures,
            nextAt: Date.now() + Math.min(60_000, 2_000 * 2 ** Math.min(failures, 5)),
          }
        })
        .finally(() => {
          loadingMoreRef.current = false
          setLoadingMore(false)
        })
    }
    tryLoad()
    const observer = new IntersectionObserver(() => tryLoad(), { rootMargin: '1200px 0px' })
    observer.observe(node)
    const scroller = node.closest('.main-scroll')
    const onScroll = () => tryLoad()
    scroller?.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('scroll', onScroll, { passive: true })
    // 兜底轮询只用于补 IntersectionObserver 的触发时序；2s 足够，且后台标签不空转。
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') tryLoad()
    }, 2000)
    return () => {
      cancelled = true
      observer.disconnect()
      scroller?.removeEventListener('scroll', onScroll)
      window.removeEventListener('scroll', onScroll)
      window.clearInterval(interval)
    }
  }, [
    feed.loading,
    feed.error,
    feedExhausted,
    filtersActive,
    filterValues,
    explore.loading,
    explore.error,
    explore.exhausted,
    explore.items.length,
    feedItems.length,
    isDoubanView,
    loadExploreMore,
    onLoadMore,
  ])

  if (view === 'settings') {
    return (
      <div className="page-view page-view--settings">
        <SettingsPanel
          sources={sources}
          sourcesLoaded={sourcesLoaded}
          sourcesFailed={sourcesFailed}
          onReloadSources={onReloadSources}
          onToggleSource={onToggleSource}
          autoplayNext={autoplayNext}
          onToggleAutoplay={onToggleAutoplay}
        />
      </div>
    )
  }

  const doubanEmpty = isDoubanView && feedItems.length === 0 && !feed.loading && !feed.error

  let items: Title[] = []
  if (isDoubanView) {
    items = feedItems
  }
  if (view === 'my-list') items = byIds(myList, resolveTitle)
  if (view === 'later') items = byIds(later, resolveTitle)
  if (view === 'recent') items = recentItems

  const displayItems = filtersActive ? explore.items : items
  const listLoading = filtersActive ? explore.loading : isDoubanView && feed.loading
  const listError = filtersActive ? explore.error : isDoubanView && feed.error
  const meta = viewMetaKeys[view]
  const resultLabel =
    displayItems.length === 1
      ? t('browse.countOne', { count: displayItems.length })
      : t('browse.countMany', { count: displayItems.length })

  return (
    <div className="page-view">
      <PageHeader
        eyebrow={t(meta.eyebrow)}
        title={t(meta.title)}
        subtitle={t(meta.subtitle)}
        aside={
          <span className="page-count">
            {isDoubanView && listLoading
              ? t('common.loading')
              : isDoubanView && listError
                ? t('common.loadFailed')
                : resultLabel}
          </span>
        }
      />

      {filterConfig && filterValues && (
        <FilterBar
          config={filterConfig}
          value={filterValues}
          active={filtersActive}
          onChange={updateFilters}
          onReset={resetFilters}
        />
      )}

      {!filtersActive && isDoubanView && feed.loading && feedItems.length === 0 && (
        <div role="status" aria-label={t('common.loading')}>
          <PosterSkeleton count={12} />
        </div>
      )}

      {!filtersActive && isDoubanView && feed.error && (
        <div className="feed-status feed-status--warn">
          <span>{t('common.loadFailed')}</span>
          <button type="button" className="btn btn--glass btn--small" onClick={onRetry}>
            <RefreshCw size={13} aria-hidden /> {t('common.retry')}
          </button>
        </div>
      )}

      {!filtersActive && isDoubanView && doubanEmpty && (
        <div className="feed-status" role="status">
          <span>{t('common.emptyNow')}</span>
          <button type="button" className="btn btn--glass btn--small" onClick={onRetry}>
            <RefreshCw size={13} aria-hidden /> {t('common.retry')}
          </button>
        </div>
      )}

      {filtersActive && explore.loading && (
        <div role="status" aria-label={t('common.loading')}>
          <PosterSkeleton count={12} />
        </div>
      )}

      {filtersActive && explore.error && (
        <div className="feed-status feed-status--warn">
          <span>{t('common.loadFailed')}</span>
          <button
            type="button"
            className="btn btn--glass btn--small"
            onClick={() => setExploreVersion((version) => version + 1)}
          >
            <RefreshCw size={13} aria-hidden /> {t('common.retry')}
          </button>
        </div>
      )}

      {displayItems.length === 0 ? (
        filtersActive ? (
          !explore.loading && !explore.error ? (
            <EmptyState
              icon={<SearchX size={26} />}
              title={t('filter.emptyTitle')}
              copy={t('filter.emptyCopy')}
              actionLabel={t('filter.reset')}
              onAction={resetFilters}
            />
          ) : null
        ) : isDoubanView ? null : view === 'recent' ? (
          <EmptyState
            icon={<Clock3 size={26} />}
            title={t('browse.emptyRecentTitle')}
            copy={t('browse.emptyRecentCopy')}
            actionLabel={t('nav.home')}
            onAction={() => onNavigate('home')}
          />
        ) : (
          <EmptyState
            icon={view === 'my-list' ? <ListPlus size={26} /> : <Bookmark size={26} />}
            title={
              view === 'my-list'
                ? t('browse.emptyListTitle')
                : t('browse.emptyLaterTitle')
            }
            copy={
              view === 'my-list'
                ? t('browse.emptyListCopy')
                : t('browse.emptyLaterCopy')
            }
            actionLabel={t('browse.browseNew')}
            onAction={() => onNavigate('new')}
          />
        )
      ) : (
        <div className="poster-grid poster-grid--page">
          {displayItems.map((title) => (
            <TitleCard
              key={title.id}
              title={title}
              inList={myList.includes(title.id)}
              progress={progressFor(title.id)}
              onOpen={onOpen}
              onPlay={onPlay}
              onToggleList={onToggleList}
            />
          ))}
        </div>
      )}

      {loadingMore && (
        <div className="feed-more-status" role="status">
          <Loader2 className="feed-spinner" size={14} aria-hidden />
          {t('common.loadingMore')}
        </div>
      )}

      {isDoubanView &&
        displayItems.length > 0 &&
        ((!filtersActive && !feed.loading && !feed.error && !feedExhausted) ||
          (filtersActive &&
            !explore.loading &&
            !explore.error &&
            !explore.exhausted)) && (
          <div className="feed-sentinel" ref={sentinelRef} aria-hidden>
            {loadingMore && <Loader2 className="feed-spinner" size={16} aria-hidden />}
          </div>
        )}
    </div>
  )
}
