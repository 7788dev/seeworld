export type MediaType = 'series' | 'film'

export type TitleStyle = 'glow' | 'gothic' | 'condensed' | 'royal' | 'fantasy'

export interface Episode {
  id: string
  season: number
  number: number
  name: string
  runtime: string
  synopsis: string
}

export interface Title {
  id: string
  name: string
  mediaType: MediaType
  year: number
  seasons?: number
  duration?: string
  ageRating: string
  match: number
  genres: string[]
  synopsis: string
  poster: string
  hero?: string
  titleStyle: TitleStyle
  titleLines: string[]
  cardTitleSize?: 'sm' | 'md' | 'lg'
  language: string
  creator: string
  cast: string[]
  episodeLabel?: string
  progress?: { current: number; duration: number }
  episodes?: Episode[]
  isNew?: boolean
  addedOrder: number
  doubanRating?: number
  doubanVotes?: number
  originalName?: string
  region?: string
  pubdate?: string
  episodesCount?: number
}

export interface Slide {
  featuredId: string
  sideIds: [string, string]
}

export type ViewKey =
  | 'home'
  | 'new'
  | 'tv'
  | 'movies'
  | 'anime'
  | 'my-list'
  | 'recent'
  | 'later'
  | 'settings'

export const languages = ['All', 'English', 'French', 'Korean', 'Spanish']

export const formatTime = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  return `${m}:${String(sec).padStart(2, '0')}`
}
