import { invoke } from '@tauri-apps/api/core'
import type { Title } from './data'
import { isDesktopApp } from './lib'

export type PlayFormat = 'hls' | 'mp4' | 'unknown'

export type PlayLineFormat = PlayFormat | 'page'

export interface PlaySourceInfo {
  key: string
  name: string
  priority: number
  enabled: boolean
}

export interface PlaySourceError {
  sourceKey: string
  message: string
}

export interface PlaySearchItem {
  sourceKey: string
  vodId: string
  name: string
  pic: string
  year: string
  typeName: string
  remarks: string
  actor: string
  director: string
  area: string
  lang: string
  lineNames: string[]
}

export interface PlaySearchResponse {
  items: PlaySearchItem[]
  errors: PlaySourceError[]
}

export interface PlayEpisode {
  index: number
  name: string
  url: string
  // hls / mp4 / unknown (unknown is usually a share page and must not autoplay).
  format?: PlayFormat
}

export interface PlayLine {
  index: number
  name: string
  episodes: PlayEpisode[]
  // Rust annotates every line; absent means an older backend, treated as playable.
  format?: PlayLineFormat
}

export interface PlayDetail {
  sourceKey: string
  vodId: string
  name: string
  year: string
  typeName: string
  remarks: string
  content: string
  lines: PlayLine[]
}

export interface PlayProbeLine {
  lineIndex: number
  name: string
  format: PlayLineFormat
  ok: boolean
  error?: string | null
  ttfbMs: number
  speedKbps: number
  width: number
  height: number
  bandwidthKbps: number
  score: number
  recommended: boolean
  stabilityScore?: number
  jitterMs?: number
  segmentCount?: number
  durationSec?: number
  endlist?: boolean
}

export interface PlayProbeResult {
  sourceKey: string
  vodId: string
  lines: PlayProbeLine[]
  recommendedLineIndex?: number | null
  cached: boolean
  probedAtMs: number
}

export interface PlayTarget {
  sourceKey: string
  vodId: string
  lineIndex: number
  episodeIndex: number
  url: string
  proxyUrl: string
  format: PlayFormat
  // Source config `alwaysProxy`: start on jjstream instead of the direct URL.
  useProxy?: boolean
}

export type PlayErrorCode = 'no-source' | 'load-failed' | 'unsupported' | 'proxy-failed'

export interface PlayErrorInfo {
  code: PlayErrorCode
  detail?: string
}

export class PlayRequestError extends Error {
  readonly code: PlayErrorCode
  readonly detail?: string

  constructor(code: PlayErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'PlayRequestError'
    this.code = code
    this.detail = detail
  }
}

export const errorInfoOf = (error: unknown): PlayErrorInfo => {
  if (error instanceof PlayRequestError) {
    return { code: error.code, detail: error.detail ?? error.message }
  }
  const detail =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : undefined
  return { code: 'load-failed', detail }
}

const messageOf = (error: unknown) =>
  typeof error === 'string' ? error : error instanceof Error ? error.message : String(error ?? '')

const formatOf = (url: string): PlayFormat => {
  const path = url.split('?')[0].toLowerCase()
  if (path.endsWith('.m3u8')) return 'hls'
  if (path.endsWith('.mp4')) return 'mp4'
  return 'unknown'
}

const invokePlay = async <T,>(command: string, args: Record<string, unknown>): Promise<T> => {
  if (!isDesktopApp) {
    throw new PlayRequestError('no-source', '播放源仅在桌面客户端可用', command)
  }
  try {
    console.info(`[jj] play ${command}`, args)
    const result = await invoke<T>(command, args)
    console.info(`[jj] play ${command} ok`)
    return result
  } catch (error) {
    console.warn(`[jj] play ${command} failed`, error)
    throw new PlayRequestError('load-failed', messageOf(error), command)
  }
}

export const playSources = () => invokePlay<PlaySourceInfo[]>('play_sources', {})

export const playSearch = (query: string, sourceKey?: string) =>
  invokePlay<PlaySearchResponse>('play_search', sourceKey ? { query, sourceKey } : { query })

export const playDetail = (sourceKey: string, vodId: string) =>
  invokePlay<PlayDetail>('play_detail', { sourceKey, vodId })

export const playProbe = (sourceKey: string, vodId: string) =>
  invokePlay<PlayProbeResult>('play_probe', { sourceKey, vodId })

export const playResolve = async (
  sourceKey: string,
  vodId: string,
  lineIndex: number | null | undefined,
  episodeIndex: number,
): Promise<PlayTarget> => {
  const args: Record<string, unknown> = { sourceKey, vodId, episodeIndex }
  if (typeof lineIndex === 'number' && Number.isFinite(lineIndex)) {
    args.lineIndex = lineIndex
  }
  const target = await invokePlay<PlayTarget>('play_resolve', args)
  return {
    ...target,
    proxyUrl: target.proxyUrl || target.url,
    format: target.format ?? formatOf(target.url),
  }
}

/* ------------------------------ match cache ------------------------------ */

export interface PlayMatch {
  sourceKey: string
  vodId: string
  lineIndex: number
  matchedName: string
  updatedAt: number
}

const MATCH_KEY = 'jj-play-match'
const MATCH_TTL = 24 * 60 * 60 * 1000
const MAX_MATCH_ENTRIES = 512
/// 单次网络步骤（搜索/详情/解析）上限。避免一个慢源把整次播放拖到分钟级。
export const RESOLVE_STEP_TIMEOUT_MS = 8_000
/// 一次播放解析的总预算（含所有候选）。到点直接进入换源/错误态。
export const RESOLVE_TOTAL_BUDGET_MS = 16_000

export const withTimeout = <T,>(promise: Promise<T>, ms: number, label: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    if (!(ms > 0)) {
      reject(new PlayRequestError('load-failed', label))
      return
    }
    const timer = globalThis.setTimeout(() => {
      reject(new PlayRequestError('load-failed', label))
    }, ms)
    promise.then(
      (value) => {
        globalThis.clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        globalThis.clearTimeout(timer)
        reject(error)
      },
    )
  })

const isPlayMatch = (value: unknown): value is PlayMatch => {
  if (!value || typeof value !== 'object') return false
  const match = value as Partial<PlayMatch>
  return (
    typeof match.sourceKey === 'string' &&
    match.sourceKey.length > 0 &&
    typeof match.vodId === 'string' &&
    match.vodId.length > 0 &&
    typeof match.matchedName === 'string' &&
    typeof match.updatedAt === 'number' &&
    Number.isFinite(match.updatedAt)
  )
}

/// 会话内内存镜像：readMatch 在播放/详情/探测里会被调用多次，
/// 每次重新解析 512 条 localStorage 是纯浪费。
let matchCache: Record<string, PlayMatch> | null = null

const readMatches = (): Record<string, PlayMatch> => {
  if (matchCache) return matchCache
  try {
    const stored = localStorage.getItem(MATCH_KEY)
    if (!stored) {
      matchCache = {}
      return matchCache
    }
    const parsed: unknown = JSON.parse(stored)
    if (!parsed || typeof parsed !== 'object') {
      matchCache = {}
      return matchCache
    }
    matchCache = Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, PlayMatch] =>
        isPlayMatch(entry[1]),
      ),
    )
    return matchCache
  } catch {
    matchCache = {}
    return matchCache
  }
}

// ps- 条目的 id 自带来源信息：sourceKey 内的 '-' 被转义为 '~'，首个 '-' 是分隔符。
export const sourceFromTitleId = (
  titleId: string,
): { sourceKey: string; vodId: string } | null => {
  if (!titleId.startsWith('ps-')) return null
  const rest = titleId.slice(3)
  const separator = rest.indexOf('-')
  if (separator <= 0) return null
  const sourceKey = rest.slice(0, separator).replace(/~/g, '-')
  const vodId = rest.slice(separator + 1)
  return sourceKey && vodId ? { sourceKey, vodId } : null
}

export const readMatch = (titleId: string): PlayMatch | null => {
  const match = readMatches()[titleId]
  if (!match) return null
  if (Date.now() - match.updatedAt > MATCH_TTL) return null
  return match
}

export const writeMatch = (titleId: string, match: Omit<PlayMatch, 'updatedAt'>) => {
  const matches: Record<string, PlayMatch> = {
    ...readMatches(),
    [titleId]: { ...match, updatedAt: Date.now() },
  }
  const now = Date.now()
  const entries = Object.entries(matches)
    .filter(([, entry]) => now - entry.updatedAt <= MATCH_TTL)
    .sort((left, right) => left[1].updatedAt - right[1].updatedAt)
  if (entries.length > MAX_MATCH_ENTRIES) {
    entries.splice(0, entries.length - MAX_MATCH_ENTRIES)
  }
  matchCache = Object.fromEntries(entries)
  try {
    localStorage.setItem(MATCH_KEY, JSON.stringify(matchCache))
  } catch {
    // match cache is an optimization only
  }
}

export const clearMatch = (titleId: string) => {
  const matches: Record<string, PlayMatch> = { ...readMatches() }
  delete matches[titleId]
  matchCache = matches
  try {
    localStorage.setItem(MATCH_KEY, JSON.stringify(matchCache))
  } catch {
    // ignore
  }
}

/* ------------------------------- matching -------------------------------- */

const EDITION_MARKERS =
  /(?:国语|粤语|英语|双语|中字|中英字幕|中文字幕|字幕|高清|超清|蓝光|blu-?ray|web-?dl|hdr|4k|2160p|1080p|720p|加长版|完整版|未删减|导演剪辑版|特别版|修复版|重制版|重映版|remastered|extended|uncut|director'?s?\s*cut)/gi

// 解说/预告/花絮等二创与片段不是正片，自动匹配必须拒绝。
const VARIANT_MARKERS =
  /(?:解说|预告|花絮|片段|特辑|彩蛋|混剪|盘点|速看|影评|合集|reaction|trailer|teaser|behind[\s-]*the[\s-]*scenes)/i
const SEASON_EPISODE_MARKERS =
  /(?:第[一二三四五六七八九十百0-9]+[季部集期]|season\s*\d+|s\d{1,2}(?:e\d{1,3})?|episode\s*\d+)/i
const SPINOFF_MARKERS = /(?:外传|前传|后传|番外|剧场版|特别篇|衍生|之|篇)/
const SERIES_TYPE_MARKERS =
  /(?:电视剧|连续剧|短剧|网剧|美剧|韩剧|日剧|泰剧|港剧|台剧|国产剧|欧美剧|日韩剧|海外剧|剧集|动漫|动画|番剧|综艺|纪录片|记录片)/

export const sourceTypeIsSeries = (typeName?: string) =>
  Boolean(typeName && SERIES_TYPE_MARKERS.test(typeName))

const stripDecorations = (raw: string) =>
  raw
    .replace(/[（(\[]\s*(?:19|20)\d{2}\s*[)）\]]/g, ' ')
    .replace(EDITION_MARKERS, ' ')

const normalizeName = (raw: string) =>
  stripDecorations(raw)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s·•・:：!！?？'"“”‘’.,，。、~～\-—_()（）[\]【】]/g, '')

const containmentExtra = (name: string, candidate: string) => {
  if (name === candidate) return ''
  if (name.includes(candidate)) return name.replace(candidate, '')
  if (candidate.includes(name)) return candidate.replace(name, '')
  return null
}

const isSafeContainment = (
  titleName: string,
  candidateName: string,
  normalizedTitle: string,
  normalizedCandidate: string,
) => {
  const extra = containmentExtra(normalizedTitle, normalizedCandidate)
  if (extra === null) return false
  if (!extra) return true
  if (Math.min(normalizedTitle.length, normalizedCandidate.length) < 2) return false
  // 解说/预告与季集标记必须双方同时存在，避免把二创、续集或不同季当成正片。
  if (
    VARIANT_MARKERS.test(titleName) !== VARIANT_MARKERS.test(candidateName) ||
    SEASON_EPISODE_MARKERS.test(titleName) !== SEASON_EPISODE_MARKERS.test(candidateName)
  ) {
    return false
  }
  // 包含匹配只接受很小的中文版本后缀；数字、英文副标题、外传/番外一律拒绝。
  if (/\d/.test(extra) || /[a-z]/i.test(extra)) return false
  if (SPINOFF_MARKERS.test(extra)) return false
  return extra.length <= 3
}

/// 播放源标题是否与片库标题对得上(用于校验 match 缓存,防止把《黑球》当成《尼古喵喵》)。
/// 包含匹配要求较短一方至少 2 个字符，且拒绝解说、预告、续集、外传等变体。
export function matchTitleName(title: Title, candidateName: string | undefined): boolean {
  if (!candidateName) return false
  const target = normalizeName(candidateName)
  if (!target) return false
  return [title.name, title.originalName]
    .filter((name): name is string => Boolean(name))
    .some((name) => {
      const normalized = normalizeName(name)
      if (!normalized) return false
      if (normalized === target) return true
      return isSafeContainment(name, candidateName, normalized, target)
    })
}

export function rankCandidates(title: Title, items: PlaySearchItem[]): PlaySearchItem[] {
  const names = [title.name, title.originalName]
    .filter((name): name is string => Boolean(name))
    .map(normalizeName)
  const year = title.year
  const yearKnown = year > 0
  const scored = items.map((item) => {
    const itemName = normalizeName(item.name)
    const exact = Boolean(itemName) && names.includes(itemName)
    // 搜索接口是模糊匹配，名称对不上的结果（同名电影、动画、解说等）宁可判为无源。
    // 年份未知（豆瓣列表接口 year=0）时只接受全名匹配：此时无法用年份区分同名翻拍，
    // 再允许“包含匹配”会把《流浪地球》匹配到《流浪地球：飞跃地球》这类不同作品。
    if (!exact && (!yearKnown || !matchTitleName(title, item.name))) {
      return { item, score: Number.NEGATIVE_INFINITY, nameScore: 0 }
    }
    const nameScore = exact ? 100 : 60
    let score = nameScore
    const itemYear = Number.parseInt(item.year, 10)
    if (year > 0 && Number.isFinite(itemYear)) {
      const gap = Math.abs(itemYear - year)
      if (gap === 0) score += 30
      else if (gap === 1) score += 10
      else if (gap > 2) score -= 15
    }
    const wantsSeries = title.mediaType === 'series'
    if (wantsSeries === sourceTypeIsSeries(item.typeName)) score += 10
    return { item, score, nameScore }
  })
  return scored
    .filter((entry) => Number.isFinite(entry.score) && entry.nameScore > 0)
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.item)
}

export const isPlayableLine = (line: PlayLine) =>
  line.episodes.length > 0 &&
  (line.format === undefined || line.format === 'hls' || line.format === 'mp4')

export const isPlayableEpisode = (episode: PlayEpisode) =>
  episode.format === undefined || episode.format === 'hls' || episode.format === 'mp4'

export const playableEpisodeIndex = (line: PlayLine, desired: number): number | null => {
  if (line.episodes.length === 0) return null
  const target = Math.max(0, Math.min(desired, line.episodes.length - 1))
  if (isPlayableEpisode(line.episodes[target])) return target
  for (let offset = 1; offset < line.episodes.length; offset += 1) {
    const forward = target + offset
    if (forward < line.episodes.length && isPlayableEpisode(line.episodes[forward])) {
      return forward
    }
    const backward = target - offset
    if (backward >= 0 && isPlayableEpisode(line.episodes[backward])) return backward
  }
  return null
}

export const nextPlayableEpisodeIndex = (line: PlayLine, from: number): number | null => {
  for (let index = Math.max(0, from); index < line.episodes.length; index += 1) {
    if (isPlayableEpisode(line.episodes[index])) return index
  }
  return null
}

export const playableLines = (detail: PlayDetail) =>
  detail.lines.filter((line) => isPlayableLine(line))

export const nextPlayableLineIndex = (detail: PlayDetail, current: number) => {
  const indexes = detail.lines
    .map((line, index) => (isPlayableLine(line) ? index : -1))
    .filter((index) => index >= 0)
  if (indexes.length === 0) return current
  return indexes.find((index) => index > current) ?? indexes[0]
}

/* ----------------------------- episode mapping ---------------------------- */

export const episodeNumberOf = (title: Title, episodeId?: string): number | undefined => {
  if (!episodeId) return undefined
  const direct = title.episodes?.find((episode) => episode.id === episodeId)
  if (direct) return direct.number
  const match = /-s\d+e(\d+)$/i.exec(episodeId)
  return match ? Number(match[1]) : undefined
}

/**
 * 为源线路的第 index 集生成稳定 episodeId。
 *
 * 源站集数常多于豆瓣（豆瓣标 24 集、源给 40 集）。此时片库里查不到第 25 集的 id，
 * 若调用方回退成"当前集 id"，第 30 集的进度会覆盖第 5 集，续看直接跳错集。
 * 因此超出片库范围时按 `-s1eN` 规则生成——`episodeNumberOf` 能反解出集号，
 * 与 `placeholderEpisodes` / DetailModal 的 id 规则保持一致。
 */
export const episodeIdForIndex = (title: Title, index: number): string | undefined => {
  if (!Number.isFinite(index) || index < 0) return undefined
  const existing = title.episodes?.find((episode) => episode.number === index + 1)?.id
  if (existing) return existing
  return title.mediaType === 'series' ? `${title.id}-s1e${index + 1}` : undefined
}

/* ---------------------------- aggregate lines ----------------------------- */

/** 线路面板的聚合条目:跨全部候选源的线路平铺,附带集数供用户分辨"全集源/单集源"。 */
export interface AggregateLine {
  sourceKey: string
  vodId: string
  sourceName: string
  lineIndex: number
  lineName: string
  format: string
  episodeCount: number
  playable: boolean
  /** 源在候选排名里的位次(用于稳定排序,展示不需要) */
  rank: number
  detail: PlayDetail
}

export function mergeSourceLines(
  sourceDetails: { detail: PlayDetail; sourceName: string; rank: number }[],
): AggregateLine[] {
  const merged: AggregateLine[] = []
  for (const { detail, sourceName, rank } of sourceDetails) {
    detail.lines.forEach((line, lineIndex) => {
      merged.push({
        sourceKey: detail.sourceKey,
        vodId: detail.vodId,
        sourceName,
        lineIndex,
        lineName: line.name,
        format: line.format ?? 'unknown',
        episodeCount: line.episodes.length,
        playable: isPlayableLine(line),
        rank,
        detail,
      })
    })
  }
  // 可播优先;同为可播时集数多的线路在前(如哆啦A梦:全集源应排在只匹配到第 1 集的源之前)。
  return merged.sort(
    (left, right) =>
      Number(right.playable) - Number(left.playable) ||
      right.episodeCount - left.episodeCount ||
      left.rank - right.rank ||
      left.lineIndex - right.lineIndex,
  )
}

export async function aggregateSourceLines(
  title: Title,
  options: {
    excludeSourceKeys?: string[]
    maxSources?: number
    sourceNames?: Record<string, string>
    /// 已经解析出的详情（当前正在播放的源）：直接纳入聚合，避免再搜一遍、再拉一遍详情。
    seedDetails?: PlayDetail[]
  } = {},
): Promise<{ lines: AggregateLine[]; sourceErrors: string[] }> {
  const excluded = new Set(options.excludeSourceKeys ?? [])
  const queries = Array.from(
    new Set(
      [title.name?.trim(), title.originalName?.trim()].filter(
        (query): query is string => Boolean(query),
      ),
    ),
  )
  const seedDetails = options.seedDetails ?? []
  const sourceDetails: { detail: PlayDetail; sourceName: string; rank: number }[] = seedDetails.map(
    (detail) => ({
      detail,
      sourceName: options.sourceNames?.[detail.sourceKey] ?? detail.sourceKey,
      rank: -1,
    }),
  )
  const seedKeys = new Set(seedDetails.map((detail) => `${detail.sourceKey}|${detail.vodId}`))
  if (queries.length === 0) {
    return {
      lines: mergeSourceLines(sourceDetails),
      sourceErrors: [],
    }
  }
  const sourceErrors: string[] = []
  const seenCandidates = new Set<string>()
  let candidates: PlaySearchItem[] = []
  let ranked: PlaySearchItem[] = []
  for (const query of queries) {
    try {
      const response = await playSearch(query)
      for (const sourceError of response.errors ?? []) {
        sourceErrors.push(`${sourceError.sourceKey}: ${sourceError.message}`)
      }
      for (const item of response.items ?? []) {
        if (excluded.has(item.sourceKey)) continue
        const key = `${item.sourceKey}|${item.vodId}`
        if (seenCandidates.has(key)) continue
        seenCandidates.add(key)
        candidates.push(item)
      }
      ranked = rankCandidates(title, candidates)
      if (ranked.length > 0) break
    } catch (error) {
      sourceErrors.push(`${query}: ${messageOf(error)}`)
    }
  }
  if (ranked.length === 0) {
    return { lines: mergeSourceLines(sourceDetails), sourceErrors }
  }
  // 先按源取最佳候选，再截断；否则前 N 条可能全被同一个源占满。
  const bySource = new Map<string, PlaySearchItem>()
  for (const item of ranked) {
    if (!bySource.has(item.sourceKey)) bySource.set(item.sourceKey, item)
  }
  const picks = [...bySource.entries()]
    .filter(([sourceKey, item]) => !seedKeys.has(`${sourceKey}|${item.vodId}`))
    .slice(0, options.maxSources ?? 6)
  const settled = await Promise.allSettled(
    picks.map(async ([sourceKey, item], index) => {
      const detail = await playDetail(sourceKey, item.vodId)
      return {
        detail,
        sourceName: options.sourceNames?.[sourceKey] ?? sourceKey,
        rank: index,
      }
    }),
  )
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      sourceDetails.push(result.value)
    } else {
      sourceErrors.push(`${picks[index][0]}: ${messageOf(result.reason)}`)
    }
  })
  return { lines: mergeSourceLines(sourceDetails), sourceErrors }
}

/* ------------------------------- resolving -------------------------------- */

export interface ResolveSessionOptions {
  episodeIndex?: number
  preferredLine?: number
  preferredSourceKey?: string
  excludeSourceKey?: string
  excludeSourceKeys?: string[]
  maxCandidates?: number
  /// 已拿到的详情（换线/换集/重试）优先直接使用，避免重复搜索。
  detail?: PlayDetail
  onSourceFailure?: (sourceKey: string, error: unknown) => void
  /// 单次网络步骤/整次解析预算；默认见 RESOLVE_* 常量。
  stepTimeoutMs?: number
  totalBudgetMs?: number
}

export interface ResolvedSession {
  detail: PlayDetail
  lineIndex: number
  episodeIndex: number
  clamped: boolean
  target: PlayTarget
  sourceErrors: PlaySourceError[]
}

const resolveFromDetail = async (
  detail: PlayDetail,
  options: ResolveSessionOptions,
): Promise<Pick<ResolvedSession, 'lineIndex' | 'episodeIndex' | 'clamped' | 'target'>> => {
  const desired = Math.max(0, options.episodeIndex ?? 0)
  // probe 的 recommendedLineIndex 可能来自源站原始顺序(网页线路在前),
  // 而 detail.lines 已把可播放线路排到前面;这里必须重新校验,否则会选中网页线路。
  const preferred =
    typeof options.preferredLine === 'number' &&
    detail.lines[options.preferredLine] &&
    isPlayableLine(detail.lines[options.preferredLine])
      ? options.preferredLine
      : null
  const line = preferred !== null ? detail.lines[preferred] : playableLines(detail)[0]
  const episodeIndex = line ? playableEpisodeIndex(line, desired) ?? desired : desired
  const stepTimeout = Math.max(500, options.stepTimeoutMs ?? RESOLVE_STEP_TIMEOUT_MS)
  const target = await withTimeout(
    playResolve(detail.sourceKey, detail.vodId, preferred, episodeIndex),
    stepTimeout,
    `解析线路「${line?.name ?? '未知'}」超时`,
  )
  return {
    lineIndex: target.lineIndex,
    episodeIndex: target.episodeIndex,
    clamped: target.episodeIndex !== desired,
    target,
  }
}

export async function resolveSession(
  title: Title,
  options: ResolveSessionOptions = {},
): Promise<ResolvedSession> {
  const excluded = new Set(options.excludeSourceKeys ?? [])
  if (options.excludeSourceKey) excluded.add(options.excludeSourceKey)
  const encodedSource = sourceFromTitleId(title.id)
  const storedMatch = readMatch(title.id)
  if (storedMatch && !matchTitleName(title, storedMatch.matchedName)) {
    console.info(
      '[jj] stale play match dropped',
      title.name,
      storedMatch.sourceKey,
      storedMatch.matchedName,
    )
    clearMatch(title.id)
  }
  // ps- 条目的 id 自带来源信息，不依赖搜索阶段写入 match 缓存。
  const validStoredMatch =
    storedMatch && matchTitleName(title, storedMatch.matchedName) ? storedMatch : null
  const cache: PlayMatch | null =
    validStoredMatch ??
    (encodedSource
      ? {
          ...encodedSource,
          lineIndex: 0,
          matchedName: title.name,
          updatedAt: Date.now(),
        }
      : null)
  const sourceErrors: PlaySourceError[] = []
  const failures: string[] = []
  const totalBudget = Math.max(1_000, options.totalBudgetMs ?? RESOLVE_TOTAL_BUDGET_MS)
  const stepLimit = Math.max(500, options.stepTimeoutMs ?? RESOLVE_STEP_TIMEOUT_MS)
  const startedAt = Date.now()
  const remaining = () => totalBudget - (Date.now() - startedAt)
  const timeoutFor = () => Math.max(0, Math.min(stepLimit, remaining()))
  let budgetExhausted = false
  const checkBudget = () => {
    if (remaining() > 0) return true
    budgetExhausted = true
    return false
  }
  const deadlineDetail = () =>
    budgetExhausted ? `解析总时限 ${Math.max(1, Math.round(totalBudget / 1000))}s 已到` : ''

  if (
    checkBudget() &&
    options.detail &&
    !excluded.has(options.detail.sourceKey) &&
    (!options.preferredSourceKey || options.detail.sourceKey === options.preferredSourceKey) &&
    options.detail.lines?.some((line) => isPlayableLine(line))
  ) {
    try {
      const resolved = await resolveFromDetail(options.detail, {
        ...options,
        stepTimeoutMs: timeoutFor(),
      })
      writeMatch(title.id, {
        sourceKey: options.detail.sourceKey,
        vodId: options.detail.vodId,
        lineIndex: resolved.lineIndex,
        matchedName: options.detail.name,
      })
      return { detail: options.detail, ...resolved, sourceErrors: [] }
    } catch (error) {
      failures.push(`${options.detail.sourceKey}: ${messageOf(error)}`)
      options.onSourceFailure?.(options.detail.sourceKey, error)
    }
  }

  const cacheUsable =
    cache &&
    matchTitleName(title, cache.matchedName) &&
    // 用户显式指定源(线路面板跨源切换)时,不得被旧 match 缓存抢走。
    (!options.preferredSourceKey || cache.sourceKey === options.preferredSourceKey)
  if (checkBudget() && cacheUsable && cache && !excluded.has(cache.sourceKey)) {
    try {
      const detail = await withTimeout(
        playDetail(cache.sourceKey, cache.vodId),
        timeoutFor(),
        `加载已匹配源「${cache.sourceKey}」超时`,
      )
      if (detail.lines?.some((line) => isPlayableLine(line))) {
        const resolved = await resolveFromDetail(detail, {
          ...options,
          stepTimeoutMs: timeoutFor(),
        })
        writeMatch(title.id, {
          sourceKey: detail.sourceKey,
          vodId: detail.vodId,
          lineIndex: resolved.lineIndex,
          matchedName: detail.name,
        })
        return { detail, ...resolved, sourceErrors: [] }
      }
    } catch (error) {
      options.onSourceFailure?.(cache.sourceKey, error)
      console.info('[jj] play cached match failed, searching again', messageOf(error))
    }
  }

  const queries = Array.from(
    new Set(
      [title.name?.trim(), title.originalName?.trim()].filter(
        (query): query is string => Boolean(query),
      ),
    ),
  )
  const seenCandidates = new Set<string>()
  let candidates: PlaySearchItem[] = []
  let ranked: PlaySearchItem[] = []

  for (const query of queries) {
    if (!checkBudget()) break
    try {
      const response = await withTimeout(
        playSearch(query),
        timeoutFor(),
        `搜索「${query}」超过解析时限`,
      )
      for (const sourceError of response.errors ?? []) sourceErrors.push(sourceError)
      for (const item of response.items ?? []) {
        if (excluded.has(item.sourceKey)) continue
        const key = `${item.sourceKey}|${item.vodId}`
        if (seenCandidates.has(key)) continue
        seenCandidates.add(key)
        candidates.push(item)
      }
      // 第一种名称的结果可能全是同名烂片/解说；ranking 为空时继续尝试原名。
      const attempt = rankCandidates(title, candidates)
      if (attempt.length > 0) {
        ranked = attempt
        break
      }
    } catch (error) {
      failures.push(`${query}: ${messageOf(error)}`)
    }
  }

  if (ranked.length === 0) {
    const detail = [
      ...failures,
      ...sourceErrors.map((sourceError) => `${sourceError.sourceKey}: ${sourceError.message}`),
      deadlineDetail(),
      candidates.length > 0 ? '搜索结果的标题与片名不符，已拒绝自动匹配' : '',
    ]
      .filter(Boolean)
      .join(' | ')
    throw new PlayRequestError('no-source', '未找到可用的播放源', detail || undefined)
  }

  // 用户从线路面板显式点选的源优先尝试,且不受默认候选数限制挤掉。
  const preferred =
    options.preferredSourceKey
      ? ranked.find((item) => item.sourceKey === options.preferredSourceKey)
      : undefined
  const ordered = preferred ? [preferred, ...ranked.filter((item) => item !== preferred)] : ranked
  const rankedCandidates = ordered.slice(
    0,
    Math.max(options.maxCandidates ?? 3, preferred ? 1 : 0),
  )
  let sawUnsupported = false
  for (const candidate of rankedCandidates) {
    if (!checkBudget()) break
    try {
      const detail = await withTimeout(
        playDetail(candidate.sourceKey, candidate.vodId),
        timeoutFor(),
        `加载「${candidate.sourceKey}」详情超时`,
      )
      if (!detail.lines?.some((line) => isPlayableLine(line))) {
        failures.push(`${candidate.sourceKey}: 没有可用的 HLS/MP4 线路`)
        sawUnsupported = true
        options.onSourceFailure?.(candidate.sourceKey, new PlayRequestError('unsupported', '没有可用的 HLS/MP4 线路'))
        continue
      }
      const resolved = await resolveFromDetail(detail, {
        ...options,
        stepTimeoutMs: timeoutFor(),
      })
      writeMatch(title.id, {
        sourceKey: detail.sourceKey,
        vodId: detail.vodId,
        lineIndex: resolved.lineIndex,
        matchedName: candidate.name,
      })
      return { detail, ...resolved, sourceErrors }
    } catch (error) {
      if (error instanceof PlayRequestError && error.code === 'unsupported') sawUnsupported = true
      options.onSourceFailure?.(candidate.sourceKey, error)
      failures.push(`${candidate.sourceKey}: ${messageOf(error)}`)
    }
  }

  const finalDetail = [...failures, deadlineDetail()].filter(Boolean).join(' | ') || undefined
  if (sawUnsupported) {
    throw new PlayRequestError('unsupported', '所有候选线路格式暂不支持', finalDetail)
  }
  throw new PlayRequestError('no-source', '找到候选但均无法解析播放地址', finalDetail)
}

export const nextLineIndex = (lineCount: number, current: number) =>
  lineCount > 0 ? (current + 1) % lineCount : 0



