import { Loader2, SearchX } from 'lucide-react'
import type { Title } from '../data'
import { useI18n } from '../i18n'
import type { PlaybackProgress } from '../types'
import TitleCard from './TitleCard'

interface SearchViewProps {
  query: string
  results: Title[]
  busy: boolean
  partialErrors: number
  error: boolean
  myList: string[]
  progressFor: (id: string) => PlaybackProgress | undefined
  onOpen: (id: string) => void
  onPlay: (id: string) => void
  onToggleList: (id: string) => void
  onClear: () => void
  onRetry: () => void
}

export default function SearchView({
  query,
  results,
  busy,
  partialErrors,
  error,
  myList,
  progressFor,
  onOpen,
  onPlay,
  onToggleList,
  onClear,
  onRetry,
}: SearchViewProps) {
  const { t } = useI18n()

  return (
    <div className="page-view search-view" aria-busy={busy}>
      <header className="page-head">
        <div className="page-head-copy">
          <p className="eyebrow">{t('search.eyebrow')}</p>
          <h1>{t('search.resultsFor', { query })}</h1>
          <p className="page-subtitle" aria-live="polite">
            {busy
              ? t('search.searching')
              : error && results.length === 0
                ? t('search.errorTitle')
                : results.length === 0
                  ? t('search.noStories')
                  : results.length === 1
                    ? t('search.foundOne', { count: results.length })
                    : t('search.foundMany', { count: results.length })}
          </p>
        </div>
        <button type="button" className="btn btn--glass btn--small" onClick={onClear}>
          {t('search.clear')}
        </button>
      </header>

      {query.length > 0 && query.length < 2 && (
        <p className="search-hint">{t('search.minChars')}</p>
      )}

      {partialErrors > 0 && results.length > 0 && (
        <p className="search-partial" role="status">
          {t('search.partial', { count: partialErrors })}
        </p>
      )}

      {error && results.length > 0 && (
        <p className="search-partial" role="status">
          {t('search.partialFailure')}
        </p>
      )}

      {busy && results.length === 0 ? (
        <div className="feed-status" role="status">
          <Loader2 className="feed-spinner" size={20} aria-hidden />
          {t('search.searching')}
        </div>
      ) : results.length === 0 && error ? (
        <div className="empty-state" role="alert">
          <span className="empty-icon">
            <SearchX size={26} />
          </span>
          <h2>{t('search.errorTitle')}</h2>
          <p>{t('search.errorCopy')}</p>
          <button type="button" className="btn btn--glass" onClick={onRetry}>
            {t('search.retry')}
          </button>
        </div>
      ) : results.length === 0 ? (
        <div className="empty-state">
          <span className="empty-icon">
            <SearchX size={26} />
          </span>
          <h2>{t('search.emptyTitle')}</h2>
          <p>{t('search.emptyCopy')}</p>
          <button type="button" className="btn btn--glass" onClick={onClear}>
            {t('search.back')}
          </button>
        </div>
      ) : (
        <div className="poster-grid poster-grid--page">
          {results.map((title) => (
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
    </div>
  )
}
