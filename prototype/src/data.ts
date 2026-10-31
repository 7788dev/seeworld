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

const STORY = {
  stranger: {
    synopsis:
      'When a young boy vanishes, a small town uncovers a mystery involving secret experiments, terrifying forces, and one strange little girl.',
    cast: ['Millie Bobby Brown', 'Finn Wolfhard', 'Winona Ryder', 'David Harbour'],
    creator: 'The Duffer Brothers',
  },
  nightAgent: {
    synopsis:
      'A low-level FBI agent working the night shift in the White House basement answers a phone call that plunges him into a deadly conspiracy reaching the Oval Office.',
    cast: ['Gabriel Basso', 'Luciane Buchanan', 'Fola Evans-Akingbola'],
    creator: 'Shawn Ryan',
  },
  wednesday: {
    synopsis:
      'Smart, sarcastic and a little dead inside, Wednesday Addams investigates twisted mysteries at Nevermore Academy while making—and keeping—a few unlikely friends.',
    cast: ['Jenna Ortega', 'Gwendoline Christie', 'Riki Lindhome'],
    creator: 'Al Gough & Miles Millar',
  },
  leaveWorld: {
    synopsis:
      'A family vacation on Long Island is interrupted by a cyberattack, forcing two families to confront the possibility that the world as they know it is ending.',
    cast: ['Julia Roberts', 'Mahershala Ali', 'Ethan Hawke'],
    creator: 'Sam Esmail',
  },
  crown: {
    synopsis:
      'Follow the political rivalries and romance of Queen Elizabeth II’s reign, and the events that shaped the second half of the twentieth century.',
    cast: ['Imelda Staunton', 'Claire Foy', 'Olivia Colman'],
    creator: 'Peter Morgan',
  },
  rebelMoon: {
    synopsis:
      'When a peaceful settlement on the edge of the galaxy is threatened by a ruthless army, a mysterious stranger must gather warriors from across the stars to make a stand.',
    cast: ['Sofia Boutella', 'Djimon Hounsou', 'Ed Skrein'],
    creator: 'Zack Snyder',
  },
  lupin: {
    synopsis:
      'Inspired by the adventures of Arsène Lupin, gentleman thief Assane Diop sets out to avenge his father for an injustice inflicted by a wealthy family.',
    cast: ['Omar Sy', 'Ludivine Sagnier', 'Clotilde Hesme'],
    creator: 'George Kay',
  },
  witcher: {
    synopsis:
      'Geralt of Rivia, a mutated monster-hunter for hire, journeys toward his destiny in a turbulent world where people often prove more wicked than beasts.',
    cast: ['Henry Cavill', 'Anya Chalotra', 'Freya Allan'],
    creator: 'Lauren Schmidt Hissrich',
  },
  killer: {
    synopsis:
      'After a fateful near miss, an assassin battles his employers—and himself—on an international manhunt he insists isn’t personal.',
    cast: ['Michael Fassbender', 'Tilda Swinton', 'Charles Parnell'],
    creator: 'David Fincher',
  },
}

const EP_PROGRESS = 32 * 60 + 15
const EP_DURATION = 77 * 60 + 42

export const titles: Title[] = [
  {
    id: 'stranger',
    name: 'Stranger Things',
    mediaType: 'series',
    year: 2022,
    seasons: 4,
    ageRating: '16+',
    match: 98,
    genres: ['Sci-Fi', 'Horror', 'Mystery'],
    synopsis: STORY.stranger.synopsis,
    poster: '/assets/poster-stranger.webp',
    hero: '/assets/hero-stranger.webp',
    titleStyle: 'glow',
    titleLines: ['STRANGER', 'THINGS'],
    language: 'English',
    creator: STORY.stranger.creator,
    cast: STORY.stranger.cast,
    episodeLabel: 'S4 E7 · The Massacre at Hawkins Lab',
    progress: { current: EP_PROGRESS, duration: EP_DURATION },
    addedOrder: 3,
    episodes: [
      {
        id: 'st-401',
        season: 4,
        number: 1,
        name: 'The Hellfire Club',
        runtime: '1h 16m',
        synopsis: 'Eleven struggles to adapt to life in California while a new threat stirs beneath Hawkins.',
      },
      {
        id: 'st-407',
        season: 4,
        number: 7,
        name: 'The Massacre at Hawkins Lab',
        runtime: '1h 17m',
        synopsis: 'The pieces of the mystery finally come together as a terrible truth is uncovered.',
      },
      {
        id: 'st-408',
        season: 4,
        number: 8,
        name: 'Papa',
        runtime: '1h 25m',
        synopsis: 'With time running out, the group makes a final plan to save their friend.',
      },
    ],
  },
  {
    id: 'night-agent',
    name: 'The Night Agent',
    mediaType: 'series',
    year: 2023,
    seasons: 1,
    ageRating: '16+',
    match: 54,
    genres: ['Thriller', 'Action'],
    synopsis: STORY.nightAgent.synopsis,
    poster: '/assets/poster-night-agent.webp',
    titleStyle: 'condensed',
    titleLines: ['NIGHT', 'AGENT'],
    cardTitleSize: 'lg',
    language: 'English',
    creator: STORY.nightAgent.creator,
    cast: STORY.nightAgent.cast,
    progress: { current: 14 * 60 + 2, duration: 49 * 60 + 20 },
    addedOrder: 8,
  },
  {
    id: 'wednesday',
    name: 'Wednesday',
    mediaType: 'series',
    year: 2022,
    seasons: 1,
    ageRating: '13+',
    match: 96,
    genres: ['Mystery', 'Comedy'],
    synopsis: STORY.wednesday.synopsis,
    poster: '/assets/poster-wednesday.webp',
    hero: '/assets/hero-wednesday.webp',
    titleStyle: 'gothic',
    titleLines: ['WEDNESDAY'],
    cardTitleSize: 'lg',
    language: 'English',
    creator: STORY.wednesday.creator,
    cast: STORY.wednesday.cast,
    progress: { current: 22 * 60 + 40, duration: 48 * 60 + 12 },
    addedOrder: 2,
    episodes: [
      {
        id: 'wd-101',
        season: 1,
        number: 1,
        name: 'Wednesday’s Child Is Full of Woe',
        runtime: '59m',
        synopsis: 'Wednesday arrives at Nevermore Academy and immediately makes an enemy—or three.',
      },
      {
        id: 'wd-104',
        season: 1,
        number: 4,
        name: 'Woe What a Night',
        runtime: '50m',
        synopsis: 'Wednesday uncovers a clue at the school dance while the town grows suspicious.',
      },
      {
        id: 'wd-108',
        season: 1,
        number: 8,
        name: 'A Murder of Woes',
        runtime: '54m',
        synopsis: 'Wednesday must face the monster lurking in the woods to protect her friends.',
      },
    ],
  },
  {
    id: 'leave-world',
    name: 'Leave the World Behind',
    mediaType: 'film',
    year: 2023,
    duration: '2h 21m',
    ageRating: '16+',
    match: 91,
    genres: ['Drama', 'Thriller'],
    synopsis: STORY.leaveWorld.synopsis,
    poster: '/assets/poster-leave-world.webp',
    titleStyle: 'condensed',
    titleLines: ['LEAVE THE', 'WORLD BEHIND'],
    language: 'English',
    creator: STORY.leaveWorld.creator,
    cast: STORY.leaveWorld.cast,
    isNew: true,
    addedOrder: 6,
  },
  {
    id: 'crown',
    name: 'The Crown',
    mediaType: 'series',
    year: 2016,
    seasons: 6,
    ageRating: '16+',
    match: 95,
    genres: ['Drama', 'Historical'],
    synopsis: STORY.crown.synopsis,
    poster: '/assets/poster-crown.webp',
    titleStyle: 'royal',
    titleLines: ['CROWN'],
    cardTitleSize: 'md',
    language: 'English',
    creator: STORY.crown.creator,
    cast: STORY.crown.cast,
    addedOrder: 4,
    episodes: [
      {
        id: 'cr-401',
        season: 4,
        number: 1,
        name: 'Gold Stick',
        runtime: '54m',
        synopsis: 'Elizabeth welcomes a new prime minister while the family faces a new generation of headlines.',
      },
      {
        id: 'cr-406',
        season: 4,
        number: 6,
        name: 'Terra Nullius',
        runtime: '56m',
        synopsis: 'A royal tour behind the Iron Curtain forces the palace to confront uncomfortable truths.',
      },
      {
        id: 'cr-610',
        season: 6,
        number: 10,
        name: 'Sleep, Dearie Sleep',
        runtime: '1h 12m',
        synopsis: 'The Queen reflects on a lifetime of service and the legacy that will outlast her.',
      },
    ],
  },
  {
    id: 'rebel-moon',
    name: 'Rebel Moon',
    mediaType: 'film',
    year: 2023,
    duration: '2h 15m',
    ageRating: '16+',
    match: 88,
    genres: ['Sci-Fi', 'Action'],
    synopsis: STORY.rebelMoon.synopsis,
    poster: '/assets/poster-rebel-moon.webp',
    titleStyle: 'condensed',
    titleLines: ['REBEL MOON'],
    language: 'English',
    creator: STORY.rebelMoon.creator,
    cast: STORY.rebelMoon.cast,
    isNew: true,
    addedOrder: 5,
  },
  {
    id: 'lupin',
    name: 'Lupin',
    mediaType: 'series',
    year: 2021,
    seasons: 3,
    ageRating: '16+',
    match: 93,
    genres: ['Crime', 'Mystery'],
    synopsis: STORY.lupin.synopsis,
    poster: '/assets/poster-lupin.webp',
    titleStyle: 'condensed',
    titleLines: ['LUPIN'],
    cardTitleSize: 'md',
    language: 'French',
    creator: STORY.lupin.creator,
    cast: STORY.lupin.cast,
    progress: { current: 31 * 60 + 8, duration: 45 * 60 + 30 },
    addedOrder: 7,
    episodes: [
      {
        id: 'lp-101',
        season: 1,
        number: 1,
        name: 'Chapter 1',
        runtime: '47m',
        synopsis: 'Assane Diop sets out to avenge his father with a daring theft at the Louvre.',
      },
      {
        id: 'lp-105',
        season: 1,
        number: 5,
        name: 'Chapter 5',
        runtime: '46m',
        synopsis: 'The net closes in as Assane prepares an audacious public spectacle.',
      },
    ],
  },
  {
    id: 'witcher',
    name: 'The Witcher',
    mediaType: 'series',
    year: 2019,
    seasons: 3,
    ageRating: '18+',
    match: 89,
    genres: ['Fantasy', 'Action'],
    synopsis: STORY.witcher.synopsis,
    poster: '/assets/poster-witcher.webp',
    titleStyle: 'fantasy',
    titleLines: ['THE WITCHER'],
    cardTitleSize: 'md',
    language: 'English',
    creator: STORY.witcher.creator,
    cast: STORY.witcher.cast,
    addedOrder: 9,
    episodes: [
      {
        id: 'wt-101',
        season: 1,
        number: 1,
        name: 'The End’s Beginning',
        runtime: '1h 01m',
        synopsis: 'Geralt of Rivia crosses paths with a young princess bound to him by destiny.',
      },
      {
        id: 'wt-305',
        season: 3,
        number: 5,
        name: 'The Art of the Illusion',
        runtime: '57m',
        synopsis: 'Hidden loyalties surface as the Continent edges closer to war.',
      },
    ],
  },
  {
    id: 'killer',
    name: 'The Killer',
    mediaType: 'film',
    year: 2023,
    duration: '1h 58m',
    ageRating: '18+',
    match: 86,
    genres: ['Thriller', 'Crime'],
    synopsis: STORY.killer.synopsis,
    poster: '/assets/poster-killer.webp',
    titleStyle: 'condensed',
    titleLines: ['THE KILLER'],
    language: 'English',
    creator: STORY.killer.creator,
    cast: STORY.killer.cast,
    isNew: true,
    addedOrder: 1,
  },
]

export const titleById = (id: string) => titles.find((t) => t.id === id)

export interface Slide {
  featuredId: string
  sideIds: [string, string]
}

export const slides: Slide[] = [
  { featuredId: 'stranger', sideIds: ['night-agent', 'wednesday'] },
  { featuredId: 'wednesday', sideIds: ['lupin', 'crown'] },
]

export const newAndPopularIds = [
  'leave-world',
  'crown',
  'rebel-moon',
  'lupin',
  'witcher',
  'killer',
]

export type ViewKey =
  | 'home'
  | 'new'
  | 'tv'
  | 'movies'
  | 'anime'
  | 'my-list'
  | 'recent'
  | 'later'
  | 'downloads'
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
