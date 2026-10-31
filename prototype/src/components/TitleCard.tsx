import { Check, Play, Plus } from 'lucide-react'
import { mediaLabel, titleGenres, titleName } from '../content'
import type { Title } from '../data'
import { useI18n } from '../i18n'
import { cx, percentage } from '../lib'
import type { PlaybackProgress } from '../types'

interface TitleCardProps {
  title: Title
  variant?: 'poster' | 'continue'
  inList: boolean
  progress?: PlaybackProgress
  priority?: boolean
  onOpen: (id: string) => void
  onPlay: (id: string) => void
  onToggleList: (id: string) => void
}

export default function TitleCard({
  title,
  variant = 'poster',
  inList,
  progress,
  priority = false,
  onOpen,
  onPlay,
  onToggleList,
}: TitleCardProps) {
  const { language, t } = useI18n()
  const name = titleName(title, language)
  const progressPct = progress ? percentage(progress.current, progress.duration) : 0
  const titleClass = cx(
    'card-title',
    `type-${title.titleStyle}`,
    title.cardTitleSize && `card-title--${title.cardTitleSize}`,
  )

  return (
    <article className={cx('poster-card', `poster-card--${variant}`)}>
      <img
        className="card-img"
        src={title.poster}
        alt=""
        loading={priority ? 'eager' : 'lazy'}
        decoding="async"
      />
      <div className="card-shade" aria-hidden />

      <div className="card-actions">
        <button
          type="button"
          className="card-action"
          aria-label={t('card.play', { name })}
          onClick={() => onPlay(title.id)}
        >
          <Play size={13} fill="currentColor" strokeWidth={0} aria-hidden />
        </button>
        <button
          type="button"
          className={cx('card-action', inList && 'is-on')}
          aria-label={
            inList
              ? t('card.removeList', { name })
              : t('card.addList', { name })
          }
          onClick={() => onToggleList(title.id)}
        >
          {inList ? (
            <Check size={14} strokeWidth={2.4} aria-hidden />
          ) : (
            <Plus size={14} strokeWidth={2.2} aria-hidden />
          )}
        </button>
      </div>

      <div className="card-copy">
        <div className="card-brand">
          <span className="n-mark">N</span>
          <span>{mediaLabel(title.mediaType, language)}</span>
        </div>
        <h3 className={titleClass}>
          {title.titleLines.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </h3>
        {variant === 'continue' && (
          <p className="card-match">
            <span>
              {title.doubanRating !== undefined
                ? t('douban.ratingBadge', { rating: title.doubanRating.toFixed(1) })
                : t('match.label', { percent: title.match })}
            </span>
          </p>
        )}
        {titleGenres(title, language).length > 0 && (
          <p className="card-genres">{titleGenres(title, language).join(' · ')}</p>
        )}
      </div>

      {progress && progressPct > 0 && (
        <div className="card-progress" aria-hidden>
          <span style={{ width: `${progressPct}%` }} />
        </div>
      )}

      <button
        type="button"
        className="card-hit"
        aria-label={t('card.view', { name })}
        onClick={() => onOpen(title.id)}
      />
    </article>
  )
}
