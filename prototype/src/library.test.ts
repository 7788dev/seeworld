import { describe, expect, it } from 'vitest'
import type { Title } from './data'
import { mergeRegisteredTitle } from './library'

const makeTitle = (overrides: Partial<Title> = {}): Title => ({
  id: 'db-1',
  name: '示例剧',
  mediaType: 'series',
  year: 2024,
  ageRating: '',
  match: 80,
  genres: ['剧情'],
  synopsis: '已有简介',
  poster: 'poster.jpg',
  hero: 'hero.jpg',
  titleStyle: 'condensed',
  titleLines: ['示例剧'],
  language: '',
  creator: '导演',
  cast: ['演员'],
  addedOrder: 0,
  episodesCount: 12,
  doubanRating: 8,
  doubanVotes: 100,
  ...overrides,
})

describe('mergeRegisteredTitle', () => {
  it('刷新连载集数与详情评分/票数', () => {
    const merged = mergeRegisteredTitle(
      makeTitle(),
      makeTitle({ episodesCount: 24, doubanRating: 8.5, doubanVotes: 200 }),
    )
    expect(merged?.episodesCount).toBe(24)
    expect(merged?.doubanRating).toBe(8.5)
    expect(merged?.doubanVotes).toBe(200)
  })

  it('没有可改进字段时返回 null，避免无意义写盘', () => {
    expect(mergeRegisteredTitle(makeTitle(), makeTitle())).toBeNull()
  })

  it('稀疏的 feed 数据不覆盖已有详情字段', () => {
    const merged = mergeRegisteredTitle(
      makeTitle(),
      makeTitle({
        synopsis: '',
        cast: [],
        genres: [],
        poster: '',
        hero: '',
        episodesCount: undefined,
        doubanRating: undefined,
        doubanVotes: undefined,
      }),
    )
    expect(merged).toBeNull()
  })

  it('新集数组只替换空数组，不因空数组清空已有真实剧集', () => {
    const episodes = [
      { id: 'db-1-s1e1', season: 1, number: 1, name: '真实第1集', runtime: '45m', synopsis: '' },
    ]
    const merged = mergeRegisteredTitle(
      makeTitle({ episodes }),
      makeTitle({ episodes: [], synopsis: '', originalName: 'New Original' }),
    )
    expect(merged?.episodes).toBe(episodes)
  })
})