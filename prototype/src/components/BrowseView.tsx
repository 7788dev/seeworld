import {
  Bookmark,
  Check,
  Clock3,
  Globe2,
  Info,
  ListPlus,
  Loader2,
  RefreshCw,
  SearchX,
  Settings,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Title, ViewKey } from '../data'
import { fetchExploreTitles } from '../douban'
import type { ExploreValues, FeedState } from '../douban'
import { filterConfigFor, isFilterActive, sanitizeFilters } from '../filters'
import { useI18n } from '../i18n'
import { cx, isDesktopApp, usePersistentState } from '../lib'
import type { PlaySourceInfo } from '../play'
import type { PlaybackProgress } from '../types'
import FilterBar from './FilterBar'
import TitleCard from './TitleCard'

interface BrowseViewProps {
  view: Exclude<ViewKey, 'home'>
  feed: FeedState
  feedItems: Title[]
  resolveTitle: (id: string) => Title | undefined
  recentItems: Title[]
  sources: PlaySourceInfo[]
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

function SettingsPanel({
  sources,
  autoplayNext,
  onToggleAutoplay,
}: {
  sources: PlaySourceInfo[]
  autoplayNext: boolean
  onToggleAutoplay: () => void
}) {
  const { language, setLanguage, t } = useI18n()
  const [version, setVersion] = useState('')

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
                  <em>
                    {source.key} · {source.enabled ? t('settings.on') : t('settings.off')}
                  </em>
                </li>
              ))}
            </ul>
          ) : (
            <p className="settings-empty">{t('settings.sourcesUnavailable')}</p>
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
  const [explore, setExplore] = useState<{
    items: Title[]
    loading: boolean
    error: boolean
  }>({ items: [], loading: filtersActive, error: false })
  const [exploreVersion, setExploreVersion] = useState(0)

  useEffect(() => {
    if (!filterValues || !filtersActive) {
      setExplore((previous) =>
        previous.items.length === 0 && !previous.loading && !previous.error
          ? previous
          : { items: [], loading: false, error: false },
      )
      return
    }
    let cancelled = false
    setExplore({ items: [], loading: true, error: false })
    const timer = window.setTimeout(() => {
      void fetchExploreTitles(view, filterValues).then((result) => {
        if (cancelled) return
        if (result.items.length > 0) onRegister(result.items)
        setExplore({ items: result.items, loading: false, error: result.error })
      })
    }, 220)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [exploreVersion, filterValues, filtersActive, onRegister, view])

  const updateFilters = (next: ExploreValues) => {
    setExplore({ items: [], loading: true, error: false })
    setFilterStore((previous) => ({ ...previous, [view]: next }))
  }

  const resetFilters = () => {
    setFilterStore((previous) => {
      const next = { ...previous }
      delete next[view]
      return next
    })
  }

  // 无限瀑布流:哨兵进入视口(几何检查 + 滚动监听,不依赖 observer 触发时序)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const loadingMoreRef = useRef(false)
  const retryRef = useRef({ failures: 0, nextAt: 0 })
  useEffect(() => {
    const node = sentinelRef.current
    if (!node) return
    let cancelled = false
    const tryLoad = () => {
      if (cancelled || loadingMoreRef.current) return
      if (Date.now() < retryRef.current.nextAt) return
      if (feed.loading || feed.error || feedExhausted || filtersActive) return
      if (feedItems.length === 0) return
      const rect = node.getBoundingClientRect()
      if (rect.top > window.innerHeight + 1200 || rect.bottom < -1200) return
      loadingMoreRef.current = true
      setLoadingMore(true)
      onLoadMore()
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
    const interval = window.setInterval(tryLoad, 1200)
    return () => {
      cancelled = true
      observer.disconnect()
      scroller?.removeEventListener('scroll', onScroll)
      window.removeEventListener('scroll', onScroll)
      window.clearInterval(interval)
    }
  }, [feed.loading, feed.error, feedExhausted, filtersActive, feedItems.length, onLoadMore])

  if (view === 'settings') {
    return (
      <div className="page-view page-view--settings">
        <SettingsPanel
          sources={sources}
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
        <div className="feed-status" role="status">
          <Loader2 className="feed-spinner" size={20} aria-hidden />
          {t('common.loading')}
        </div>
      )}

      {!filtersActive && isDoubanView && (feed.error || doubanEmpty) && (
        <div className="feed-status feed-status--warn">
          <span>{t('common.loadFailed')}</span>
          <button type="button" className="btn btn--glass btn--small" onClick={onRetry}>
            <RefreshCw size={13} aria-hidden /> {t('common.retry')}
          </button>
        </div>
      )}

      {filtersActive && explore.loading && (
        <div className="feed-status" role="status">
          <Loader2 className="feed-spinner" size={20} aria-hidden />
          {t('common.loading')}
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

      {isDoubanView && !filtersActive && !feed.loading && !feed.error && !feedExhausted && displayItems.length > 0 && (
        <div className="feed-sentinel" ref={sentinelRef} aria-hidden>
          {loadingMore && <Loader2 className="feed-spinner" size={16} aria-hidden />}
        </div>
      )}
    </div>
  )
}
