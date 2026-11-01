import type { ViewKey } from './data'
import type { ExploreSort, ExploreValues } from './douban'
import type { Language, MessageKey } from './i18n'

export interface FilterConfig {
  forms?: { value: string; labelKey: MessageKey }[]
  genres: string[]
  regions: string[]
  years: string[]
  sorts: { value: ExploreSort; labelKey: MessageKey }[]
  defaults: ExploreValues
}

const REGIONS = [
  '华语',
  '欧美',
  '韩国',
  '日本',
  '中国大陆',
  '美国',
  '中国香港',
  '中国台湾',
  '英国',
  '法国',
  '德国',
  '意大利',
  '西班牙',
  '印度',
  '泰国',
  '俄罗斯',
  '加拿大',
  '澳大利亚',
  '爱尔兰',
  '瑞典',
  '巴西',
  '丹麦',
]

const YEARS = [
  '2026',
  '2025',
  '2024',
  '2023',
  '2022',
  '2021',
  '2020',
  '2019',
  '2010年代',
  '2000年代',
  '90年代',
  '80年代',
  '70年代',
  '60年代',
  '更早',
]

const MOVIE_GENRES = [
  '喜剧',
  '爱情',
  '动作',
  '科幻',
  '动画',
  '悬疑',
  '犯罪',
  '惊悚',
  '冒险',
  '音乐',
  '历史',
  '奇幻',
  '恐怖',
  '战争',
  '传记',
  '歌舞',
  '武侠',
  '灾难',
  '西部',
  '纪录片',
  '短片',
]

const TV_GENRES = [
  '喜剧',
  '爱情',
  '悬疑',
  '动画',
  '武侠',
  '古装',
  '家庭',
  '犯罪',
  '科幻',
  '恐怖',
  '历史',
  '战争',
  '动作',
  '冒险',
  '传记',
  '剧情',
  '奇幻',
  '惊悚',
  '灾难',
  '歌舞',
  '音乐',
]

const ANIME_GENRES = [
  '剧情',
  '喜剧',
  '爱情',
  '科幻',
  '奇幻',
  '冒险',
  '动作',
  '悬疑',
  '犯罪',
  '恐怖',
  '惊悚',
  '历史',
  '战争',
  '音乐',
  '家庭',
]

const NEW_GENRES = Array.from(new Set([...MOVIE_GENRES, ...TV_GENRES]))

const FILTER_LABEL_EN: Record<string, string> = {
  喜剧: 'Comedy',
  爱情: 'Romance',
  动作: 'Action',
  科幻: 'Sci-Fi',
  动画: 'Animation',
  悬疑: 'Mystery',
  犯罪: 'Crime',
  惊悚: 'Thriller',
  冒险: 'Adventure',
  音乐: 'Music',
  历史: 'History',
  奇幻: 'Fantasy',
  恐怖: 'Horror',
  战争: 'War',
  传记: 'Biography',
  歌舞: 'Musical',
  武侠: 'Wuxia',
  灾难: 'Disaster',
  西部: 'Western',
  纪录片: 'Documentary',
  短片: 'Short',
  古装: 'Period',
  家庭: 'Family',
  剧情: 'Drama',
  华语: 'Chinese',
  欧美: 'Western',
  韩国: 'South Korea',
  日本: 'Japan',
  中国大陆: 'Mainland China',
  美国: 'United States',
  中国香港: 'Hong Kong',
  中国台湾: 'Taiwan',
  英国: 'UK',
  法国: 'France',
  德国: 'Germany',
  意大利: 'Italy',
  西班牙: 'Spain',
  印度: 'India',
  泰国: 'Thailand',
  俄罗斯: 'Russia',
  加拿大: 'Canada',
  澳大利亚: 'Australia',
  爱尔兰: 'Ireland',
  瑞典: 'Sweden',
  巴西: 'Brazil',
  丹麦: 'Denmark',
  '2010年代': '2010s',
  '2000年代': '2000s',
  '90年代': "'90s",
  '80年代': "'80s",
  '70年代': "'70s",
  '60年代': "'60s",
  更早: 'Earlier',
}

export const filterLabel = (value: string, language: Language) =>
  language === 'zh' ? value : (FILTER_LABEL_EN[value] ?? value)

const SORTS: FilterConfig['sorts'] = [
  { value: 'T', labelKey: 'filter.sortRecommend' },
  { value: 'U', labelKey: 'filter.sortTrending' },
  { value: 'R', labelKey: 'filter.sortRelease' },
  { value: 'S', labelKey: 'filter.sortRating' },
]

const defaults = (form: string, sort: ExploreSort): ExploreValues => ({
  form,
  genre: '',
  region: '',
  year: '',
  minRating: 0,
  sort,
})

export const FILTER_DEFAULTS: Record<string, ExploreValues> = {
  new: defaults('all', 'R'),
  tv: defaults('all', 'T'),
  movies: defaults('movie', 'T'),
  anime: defaults('all', 'T'),
}

const MOVIES_CONFIG: FilterConfig = {
  genres: MOVIE_GENRES,
  regions: REGIONS,
  years: YEARS,
  sorts: SORTS,
  defaults: FILTER_DEFAULTS.movies,
}

const TV_CONFIG: FilterConfig = {
  forms: [
    { value: 'all', labelKey: 'filter.all' },
    { value: 'series', labelKey: 'media.series' },
    { value: 'variety', labelKey: 'filter.variety' },
  ],
  genres: TV_GENRES,
  regions: REGIONS,
  years: YEARS,
  sorts: SORTS,
  defaults: FILTER_DEFAULTS.tv,
}

const ANIME_CONFIG: FilterConfig = {
  forms: [
    { value: 'all', labelKey: 'filter.all' },
    { value: 'series', labelKey: 'media.series' },
    { value: 'film', labelKey: 'media.film' },
  ],
  genres: ANIME_GENRES,
  regions: REGIONS,
  years: YEARS,
  sorts: SORTS,
  defaults: FILTER_DEFAULTS.anime,
}

const NEW_CONFIG: FilterConfig = {
  forms: [
    { value: 'all', labelKey: 'filter.all' },
    { value: 'movie', labelKey: 'media.film' },
    { value: 'tv', labelKey: 'nav.tv' },
    { value: 'anime', labelKey: 'nav.anime' },
  ],
  genres: NEW_GENRES,
  regions: REGIONS,
  years: YEARS,
  sorts: SORTS,
  defaults: FILTER_DEFAULTS.new,
}

export const filterConfigFor = (view: ViewKey): FilterConfig | null => {
  if (view === 'movies') return MOVIES_CONFIG
  if (view === 'tv') return TV_CONFIG
  if (view === 'anime') return ANIME_CONFIG
  if (view === 'new') return NEW_CONFIG
  return null
}

export const sanitizeFilters = (
  config: FilterConfig,
  values?: ExploreValues,
): ExploreValues => {
  if (!values) return config.defaults
  const allowedForms = config.forms?.map((form) => form.value)
  const form =
    !allowedForms || allowedForms.includes(values.form)
      ? values.form
      : config.defaults.form
  const pick = (value: unknown, options: string[], fallback: string) =>
    typeof value === 'string' && options.includes(value) ? value : fallback
  const rawRating = (values as { minRating?: unknown }).minRating
  const minRating =
    typeof rawRating === 'number' && Number.isFinite(rawRating)
      ? Math.min(10, Math.max(0, Math.round(rawRating)))
      : config.defaults.minRating
  const sort = config.sorts.some((option) => option.value === values.sort)
    ? values.sort
    : config.defaults.sort
  return {
    form,
    genre: pick(values.genre, config.genres, ''),
    region: pick(values.region, config.regions, ''),
    year: pick(values.year, config.years, ''),
    minRating,
    sort,
  }
}

export const isFilterActive = (view: ViewKey, values?: ExploreValues) => {
  if (!values) return false
  const fallback = FILTER_DEFAULTS[view]
  if (!fallback) return false
  return (
    values.form !== fallback.form ||
    values.genre !== '' ||
    values.region !== '' ||
    values.year !== '' ||
    values.minRating !== 0 ||
    values.sort !== fallback.sort
  )
}
