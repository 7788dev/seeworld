import { describe, expect, it } from 'vitest'
import { formatTime, languages } from './data'
import type { Title } from './data'
import {
  episodesOf,
  exploreRequests,
  normalizeDuration,
  placeholderEpisodes,
  unwrapDbImg,
  dbCardImg,
  suggestToTitle,
} from './douban'
import { sanitizeFilters, isFilterActive, FILTER_DEFAULTS, filterLabel } from './filters'
import { isPortraitImage, stripHtml, percentage, parseRuntime, isProgressFinished } from './lib'

describe('formatTime', () => {
  it('格式化时分秒', () => {
    expect(formatTime(0)).toBe('0:00')
    expect(formatTime(754)).toBe('12:34')
    expect(formatTime(3661)).toBe('1:01:01')
    expect(formatTime(-5)).toBe('0:00')
  })
})

describe('parseRuntime', () => {
  it('解析 "1h 16m" 为秒', () => {
    expect(parseRuntime('1h 16m')).toBe(3600 + 16 * 60)
    expect(parseRuntime('45m')).toBe(45 * 60)
    expect(parseRuntime(undefined)).toBeUndefined()
    expect(parseRuntime('unknown')).toBeUndefined()
  })
})

describe('normalizeDuration', () => {
  it('把中文时长规范成 "Xh Ym"/"Xm"', () => {
    expect(normalizeDuration('97分钟')).toBe('97m')
    expect(normalizeDuration('2小时3分钟')).toBe('2h 3m')
    expect(normalizeDuration('2小时')).toBe('2h')
    expect(normalizeDuration('')).toBeUndefined()
  })
})

describe('stripHtml', () => {
  it('清洗标签与实体并压缩空白', () => {
    expect(stripHtml('<p>你好<br/>世界&nbsp;!</p>')).toBe('你好 世界 !')
  })
})

describe('percentage', () => {
  it('钳制在 0-100', () => {
    expect(percentage(50, 100)).toBe(50)
    expect(percentage(200, 100)).toBe(100)
    expect(percentage(10, 0)).toBe(0)
  })
})

describe('unwrapDbImg / dbCardImg', () => {
  it('解包 dbimg 代理形式', () => {
    expect(unwrapDbImg('dbimg://img1.doubanio.com/a.jpg')).toBe(
      'https://img1.doubanio.com/a.jpg',
    )
    expect(unwrapDbImg('http://dbimg.localhost/https%3A%2F%2Fimg1.doubanio.com%2Fa.jpg')).toBe(
      'https://img1.doubanio.com/a.jpg',
    )
    expect(unwrapDbImg('https://img1.doubanio.com/a.jpg')).toBe(
      'https://img1.doubanio.com/a.jpg',
    )
  })

  it('dbCardImg 在非桌面环境保持原 URL(仅替换尺寸路径)', () => {
    const raw = 'https://img1.doubanio.com/view/photo/s_ratio_poster/a.jpg'
    expect(dbCardImg(raw)).toBe('https://img1.doubanio.com/view/photo/m_ratio_poster/a.jpg')
  })
})

describe('suggestToTitle', () => {
  it('不再把 sub_title 写入 originalName', () => {
    const title = suggestToTitle({
      id: '1',
      title: '流浪地球',
      subTitle: '科幻/灾难',
      img: '',
      year: '2019',
      episode: '',
      kind: 'movie',
      url: '',
    })
    expect(title.originalName).toBeUndefined()
    expect(title.name).toBe('流浪地球')
    expect(title.year).toBe(2019)
    expect(title.mediaType).toBe('film')
  })
})

describe('exploreRequests', () => {
  it('电视剧“综艺”形式会带上综艺 tag', () => {
    expect(
      exploreRequests('tv', { ...FILTER_DEFAULTS.tv, form: 'variety', genre: '喜剧' }),
    ).toEqual([{ endpoint: 'tv', tags: ['综艺', '喜剧'] }])
  })

  it('电影页忽略不适用的 form', () => {
    expect(
      exploreRequests('movies', { ...FILTER_DEFAULTS.movies, form: 'series', genre: '科幻' }),
    ).toEqual([{ endpoint: 'movie', tags: ['科幻'] }])
  })
})

describe('placeholderEpisodes', () => {
  it('生成稳定 id 并限制最多 200 集', () => {
    const episodes = placeholderEpisodes('db-1', 250, '50m')
    expect(episodes).toHaveLength(200)
    expect(episodes[0]).toMatchObject({ id: 'db-1-s1e1', number: 1, runtime: '50m' })
    expect(episodes[199].id).toBe('db-1-s1e200')
  })
})

const makeSeries = (overrides: Partial<Title> = {}): Title => ({
  id: 'db-1',
  name: '示例剧',
  mediaType: 'series',
  year: 0,
  ageRating: '',
  match: 0,
  genres: [],
  synopsis: '',
  poster: '',
  titleStyle: 'condensed',
  titleLines: ['示例剧'],
  language: '中文',
  creator: '',
  cast: [],
  addedOrder: 0,
  episodesCount: 24,
  ...overrides,
})

describe('episodesOf', () => {
  it('只在需要时展开占位剧集，并复用同一数组', () => {
    const title = makeSeries()
    expect(title.episodes).toBeUndefined()
    const episodes = episodesOf(title)
    expect(episodes).toHaveLength(24)
    expect(episodes[0].id).toBe('db-1-s1e1')
    expect(title.episodes).toBeUndefined()
    expect(episodesOf(title)).toBe(episodes)
  })

  it('已有真实剧集时原样返回；电影返回空数组', () => {
    const real = [
      { id: 'db-1-s1e1', season: 1, number: 1, name: '真实第1集', runtime: '45m', synopsis: '' },
    ]
    const title = makeSeries({ episodes: real })
    expect(episodesOf(title)).toBe(real)
    expect(episodesOf(makeSeries({ mediaType: 'film', episodesCount: 10 }))).toHaveLength(0)
  })
})

describe('filters', () => {
  it('sanitizeFilters 拒绝未知 form 并回退默认', () => {
    const config = {
      forms: [
        { value: 'all', labelKey: 'filter.all' as const },
        { value: 'series', labelKey: 'media.series' as const },
      ],
      genres: [],
      regions: [],
      years: [],
      sorts: [],
      defaults: FILTER_DEFAULTS.tv,
    }
    expect(sanitizeFilters(config, { ...FILTER_DEFAULTS.tv, form: 'movie' }).form).toBe('all')
    expect(sanitizeFilters(config, { ...FILTER_DEFAULTS.tv, form: 'series' }).form).toBe('series')
  })

  it('isFilterActive 检测任一字段偏离默认', () => {
    const base = FILTER_DEFAULTS.movies
    expect(isFilterActive('movies', base)).toBe(false)
    expect(isFilterActive('movies', { ...base, genre: '喜剧' })).toBe(true)
    expect(isFilterActive('movies', { ...base, minRating: 8 })).toBe(true)
    expect(isFilterActive('recent', base)).toBe(false)
  })

  it('英文界面翻译筛选项，中文保持原值', () => {
    expect(filterLabel('喜剧', 'en')).toBe('Comedy')
    expect(filterLabel('中国香港', 'en')).toBe('Hong Kong')
    expect(filterLabel('90年代', 'en')).toBe("'90s")
    expect(filterLabel('喜剧', 'zh')).toBe('喜剧')
  })
})

describe('languages', () => {
  it('语言列表包含 All', () => {
    expect(languages[0]).toBe('All')
  })
})

describe('isPortraitImage', () => {
  const fakeImage = (width: number, height: number) =>
    ({ naturalWidth: width, naturalHeight: height }) as unknown as HTMLImageElement

  it('高宽比 >1.1 判为竖版', () => {
    expect(isPortraitImage(fakeImage(300, 450))).toBe(true)
    expect(isPortraitImage(fakeImage(1600, 900))).toBe(false)
    expect(isPortraitImage(fakeImage(0, 500))).toBe(false)
  })
})
describe('isProgressFinished', () => {
  it('片尾 5 秒内才算看完', () => {
    expect(isProgressFinished(5396, 5400)).toBe(true)
    expect(isProgressFinished(5400, 5400)).toBe(true)
    expect(isProgressFinished(5394, 5400)).toBe(false)
    expect(isProgressFinished(120, 0)).toBe(false)
    expect(isProgressFinished(0, 0)).toBe(false)
  })
})