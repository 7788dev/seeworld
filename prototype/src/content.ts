import type { Episode, Title } from './data'
import type { Language } from './i18n'
import { parseRuntime } from './lib'

const languageZh: Record<string, string> = {
  English: '英语',
  French: '法语',
  Korean: '韩语',
  Spanish: '西班牙语',
}

export const titleName = (title: Title, language: Language) =>
  language === 'zh' ? title.name : (title.originalName ?? title.name)

export const titleSynopsis = (title: Title, _language: Language) => title.synopsis

export const titleGenres = (title: Title, _language: Language) => title.genres

export const titleLanguageName = (title: Title, language: Language) =>
  language === 'zh' ? (languageZh[title.language] ?? title.language) : title.language

export const mediaLabel = (mediaType: Title['mediaType'], language: Language) =>
  mediaType === 'series'
    ? language === 'zh'
      ? '剧集'
      : 'SERIES'
    : language === 'zh'
      ? '电影'
      : 'FILM'

export const seasonsLabel = (title: Title, language: Language) => {
  const count = title.seasons ?? 0
  if (language === 'zh') return `${count} 季`
  return `${count} ${count === 1 ? 'Season' : 'Seasons'}`
}

export const formatRuntimeLabel = (value: string | undefined, language: Language) => {
  if (!value) return ''
  if (language !== 'zh') return value
  const seconds = parseRuntime(value)
  if (!seconds) return value
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.round((seconds % 3600) / 60)
  if (hours > 0 && minutes > 0) return `${hours} 小时 ${minutes} 分`
  if (hours > 0) return `${hours} 小时`
  return `${minutes} 分钟`
}

export const episodeName = (episode: Episode, _language: Language) => episode.name

export const episodeSynopsis = (episode: Episode, _language: Language) => episode.synopsis

export const formatEpisodeLabel = (
  season: number,
  number: number,
  name: string,
  language: Language,
) =>
  language === 'zh'
    ? `第 ${season} 季 第 ${number} 集 · ${name}`
    : `S${season} E${number} · ${name}`

export const parseEpisodeLabel = (label?: string) => {
  const match = /S(\d+)\s*E(\d+)/i.exec(label ?? '')
  return match ? { season: Number(match[1]), number: Number(match[2]) } : null
}

export const episodeFromLabel = (title: Title) => {
  const parsed = parseEpisodeLabel(title.episodeLabel)
  if (!parsed) return undefined
  return title.episodes?.find(
    (episode) => episode.season === parsed.season && episode.number === parsed.number,
  )
}

export const initialEpisodeFor = (title: Title) =>
  episodeFromLabel(title) ?? title.episodes?.[0]

export const titleEpisodeLabel = (title: Title, language: Language) => {
  const episode = episodeFromLabel(title)
  if (!episode) return undefined
  return formatEpisodeLabel(
    episode.season,
    episode.number,
    episodeName(episode, language),
    language,
  )
}
