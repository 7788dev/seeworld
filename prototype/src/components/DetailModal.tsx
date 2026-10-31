import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Bookmark,
  BookmarkCheck,
  Check,
  Play,
  Plus,
  ThumbsUp,
  Volume2,
  X,
} from 'lucide-react'
import {
  episodeFromLabel,
  episodeName,
  episodeSynopsis,
  formatEpisodeLabel,
  formatRuntimeLabel,
  mediaLabel,
  seasonsLabel,
  titleEpisodeLabel,
  titleGenres,
  titleLanguageName,
  titleName,
  titleSynopsis,
} from '../content'
import type { Episode, Title } from '../data'
import { useI18n } from '../i18n'
import { isDesktopApp } from '../lib'
import {
  isPlayableEpisode,
  isPlayableLine,
  matchTitleName,
  playDetail,
  readMatch,
  sourceFromTitleId,
} from '../play'
import { useFocusTrap } from '../useFocusTrap'
import { stripHtml } from '../lib'
import { cx, isPortraitImage, percentage } from '../lib'
import type { PlaybackProgress } from '../types'

interface DetailModalProps {
  title: Title
  related: Title[]
  inList: boolean
  inLater: boolean
  liked: boolean
  progress?: PlaybackProgress
  onClose: () => void
  onPlay: (id: string, episode?: Episode) => void
  onToggleList: (id: string) => void
  onToggleLater: (id: string) => void
  onToggleLike: (id: string) => void
  onOpenRelated: (id: string) => void
}

export default function DetailModal({
  title: titleProp,
  related,
  inList,
  inLater,
  liked,
  progress,
  onClose,
  onPlay,
  onToggleList,
  onToggleLater,
  onToggleLike,
  onOpenRelated,
}: DetailModalProps) {
  const { language, t } = useI18n()

  // 真实源站数据:详情打开后用播放源的实际内容增强(每集真实名称、真实简介)。
  // ps- 前缀是搜索结果直接命中的源站条目,按 id 还原 sourceKey/vodId。
  const [sourceEpisodeNames, setSourceEpisodeNames] = useState<string[]>([])
  const [sourceOverride, setSourceOverride] = useState<
    Pick<Title, 'synopsis' | 'episodes' | 'episodesCount'> | null
  >(null)
  const title = useMemo(
    () => (sourceOverride ? { ...titleProp, ...sourceOverride } : titleProp),
    [sourceOverride, titleProp],
  )
  useEffect(() => {
    setSourceOverride(null)
    setSourceEpisodeNames([])
  }, [titleProp.id])

  useEffect(() => {
    if (!isDesktopApp) return
    let cancelled = false
    const id = titleProp.id
    const fromSearch =
      sourceFromTitleId(id) ??
      (() => {
        const match = readMatch(id)
        return match && matchTitleName(titleProp, match.matchedName) ? match : null
      })()
    if (!fromSearch) return
    void playDetail(fromSearch.sourceKey, fromSearch.vodId)
      .then((detail) => {
        if (cancelled) return
        const line = detail.lines.find(isPlayableLine)
        if (!line || line.episodes.length === 0) return
        const playable = line.episodes
          .map((episode, index) => ({ episode, index }))
          .filter(({ episode }) => isPlayableEpisode(episode))
        if (playable.length === 0 && titleProp.mediaType === 'series') return
        const isSeries = titleProp.mediaType === 'series'
        setSourceEpisodeNames(isSeries ? line.episodes.map((episode) => episode.name) : [])
        setSourceOverride({
          synopsis: stripHtml(detail.content || titleProp.synopsis),
          episodes: isSeries
            ? playable.map(({ episode, index }) => ({
                id: `${id}-s1e${index + 1}`,
                season: 1,
                number: index + 1,
                name: episode.name || `第${index + 1}集`,
                runtime: '',
                synopsis: '',
              }))
            : titleProp.episodes,
          episodesCount: isSeries ? playable.length : titleProp.episodesCount,
        })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [titleProp.id])
  const panelRef = useRef<HTMLElement>(null)
  useFocusTrap(panelRef)
  const heroRef = useRef<HTMLImageElement>(null)
  const [portraitId, setPortraitId] = useState<string | null>(null)
  const portraitHero = portraitId === title.id
  const progressPct = progress ? percentage(progress.current, progress.duration) : 0
  const episodes = title.episodes ?? []
  const savedEpisode = useMemo(() => {
    if (progress?.episodeId) {
      const byId = episodes.find((episode) => episode.id === progress.episodeId)
      if (byId) return byId
    }
    if (progress?.episodeIndex !== undefined) {
      const index = progress.episodeIndex
      return episodes.find((episode) => episode.number === index + 1)
    }
    return undefined
  }, [episodes, progress?.episodeId, progress?.episodeIndex])
  const initialEpisode = savedEpisode ?? episodeFromLabel(title) ?? episodes[0]
  const meta =
    title.mediaType === 'series'
      ? title.seasons
        ? seasonsLabel(title, language)
        : title.episodesCount
          ? t('douban.episodesCount', { count: title.episodesCount })
          : ''
      : formatRuntimeLabel(title.duration, language)
  const localizedName = titleName(title, language)
  const separator = language === 'zh' ? '、' : ', '
  const progressLabel = initialEpisode
    ? formatEpisodeLabel(
        initialEpisode.season,
        initialEpisode.number,
        episodeName(initialEpisode, language),
        language,
      )
    : (titleEpisodeLabel(title, language) ?? t('detail.continueWatching'))
  const ratingLabel =
    title.doubanRating !== undefined
      ? t('douban.ratingBadge', { rating: title.doubanRating.toFixed(1) })
      : title.match > 0
        ? t('match.label', { percent: title.match })
        : ''
  const synopsisText = titleSynopsis(title, language)

  useEffect(() => {
    const image = heroRef.current
    if (image?.complete && isPortraitImage(image)) setPortraitId(title.id)
  }, [titleProp.id])

  const detectPortrait = (image: HTMLImageElement) => {
    if (isPortraitImage(image)) setPortraitId(title.id)
  }

  return (
    <div className="modal-layer" onClick={onClose}>
      <article
        className="detail-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="detail-title"
        tabIndex={-1}
        ref={panelRef}
        onClick={(event) => event.stopPropagation()}
      >
        <div className={cx('detail-hero', portraitHero && 'is-portrait')}>
          <img
            ref={heroRef}
            className="detail-hero-art"
            src={title.hero ?? title.poster}
            alt=""
            onLoad={(event) => detectPortrait(event.currentTarget)}
          />
          {portraitHero && (
            <img className="detail-poster" src={title.poster} alt="" aria-hidden />
          )}
          <div className="detail-hero-shade" aria-hidden />
          <button
            type="button"
            className="modal-close"
            aria-label={t('detail.close')}
            onClick={onClose}
          >
            <X size={19} />
          </button>
          <div className="detail-hero-copy">
            <div className="hero-brand">
              <span className="n-mark">S</span>
              <span>{mediaLabel(title.mediaType, language)}</span>
            </div>
            <h2
              id="detail-title"
              className={cx('detail-title', `type-${title.titleStyle}`)}
              aria-label={localizedName}
            >
              {title.titleLines.map((line) => (
                <span key={line}>{line}</span>
              ))}
            </h2>
            <div className="hero-meta">
              {ratingLabel && <span className="match">{ratingLabel}</span>}
              {title.year > 0 && <span>{title.year}</span>}
              {meta && <span>{meta}</span>}
              {title.region && <span>{title.region}</span>}
              {title.ageRating && <span className="age-chip">{title.ageRating}</span>}
              <span className="quality-chip">HD</span>
            </div>
          </div>
        </div>

        <div className="detail-body">
          <div className="detail-actions">
            <button type="button" className="btn btn--play" onClick={() => onPlay(title.id)}>
              <Play size={17} fill="currentColor" strokeWidth={0} aria-hidden />
              {progressPct > 0 ? t('detail.resume') : t('detail.play')}
            </button>
            <button
              type="button"
              className={cx('round-action', inList && 'is-on')}
              aria-label={inList ? t('detail.removeList') : t('detail.addList')}
              title={inList ? t('detail.removeList') : t('detail.addList')}
              onClick={() => onToggleList(title.id)}
            >
              {inList ? <Check size={18} /> : <Plus size={18} />}
            </button>
            <button
              type="button"
              className={cx('round-action', inLater && 'is-on')}
              aria-label={inLater ? t('detail.removeLater') : t('detail.addLater')}
              title={inLater ? t('detail.removeLater') : t('detail.addLater')}
              onClick={() => onToggleLater(title.id)}
            >
              {inLater ? <BookmarkCheck size={18} /> : <Bookmark size={18} />}
            </button>
            <button
              type="button"
              className={cx('round-action', liked && 'is-on')}
              aria-label={liked ? t('detail.removeRating') : t('detail.rate')}
              title={liked ? t('detail.removeRating') : t('detail.rate')}
              onClick={() => onToggleLike(title.id)}
            >
              <ThumbsUp size={18} fill={liked ? 'currentColor' : 'none'} />
            </button>
            <span className="detail-audio">
              <Volume2 size={15} aria-hidden /> {titleLanguageName(title, language)} ·{' '}
              {t('detail.audioDescription')}
            </span>
          </div>

          {progress && progressPct > 0 && (
            <div className="detail-progress">
              <span style={{ width: `${progressPct}%` }} />
              <p>{progressLabel}</p>
            </div>
          )}

          <div className="detail-columns">
            <div className="detail-main">
              {synopsisText && <p className="detail-synopsis">{synopsisText}</p>}
              {title.cast.length > 0 && (
                <p className="detail-line">
                  <span>{t('detail.cast')}</span> {title.cast.join(', ')}
                </p>
              )}
              {title.creator && (
                <p className="detail-line">
                  <span>{t('detail.createdBy')}</span> {title.creator}
                </p>
              )}
            </div>
            <aside className="detail-aside">
              {titleGenres(title, language).length > 0 && (
                <p>
                  <span>{t('detail.genres')}</span>{' '}
                  {titleGenres(title, language).join(separator)}
                </p>
              )}
              {title.doubanRating !== undefined ? (
                <p>
                  <span>{t('detail.doubanRating')}</span>{' '}
                  {title.doubanVotes
                    ? t('detail.doubanRatingValue', {
                        rating: title.doubanRating.toFixed(1),
                        count: title.doubanVotes,
                      })
                    : t('detail.doubanRatingValueNoVotes', {
                        rating: title.doubanRating.toFixed(1),
                      })}
                </p>
              ) : title.ageRating ? (
                <p>
                  <span>{t('detail.maturity')}</span>{' '}
                  {t('detail.maturityValue', {
                    rating: title.ageRating,
                    age: title.ageRating.replace('+', ''),
                  })}
                </p>
              ) : (
                <p>
                  <span>{t('detail.doubanRating')}</span>{' '}
                  {t('detail.doubanRatingNone')}
                </p>
              )}
              {title.pubdate && (
                <p>
                  <span>{language === 'zh' ? '上映：' : 'Released:'}</span> {title.pubdate}
                </p>
              )}
              <p>
                <span>{t('detail.audio')}</span>{' '}
                {t('detail.audioValue', {
                  language: titleLanguageName(title, language),
                })}
              </p>
            </aside>
          </div>

          {episodes.length > 0 && (
            <section className="detail-episodes" aria-labelledby="episodes-heading">
              <div className="detail-section-head">
                <h3 id="episodes-heading">{t('detail.episodes')}</h3>
                <span>
                  {t('detail.season', {
                    season: initialEpisode?.season ?? episodes[0].season,
                  })}
                </span>
              </div>
              <div className="detail-episode-list">
                {episodes.map((episode) => {
                  const active = initialEpisode?.id === episode.id
                  return (
                    <button
                      key={episode.id}
                      type="button"
                      className={cx('detail-episode', active && 'is-active')}
                      onClick={() => onPlay(title.id, episode)}
                    >
                      <span className="detail-episode-thumb">
                        <img src={title.poster} alt="" />
                        <span>
                          <Play size={12} fill="currentColor" strokeWidth={0} />
                        </span>
                      </span>
                      <span className="detail-episode-copy">
                        <span className="detail-episode-top">
                          <strong>
                            {episode.number}. {sourceEpisodeNames[episode.number - 1] || episodeName(episode, language)}
                          </strong>
                          <em>{formatRuntimeLabel(episode.runtime, language)}</em>
                        </span>
                        {episodeSynopsis(episode, language) && (
                          <p>{episodeSynopsis(episode, language)}</p>
                        )}
                      </span>
                    </button>
                  )
                })}
              </div>
            </section>
          )}

          {related.length > 0 && (
            <section className="detail-related" aria-labelledby="related-heading">
              <div className="detail-section-head">
                <h3 id="related-heading">{t('detail.moreLikeThis')}</h3>
              </div>
              <div className="related-grid">
                {related.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="related-card"
                    onClick={() => onOpenRelated(item.id)}
                  >
                    <img src={item.poster} alt="" />
                    <span className="related-shade" aria-hidden />
                    <span className="related-copy">
                      <span className="related-top">
                        <span className="match">
                          {item.doubanRating !== undefined
                            ? t('douban.ratingBadge', { rating: item.doubanRating.toFixed(1) })
                            : t('match.label', { percent: item.match })}
                        </span>
                        {item.ageRating && <span className="age-chip">{item.ageRating}</span>}
                      </span>
                      <strong>{titleName(item, language)}</strong>
                      {titleGenres(item, language).length > 0 && (
                        <span>{titleGenres(item, language).join(' · ')}</span>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>
      </article>
    </div>
  )
}
