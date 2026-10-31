import { Info, Play } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  formatRuntimeLabel,
  mediaLabel,
  seasonsLabel,
  titleGenres,
  titleName,
  titleSynopsis,
} from '../content'
import type { Slide, Title } from '../data'
import { useI18n } from '../i18n'
import { cx, isPortraitImage } from '../lib'

interface HeroProps {
  featured: Title
  slides: Slide[]
  slideIndex: number
  onSlide: (index: number) => void
  onOpen: (id: string) => void
  onPlay: (id: string) => void
}

export default function Hero({
  featured,
  slides,
  slideIndex,
  onSlide,
  onOpen,
  onPlay,
}: HeroProps) {
  const { language, t } = useI18n()
  const [portraitId, setPortraitId] = useState<string | null>(null)
  const artRef = useRef<HTMLImageElement>(null)
  const portrait = portraitId === featured.id
  useEffect(() => {
    const image = artRef.current
    if (image?.complete && isPortraitImage(image)) setPortraitId(featured.id)
  }, [featured.id])
  const detectPortrait = (image: HTMLImageElement) => {
    if (isPortraitImage(image)) setPortraitId(featured.id)
  }
  const meta =
    featured.mediaType === 'series'
      ? featured.seasons
        ? seasonsLabel(featured, language)
        : featured.episodesCount
          ? t('douban.episodesCount', { count: featured.episodesCount })
          : ''
      : formatRuntimeLabel(featured.duration, language)
  const name = titleName(featured, language)
  const ratingLabel =
    featured.doubanRating !== undefined
      ? t('douban.ratingBadge', { rating: featured.doubanRating.toFixed(1) })
      : featured.match > 0
        ? t('match.label', { percent: featured.match })
        : ''
  const genreList = titleGenres(featured, language)

  return (
    <section
      className={cx('hero', portrait && 'is-portrait')}
      aria-roledescription="carousel"
      aria-label={t('hero.featuredAria', { name })}
      onClick={() => onOpen(featured.id)}
    >
      <div className="hero-slide" key={featured.id}>
        <img
          ref={artRef}
          className="hero-art"
          src={featured.hero ?? featured.poster}
          alt=""
          decoding="async"
          fetchPriority="high"
          onLoad={(event) => detectPortrait(event.currentTarget)}
        />
        <div className="hero-scrim" aria-hidden />
        {portrait && (
          <img className="hero-poster" src={featured.poster} alt="" decoding="async" />
        )}

        <div className="hero-copy">
          <div className="hero-brand">
            <span className="n-mark">S</span>
            <span>{mediaLabel(featured.mediaType, language)}</span>
          </div>

          <h2 className={cx('hero-title', `type-${featured.titleStyle}`)} aria-label={name}>
            {featured.titleLines.map((line) => (
              <span key={line}>{line}</span>
            ))}
          </h2>

          <div className="hero-meta">
            {ratingLabel && <span className="match">{ratingLabel}</span>}
            {featured.year > 0 && <span>{featured.year}</span>}
            {meta && <span>{meta}</span>}
            {featured.ageRating && <span className="age-chip">{featured.ageRating}</span>}
          </div>

          {genreList.length > 0 && <p className="hero-genres">{genreList.join(' • ')}</p>}
          {titleSynopsis(featured, language) && (
            <p className="hero-synopsis">{titleSynopsis(featured, language)}</p>
          )}

          <div className="hero-actions">
            <button
              type="button"
              className="btn btn--play"
              onClick={(event) => {
                event.stopPropagation()
                onPlay(featured.id)
              }}
            >
              <Play size={17} fill="currentColor" strokeWidth={0} aria-hidden />
              {t('hero.play')}
            </button>
            <button
              type="button"
              className="btn btn--glass"
              onClick={(event) => {
                event.stopPropagation()
                onOpen(featured.id)
              }}
            >
              <Info size={17} aria-hidden />
              {t('hero.moreInfo')}
            </button>
          </div>
        </div>
      </div>

      <div className="hero-dots" onClick={(event) => event.stopPropagation()}>
        {slides.map((slide, index) => (
          <button
            key={slide.featuredId}
            type="button"
            className={cx('hero-dot', index === slideIndex && 'is-active')}
            aria-label={t('hero.showSlide', { index: index + 1, total: slides.length })}
            aria-current={index === slideIndex}
            onClick={() => onSlide(index)}
          />
        ))}
      </div>
    </section>
  )
}
