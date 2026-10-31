import { ChevronRight, Loader2, RefreshCw } from 'lucide-react'
import type { Slide, Title, ViewKey } from '../data'
import type { FeedState } from '../douban'
import { useI18n } from '../i18n'
import Hero from './Hero'
import TitleCard from './TitleCard'

interface HomeViewProps {
  slideIndex: number
  slides: Slide[]
  items: Title[]
  feed: FeedState
  myList: string[]
  resolveTitle: (id: string) => Title | undefined
  onSlide: (index: number) => void
  onNavigate: (view: ViewKey) => void
  onOpen: (id: string) => void
  onPlay: (id: string) => void
  onToggleList: (id: string) => void
  onRetry: () => void
}

export default function HomeView({
  slideIndex,
  slides,
  items,
  feed,
  myList,
  resolveTitle,
  onSlide,
  onNavigate,
  onOpen,
  onPlay,
  onToggleList,
  onRetry,
}: HomeViewProps) {
  const { t } = useI18n()

  const effectiveSlides: Slide[] = slides
  const effectiveItems = items

  const safeIndex = Number.isFinite(slideIndex)
    ? Math.min(slideIndex, effectiveSlides.length - 1)
    : 0
  const slide = effectiveSlides[safeIndex]
  const featured = slide ? resolveTitle(slide.featuredId) : undefined
  const sideTitles = slide
    ? slide.sideIds.map((id) => resolveTitle(id)).filter((title): title is Title => Boolean(title))
    : []

  if (!featured) {
    return (
      <div className="home-view">
        {feed.loading ? (
          <div className="feed-status" role="status">
            <Loader2 className="feed-spinner" size={20} aria-hidden />
            {t('common.loading')}
          </div>
        ) : feed.error ? (
          <div className="feed-status feed-status--warn">
            <span>{t('common.loadFailed')}</span>
            <button type="button" className="btn btn--glass btn--small" onClick={onRetry}>
              <RefreshCw size={13} aria-hidden /> {t('common.retry')}
            </button>
          </div>
        ) : (
          <div className="feed-status" role="status">
            <span>{t('common.emptyNow')}</span>
            <button type="button" className="btn btn--glass btn--small" onClick={onRetry}>
              <RefreshCw size={13} aria-hidden /> {t('common.retry')}
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="home-view">
      {feed.loading && items.length === 0 && (
        <div className="feed-status" role="status">
          <Loader2 className="feed-spinner" size={20} aria-hidden />
          {t('common.loading')}
        </div>
      )}

      {!feed.loading && !feed.error && items.length === 0 && (
        <div className="feed-status" role="status">
          <span>{t('common.emptyNow')}</span>
          <button type="button" className="btn btn--glass btn--small" onClick={onRetry}>
            <RefreshCw size={13} aria-hidden /> {t('common.retry')}
          </button>
        </div>
      )}

      {feed.error && (
        <div className="feed-status feed-status--warn">
          <span>{t('common.loadFailed')}</span>
          <button type="button" className="btn btn--glass btn--small" onClick={onRetry}>
            <RefreshCw size={13} aria-hidden /> {t('common.retry')}
          </button>
        </div>
      )}

      <div className="hero-row">
        <Hero
          featured={featured}
          slides={effectiveSlides}
          slideIndex={safeIndex}
          onSlide={onSlide}
          onOpen={onOpen}
          onPlay={onPlay}
        />
        {sideTitles.map((title) => (
          <TitleCard
            key={title.id}
            title={title}
            variant="continue"
            inList={myList.includes(title.id)}
            onOpen={onOpen}
            onPlay={onPlay}
            onToggleList={onToggleList}
          />
        ))}
      </div>

      <section className="shelf" aria-labelledby="new-popular-heading">
        <div className="section-head">
          <h2 id="new-popular-heading">{t('home.newPopular')}</h2>
          <button
            type="button"
            className="section-chevron"
            aria-label={t('home.seeAll')}
            onClick={() => onNavigate('new')}
          >
            <ChevronRight size={18} strokeWidth={2.1} aria-hidden />
          </button>
        </div>
        <div className="poster-grid poster-grid--home">
          {effectiveItems.map((title, index) => (
            <TitleCard
              key={title.id}
              title={title}
              inList={myList.includes(title.id)}
              priority={index < 3}
              onOpen={onOpen}
              onPlay={onPlay}
              onToggleList={onToggleList}
            />
          ))}
        </div>
      </section>
    </div>
  )
}
