import { describe, expect, it } from 'vitest'
import {
  matchTitleName,
  matchFitsTitle,
  matchesSearchQuery,
  isVariantSearchResult,
  searchVersionKey,
  mergeSearchResults,
  rankCandidates,
  isPlayableLine,
  playableEpisodeIndex,
  nextPlayableEpisodeIndex,
  mergeSourceLines,
  sourceFromTitleId,
  sourceTypeIsSeries,
  detailMatchesTitle,
  episodeIdForIndex,
  episodeNumberOf,
  withTimeout,
} from './play'
import type { PlayDetail, PlayFormat, PlayLine, PlayLineFormat, PlaySearchItem } from './play'
import type { Title } from './data'

const makeDetail = (
  sourceKey: string,
  lines: { name: string; format: PlayLineFormat; episodes: number }[],
): PlayDetail => ({
  sourceKey,
  vodId: `${sourceKey}-1`,
  name: '示例片名',
  year: '2023',
  typeName: '科幻片',
  remarks: '',
  content: '',
  lines: lines.map((line, index): PlayLine => ({
    index,
    name: line.name,
    format: line.format,
    episodes: Array.from({ length: line.episodes }, (_, episodeIndex) => ({
      index: episodeIndex,
      name: `E${episodeIndex + 1}`,
      url: `https://x/${sourceKey}/${episodeIndex}.${line.format === 'hls' ? 'm3u8' : 'mp4'}`,
      format: line.format === 'hls' ? 'hls' : line.format === 'mp4' ? 'mp4' : 'unknown',
    })),
  })),
})

const makeTitle = (overrides: Partial<Title> & { name: string }): Title => ({
  id: 'db-1',
  mediaType: 'film',
  year: 2023,
  ageRating: '',
  match: 0,
  genres: [],
  synopsis: '',
  poster: '',
  titleStyle: 'condensed',
  titleLines: [overrides.name],
  language: '中文',
  creator: '',
  cast: [],
  addedOrder: 0,
  ...overrides,
})

const makeItem = (overrides: Partial<PlaySearchItem> & { name: string }): PlaySearchItem => ({
  sourceKey: 'lzi',
  vodId: '1',
  pic: '',
  year: '2023',
  typeName: '科幻片',
  remarks: '',
  actor: '',
  director: '',
  area: '',
  lang: '',
  lineNames: [],
  ...overrides,
})

describe('matchTitleName', () => {
  it('匹配全等与带版本后缀的名称，拒绝续集', () => {
    const title = makeTitle({ name: '流浪地球' })
    expect(matchTitleName(title, '流浪地球')).toBe(true)
    expect(matchTitleName(title, ' 流浪地球 ')).toBe(true)
    expect(matchTitleName(title, '流浪地球 国语')).toBe(true)
    expect(matchTitleName(title, '流浪地球（2019）')).toBe(true)
    expect(matchTitleName(title, '流浪地球2')).toBe(false)
    expect(matchTitleName(title, '流浪地球2：再次冒险')).toBe(false)
    expect(matchTitleName(title, '流浪地球[电影解说]')).toBe(false)
    expect(matchTitleName(title, '流浪地球 预告片')).toBe(false)
  })

  it('拒绝完全不同的名称', () => {
    const title = makeTitle({ name: '流浪地球' })
    expect(matchTitleName(title, '星际穿越')).toBe(false)
    expect(matchTitleName(title, undefined)).toBe(false)
    expect(matchTitleName(title, '')).toBe(false)
  })

  it('单字名称只允许全等,防止误伤', () => {
    const title = makeTitle({ name: '杀' })
    expect(matchTitleName(title, '杀')).toBe(true)
    expect(matchTitleName(title, '杀破狼')).toBe(false)
  })
})

describe('rankCandidates', () => {
  it('全名命中且年份吻合的候选排第一', () => {
    const title = makeTitle({ name: '流浪地球', year: 2019 })
    const items = [
      makeItem({ name: '流浪地球:飞跃地球', vodId: '2', year: '2023' }),
      makeItem({ name: '流浪地球', vodId: '1', year: '2019' }),
      makeItem({ name: '地球流浪', vodId: '3', year: '2019' }),
    ]
    const ranked = rankCandidates(title, items)
    expect(ranked[0].vodId).toBe('1')
  })

  it('名称完全不匹配的结果被整体拒绝', () => {
    const title = makeTitle({ name: '流浪地球' })
    const items = [makeItem({ name: '疯狂的外星人' })]
    expect(rankCandidates(title, items)).toHaveLength(0)
  })

  it('系列类型不符会降权但不剔除', () => {
    const title = makeTitle({ name: '流浪地球', mediaType: 'series' })
    const items = [
      makeItem({ name: '流浪地球', typeName: '科幻片' }),
      makeItem({ name: '流浪地球', typeName: '国产动漫', vodId: '9' }),
    ]
    const ranked = rankCandidates(title, items)
    expect(ranked).toHaveLength(2)
    expect(ranked[0].vodId).toBe('9')
  })

  it('年份未知（豆瓣列表 year=0）时只接受全名，拒绝包含匹配', () => {
    const title = makeTitle({ name: '流浪地球', year: 0 })
    const ambiguous = [makeItem({ name: '流浪地球 大结局', vodId: 'spin' })]
    expect(rankCandidates(title, ambiguous)).toHaveLength(0)
    const exact = [
      makeItem({ name: '流浪地球', vodId: 'exact' }),
      makeItem({ name: '流浪地球 大结局', vodId: 'spin' }),
    ]
    expect(rankCandidates(title, exact).map((item) => item.vodId)).toEqual(['exact'])
  })
})

describe('withTimeout', () => {
  it('按时完成会返回结果并清理定时器', async () => {
    await expect(withTimeout(Promise.resolve(7), 50, '不应超时')).resolves.toBe(7)
  })

  it('超时会拒绝并携带可读标签', async () => {
    await expect(
      withTimeout(new Promise<never>(() => undefined), 5, '测试超时'),
    ).rejects.toMatchObject({ code: 'load-failed', message: '测试超时' })
  })
})

describe('rankCandidates 二创与变体', () => {
  it('没有正片候选时拒绝解说/预告，不播错内容', () => {
    const title = makeTitle({ name: '流浪地球' })
    const items = [
      makeItem({ name: '流浪地球[电影解说]', vodId: 'a' }),
      makeItem({ name: '流浪地球2[预告片]', vodId: 'b' }),
      makeItem({ name: '流浪地球2', vodId: 'c' }),
    ]
    expect(rankCandidates(title, items)).toHaveLength(0)
  })

  it('带语言/画质后缀的正片仍然匹配', () => {
    const title = makeTitle({ name: '流浪地球' })
    const items = [makeItem({ name: '流浪地球 国语 1080P', vodId: 'a' })]
    expect(rankCandidates(title, items).map((item) => item.vodId)).toEqual(['a'])
  })
})

describe('sourceTypeIsSeries', () => {
  it('喜剧片/纪录片不误判，剧集/动漫/综艺判为剧集', () => {
    expect(sourceTypeIsSeries('喜剧片')).toBe(false)
    expect(sourceTypeIsSeries('动作片')).toBe(false)
    expect(sourceTypeIsSeries('国产剧')).toBe(true)
    expect(sourceTypeIsSeries('国产动漫')).toBe(true)
    expect(sourceTypeIsSeries('大陆综艺')).toBe(true)
  })
})

describe('sourceFromTitleId', () => {
  it('从 ps- id 还原 sourceKey/vodId，且处理 ~ 转义', () => {
    expect(sourceFromTitleId('ps-ffzy-26691')).toEqual({
      sourceKey: 'ffzy',
      vodId: '26691',
    })
    expect(sourceFromTitleId('ps-my~source-a-b-c')).toEqual({
      sourceKey: 'my-source',
      vodId: 'a-b-c',
    })
    expect(sourceFromTitleId('db-123')).toBeNull()
    expect(sourceFromTitleId('ps-bad')).toBeNull()
  })
})

describe('playableEpisodeIndex', () => {
  const line = (formats: PlayFormat[]): PlayLine => ({
    index: 0,
    name: '线路',
    format: 'hls',
    episodes: formats.map((format, index) => ({
      index,
      name: `E${index + 1}`,
      url: `https://x/${index}.${format}`,
      format,
    })),
  })

  it('目标集可播时直接返回', () => {
    expect(playableEpisodeIndex(line(['hls', 'hls', 'hls']), 1)).toBe(1)
  })

  it('目标集不可播时向后再向前就近寻找', () => {
    expect(playableEpisodeIndex(line(['hls', 'unknown', 'hls']), 1)).toBe(2)
    expect(playableEpisodeIndex(line(['hls', 'unknown', 'unknown']), 1)).toBe(0)
  })

  it('全部不可播返回 null', () => {
    expect(playableEpisodeIndex(line(['unknown', 'unknown']), 0)).toBeNull()
  })
})

describe('nextPlayableEpisodeIndex', () => {
  it('从指定位置起找第一个可播集', () => {
    const line: PlayLine = {
      index: 0,
      name: '线路',
      format: 'hls',
      episodes: [
        { index: 0, name: 'a', url: 'https://x/0.mp4', format: 'mp4' },
        { index: 1, name: 'b', url: 'https://x/1', format: 'unknown' },
        { index: 2, name: 'c', url: 'https://x/2.m3u8', format: 'hls' },
      ],
    }
    expect(nextPlayableEpisodeIndex(line, 1)).toBe(2)
    expect(nextPlayableEpisodeIndex(line, 2)).toBe(2)
    expect(nextPlayableEpisodeIndex(line, 3)).toBeNull()
  })
})

describe('isPlayableLine', () => {
  it('page/unknown 线路不可播', () => {
    expect(isPlayableLine({ index: 0, name: 'a', format: 'hls', episodes: [] })).toBe(false)
    expect(
      isPlayableLine({
        index: 0,
        name: 'a',
        format: 'page',
        episodes: [{ index: 0, name: 'e', url: 'https://x', format: 'unknown' }],
      }),
    ).toBe(false)
    expect(
      isPlayableLine({
        index: 0,
        name: 'a',
        format: 'mp4',
        episodes: [{ index: 0, name: 'e', url: 'https://x/a.mp4', format: 'mp4' }],
      }),
    ).toBe(true)
  })
})
describe('mergeSourceLines', () => {
  it('可播线路优先,集数多者排前(全集源先于单集源)', () => {
    const merged = mergeSourceLines([
      { detail: makeDetail('one-ep', [{ name: 'm3u8', format: 'hls', episodes: 1 }]), sourceName: '单集源', rank: 0 },
      { detail: makeDetail('full', [{ name: 'm3u8', format: 'hls', episodes: 30 }]), sourceName: '全集源', rank: 1 },
      { detail: makeDetail('page', [{ name: 'yun', format: 'page', episodes: 12 }]), sourceName: '网页源', rank: 2 },
    ])
    expect(merged[0].sourceKey).toBe('full')
    expect(merged[0].episodeCount).toBe(30)
    expect(merged[1].sourceKey).toBe('one-ep')
    expect(merged.every((line) => line.playable === (line.format === 'hls'))).toBe(true)
  })

  it('同集数按源排名稳定排序,并保留源显示名', () => {
    const merged = mergeSourceLines([
      { detail: makeDetail('b', [{ name: 'm3u8', format: 'hls', episodes: 10 }]), sourceName: 'B源', rank: 1 },
      { detail: makeDetail('a', [{ name: 'm3u8', format: 'hls', episodes: 10 }]), sourceName: 'A源', rank: 0 },
    ])
    expect(merged[0].sourceKey).toBe('a')
    expect(merged[0].sourceName).toBe('A源')
  })
})

describe('episodeIdForIndex', () => {
  const series = (count: number) =>
    makeTitle({
      name: '示例剧',
      mediaType: 'series',
      episodes: Array.from({ length: count }, (_, index) => ({
        id: `db-1-s1e${index + 1}`,
        season: 1,
        number: index + 1,
        name: `第${index + 1}集`,
        runtime: '45m',
        synopsis: '',
      })),
    })

  it('片库内有该集时复用片库 id', () => {
    expect(episodeIdForIndex(series(24), 4)).toBe('db-1-s1e5')
  })

  it('源集数超出片库时生成稳定 id，而不是回退到别的集', () => {
    const title = series(24)
    const id = episodeIdForIndex(title, 29)
    expect(id).toBe('db-1-s1e30')
    // 关键：必须能反解出集号，否则续看会定位到错误的集。
    expect(episodeNumberOf(title, id)).toBe(30)
    expect(episodeNumberOf(title, episodeIdForIndex(title, 39)!)).toBe(40)
  })

  it('电影没有分集 id，非法索引返回 undefined', () => {
    expect(episodeIdForIndex(makeTitle({ name: '电影' }), 0)).toBeUndefined()
    expect(episodeIdForIndex(series(5), -1)).toBeUndefined()
    expect(episodeIdForIndex(series(5), Number.NaN)).toBeUndefined()
  })
})

describe('search relevance helpers', () => {
  it('过滤忽略 wd 的 CMS 目录', () => {
    expect(matchesSearchQuery('三体', '三体')).toBe(true)
    expect(matchesSearchQuery('三体', '三体 2023')).toBe(true)
    expect(matchesSearchQuery('zzz不存在qqq', '追踪再现')).toBe(false)
    expect(matchesSearchQuery('流浪地球', '地球')).toBe(false)
    expect(matchesSearchQuery('杀', '杀破狼')).toBe(false)
    expect(isVariantSearchResult('流浪地球[电影解说]')).toBe(true)
    expect(isVariantSearchResult('流浪地球 预告片')).toBe(true)
    expect(isVariantSearchResult('流浪地球')).toBe(false)
  })

  it('同名不同年份/类型生成不同版本键', () => {
    const series = makeTitle({ name: '三体', year: 2023, mediaType: 'series' })
    const film = makeTitle({ name: '三体', year: 2023, mediaType: 'film' })
    const old = makeTitle({ name: '三体', year: 2022, mediaType: 'series' })
    expect(searchVersionKey(series)).not.toBe(searchVersionKey(film))
    expect(searchVersionKey(series)).not.toBe(searchVersionKey(old))
  })

  it('搜索结果保留同名不同年份，源站只保留一个版本', () => {
    const douban = [
      makeTitle({ id: 'db-1', name: '三体', year: 2023, mediaType: 'series' }),
      makeTitle({ id: 'db-2', name: '三体', year: 2022, mediaType: 'series' }),
    ]
    const source = [
      makeTitle({ id: 'ps-a-1', name: '三体', year: 2023, mediaType: 'series' }),
      makeTitle({ id: 'ps-b-2', name: '三体', year: 2023, mediaType: 'series' }),
      makeTitle({ id: 'ps-c-3', name: '三体', year: 2024, mediaType: 'film' }),
    ]
    const merged = mergeSearchResults(douban, source)
    expect(merged.map((title) => title.id)).toEqual(['db-1', 'db-2', 'ps-c-3'])
  })
})

describe('source type conflict', () => {
  it('动画片/动画电影不再误判为剧集', () => {
    expect(sourceTypeIsSeries('动画片')).toBe(false)
    expect(sourceTypeIsSeries('动画电影')).toBe(false)
    expect(sourceTypeIsSeries('纪录片')).toBe(false)
    expect(sourceTypeIsSeries('国产动漫')).toBe(true)
    expect(sourceTypeIsSeries('动画剧集')).toBe(true)
  })

  it('电影/剧集明确冲突时拒绝候选', () => {
    const film = makeTitle({ name: '三体', year: 2023, mediaType: 'film' })
    const seriesItem = makeItem({ name: '三体', typeName: '国产剧', year: '2023' })
    expect(rankCandidates(film, [seriesItem])).toHaveLength(0)

    const series = makeTitle({ name: '三体', year: 2023, mediaType: 'series' })
    const filmItem = makeItem({ name: '三体', typeName: '电影', year: '2023' })
    expect(rankCandidates(series, [filmItem])).toHaveLength(0)
  })

  it('同名不同年份（差距 >2）直接拒绝', () => {
    const title = makeTitle({ name: '流浪地球', year: 2019 })
    const remake = makeItem({ name: '流浪地球', year: '2024' })
    expect(rankCandidates(title, [remake])).toHaveLength(0)
  })
})

describe('detailMatchesTitle', () => {
  it('名称、年份、类型都对上才接受', () => {
    const title = makeTitle({ name: '示例片名', year: 2023 })
    const detail = makeDetail('lzi', [{ name: '正片', format: 'hls', episodes: 1 }])
    expect(detailMatchesTitle(title, detail)).toBe(true)

    const wrongYear = { ...detail, year: '2030' }
    expect(detailMatchesTitle(title, wrongYear)).toBe(false)

    const wrongName = { ...detail, name: '另一部片' }
    expect(detailMatchesTitle(title, wrongName)).toBe(false)

    const wrongType = { ...detail, typeName: '国产剧' }
    expect(detailMatchesTitle(makeTitle({ name: '示例片名', year: 2023, mediaType: 'film' }), wrongType)).toBe(false)
  })

  it('match 缓存校验年份/类型', () => {
    const title = makeTitle({ name: '示例片名', year: 2023, mediaType: 'series' })
    expect(
      matchFitsTitle(title, {
        sourceKey: 'lzi',
        vodId: '1',
        lineIndex: 0,
        matchedName: '示例片名',
        year: 2023,
        mediaType: 'series',
        updatedAt: Date.now(),
      }),
    ).toBe(true)
    expect(
      matchFitsTitle(title, {
        sourceKey: 'lzi',
        vodId: '1',
        lineIndex: 0,
        matchedName: '示例片名',
        year: 2030,
        mediaType: 'series',
        updatedAt: Date.now(),
      }),
    ).toBe(false)
    expect(
      matchFitsTitle(title, {
        sourceKey: 'lzi',
        vodId: '1',
        lineIndex: 0,
        matchedName: '示例片名',
        year: 2023,
        mediaType: 'film',
        updatedAt: Date.now(),
      }),
    ).toBe(false)
  })
})
