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

// Windows WebView2 maps http://jjstream.localhost/<key>/<url> to the jjstream protocol.
export const streamUrl = (sourceKey: string, rawUrl: string) =>
  `http://jjstream.localhost/${sourceKey}/${encodeURIComponent(rawUrl)}`

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
    proxyUrl: target.proxyUrl || streamUrl(sourceKey, target.url),
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

const readMatches = (): Record<string, PlayMatch> => {
  try {
    const stored = localStorage.getItem(MATCH_KEY)
    return stored ? (JSON.parse(stored) as Record<string, PlayMatch>) : {}
  } catch {
    return {}
  }
}

export const readMatch = (titleId: string): PlayMatch | null => {
  const match = readMatches()[titleId]
  if (!match) return null
  if (Date.now() - match.updatedAt > MATCH_TTL) return null
  return match
}

export const writeMatch = (titleId: string, match: Omit<PlayMatch, 'updatedAt'>) => {
  try {
    const matches = readMatches()
    matches[titleId] = { ...match, updatedAt: Date.now() }
    localStorage.setItem(MATCH_KEY, JSON.stringify(matches))
  } catch {
    // match cache is an optimization only
  }
}

export const clearMatch = (titleId: string) => {
  try {
    const matches = readMatches()
    delete matches[titleId]
    localStorage.setItem(MATCH_KEY, JSON.stringify(matches))
  } catch {
    // ignore
  }
}

/* ------------------------------- matching -------------------------------- */

const normalizeName = (raw: string) =>
  raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s·•・:：!！?？'"“”‘’.,，。、~～\-—_()（）[\]【】]/g, '')

const seriesTypePattern = /剧|动漫|动画|综艺|纪录/

/// 播放源标题是否与片库标题对得上(用于校验 match 缓存,防止把《黑球》当成《尼古喵喵》)。
export function matchTitleName(title: Title, candidateName: string | undefined): boolean {
  if (!candidateName) return false
  const target = normalizeName(candidateName)
  if (!target) return false
  return [title.name, title.originalName]
    .filter((name): name is string => Boolean(name))
    .map(normalizeName)
    .some((name) => name === target || name.includes(target) || target.includes(name))
}

export function rankCandidates(title: Title, items: PlaySearchItem[]): PlaySearchItem[] {
  const names = [title.name, title.originalName]
    .filter((name): name is string => Boolean(name))
    .map(normalizeName)
  const year = title.year
  const scored = items.map((item) => {
    const itemName = normalizeName(item.name)
    let nameScore = 0
    for (const name of names) {
      if (!name || !itemName) continue
      if (itemName === name) nameScore = Math.max(nameScore, 100)
      else if (itemName.includes(name) || name.includes(itemName)) nameScore = Math.max(nameScore, 60)
    }
    let score = nameScore
    const itemYear = Number.parseInt(item.year, 10)
    if (year > 0 && Number.isFinite(itemYear)) {
      const gap = Math.abs(itemYear - year)
      if (gap === 0) score += 30
      else if (gap === 1) score += 10
      else if (gap > 2) score -= 15
    }
    const wantsSeries = title.mediaType === 'series'
    if (wantsSeries === seriesTypePattern.test(item.typeName)) score += 10
    return { item, score, nameScore }
  })
  // 搜索接口是模糊匹配,名称对不上的结果(例如把动画匹配成同名年份的电影)
  // 宁可判为无源,也不能播出错误内容。
  const hasNameMatch = scored.some((entry) => entry.nameScore > 0)
  return scored
    .filter((entry) => hasNameMatch && entry.nameScore > 0)
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

export const episodeIdForIndex = (title: Title, index: number): string | undefined =>
  title.episodes?.find((episode) => episode.number === index + 1)?.id

/* ------------------------------- resolving -------------------------------- */

export interface ResolveSessionOptions {
  episodeIndex?: number
  preferredLine?: number
  excludeSourceKey?: string
  excludeSourceKeys?: string[]
  maxCandidates?: number
  onSourceFailure?: (sourceKey: string, error: unknown) => void
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
  const target = await playResolve(
    detail.sourceKey,
    detail.vodId,
    preferred,
    episodeIndex,
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
  const cache = readMatch(title.id)
  if (cache && !matchTitleName(title, cache.matchedName)) {
    console.info('[jj] stale play match dropped', title.name, cache.sourceKey, cache.matchedName)
    clearMatch(title.id)
  }
  if (cache && matchTitleName(title, cache.matchedName) && !excluded.has(cache.sourceKey)) {
    try {
      const detail = await playDetail(cache.sourceKey, cache.vodId)
      if (detail.lines?.some((line) => isPlayableLine(line))) {
        const resolved = await resolveFromDetail(detail, options)
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
    new Set([title.name?.trim(), title.originalName?.trim()].filter((query): query is string => Boolean(query))),
  )
  const failures: string[] = []
  let candidates: PlaySearchItem[] = []
  let sourceErrors: PlaySourceError[] = []

  for (const query of queries) {
    try {
      const response = await playSearch(query)
      sourceErrors = response.errors ?? []
      candidates = (response.items ?? []).filter((item) => !excluded.has(item.sourceKey))
      if (candidates.length > 0) break
    } catch (error) {
      failures.push(`${query}: ${messageOf(error)}`)
    }
  }

  if (candidates.length === 0) {
    const detail = [
      ...failures,
      ...sourceErrors.map((sourceError) => `${sourceError.sourceKey}: ${sourceError.message}`),
    ]
      .filter(Boolean)
      .join(' | ')
    throw new PlayRequestError('no-source', '未找到可用的播放源', detail || undefined)
  }

  const rankedAll = rankCandidates(title, candidates)
  const ranked = rankedAll.slice(0, options.maxCandidates ?? 3)
  if (ranked.length === 0) {
    throw new PlayRequestError(
      'no-source',
      '未找到匹配的播放源',
      '搜索结果的标题与片名不符，已拒绝自动匹配',
    )
  }
  let sawUnsupported = false
  for (const candidate of ranked) {
    try {
      const detail = await playDetail(candidate.sourceKey, candidate.vodId)
      if (!detail.lines?.some((line) => isPlayableLine(line))) {
        failures.push(`${candidate.sourceKey}: 没有可用的 HLS/MP4 线路`)
        sawUnsupported = true
        options.onSourceFailure?.(candidate.sourceKey, new PlayRequestError('unsupported', '没有可用的 HLS/MP4 线路'))
        continue
      }
      const resolved = await resolveFromDetail(detail, options)
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

  if (sawUnsupported) {
    throw new PlayRequestError('unsupported', '所有候选线路格式暂不支持', failures.join(' | ') || undefined)
  }
  throw new PlayRequestError('no-source', '找到候选但均无法解析播放地址', failures.join(' | ') || undefined)
}

export const nextLineIndex = (lineCount: number, current: number) =>
  lineCount > 0 ? (current + 1) % lineCount : 0



