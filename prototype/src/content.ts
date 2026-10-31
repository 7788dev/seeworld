import type { Episode, Title } from './data'
import type { Language } from './i18n'
import { parseRuntime } from './lib'

interface ZhTitle {
  name: string
  synopsis: string
  genres: string[]
}

const zhTitles: Record<string, ZhTitle> = {
  stranger: {
    name: '怪奇物语',
    synopsis:
      '一个男孩在小镇离奇失踪，一群孩子由此揭开涉及秘密实验、恐怖力量与一个神秘女孩的谜团。',
    genres: ['科幻', '恐怖', '悬疑'],
  },
  'night-agent': {
    name: '夜间特工',
    synopsis:
      '在白宫地下室值夜班的低级 FBI 探员接到一通电话，被卷入一场直通椭圆形办公室的致命阴谋。',
    genres: ['惊悚', '动作'],
  },
  wednesday: {
    name: '星期三',
    synopsis:
      '聪明、毒舌、内心有点“死亡”的星期三·亚当斯在奈弗莫尔学院调查诡异谜案，也意外收获并守护了几段不太可能的友谊。',
    genres: ['悬疑', '喜剧'],
  },
  'leave-world': {
    name: '断网假期',
    synopsis:
      '长岛的家庭假期被一场网络攻击打断，两家人被迫面对一个可能正在终结的世界。',
    genres: ['剧情', '惊悚'],
  },
  crown: {
    name: '王冠',
    synopsis:
      '跟随伊丽莎白二世统治时期的政治角力与爱情，以及塑造二十世纪后半叶的历史事件。',
    genres: ['剧情', '历史'],
  },
  'rebel-moon': {
    name: '月球叛军',
    synopsis:
      '银河边缘的和平村庄遭到残暴军队威胁，一位神秘陌生人必须集结星际战士奋起反抗。',
    genres: ['科幻', '动作'],
  },
  lupin: {
    name: '亚森·罗宾',
    synopsis:
      '受亚森·罗宾的冒险故事启发，绅士怪盗阿萨内·迪奥普决心为父亲洗清一个豪门强加的冤屈。',
    genres: ['犯罪', '悬疑'],
  },
  witcher: {
    name: '猎魔人',
    synopsis:
      '变异的怪物猎手利维亚的杰洛特在动荡世界中走向自己的命运，那里的人往往比野兽更邪恶。',
    genres: ['奇幻', '动作'],
  },
  killer: {
    name: '杀手',
    synopsis:
      '一次致命的失手后，一名杀手在国际追捕中与雇主——以及自己——对抗，他坚称这不是私人恩怨。',
    genres: ['惊悚', '犯罪'],
  },
}

const zhEpisodes: Record<string, { name: string; synopsis: string }> = {
  'st-401': {
    name: '地狱火俱乐部',
    synopsis: '十一努力适应加州的生活，而新的威胁正在霍金斯地下蠢蠢欲动。',
  },
  'st-407': {
    name: '霍金斯实验室的惨案',
    synopsis: '谜团的碎片终于拼合在一起，一个可怕的真相浮出水面。',
  },
  'st-408': {
    name: '爸爸',
    synopsis: '时间所剩无几，众人制定最后的计划营救朋友。',
  },
  'wd-101': {
    name: '星期三的孩子满是忧伤',
    synopsis: '星期三抵达奈弗莫尔学院，立刻树敌——还不止一个。',
  },
  'wd-104': {
    name: '忧伤之夜',
    synopsis: '星期三在校园舞会上发现线索，而小镇的疑云愈发浓重。',
  },
  'wd-108': {
    name: '忧伤成群',
    synopsis: '星期三必须直面潜伏在森林中的怪物，保护她的朋友。',
  },
  'cr-401': {
    name: '金杖',
    synopsis: '伊丽莎白迎来新首相，而王室面临新一代媒体的头条风暴。',
  },
  'cr-406': {
    name: '无主之地',
    synopsis: '一次深入铁幕后的王室巡访，迫使宫殿直面令人不安的真相。',
  },
  'cr-610': {
    name: '睡吧，亲爱的，睡吧',
    synopsis: '女王回顾一生的服务，以及将比她更长久流传的遗产。',
  },
  'lp-101': {
    name: '第一章',
    synopsis: '阿萨内·迪奥普在卢浮宫策划一场大胆盗窃，为父亲复仇。',
  },
  'lp-105': {
    name: '第五章',
    synopsis: '法网收紧，阿萨内准备上演一场惊世骇俗的公开好戏。',
  },
  'wt-101': {
    name: '终结的开始',
    synopsis: '利维亚的杰洛特与一位被命运绑定的年轻公主相遇。',
  },
  'wt-305': {
    name: '幻术的艺术',
    synopsis: '隐藏的忠诚浮出水面，大陆离战争更近一步。',
  },
}

const languageZh: Record<string, string> = {
  English: '英语',
  French: '法语',
  Korean: '韩语',
  Spanish: '西班牙语',
}

export const titleName = (title: Title, language: Language) =>
  language === 'zh'
    ? (zhTitles[title.id]?.name ?? title.name)
    : (title.originalName ?? title.name)

export const titleSynopsis = (title: Title, language: Language) =>
  language === 'zh' ? (zhTitles[title.id]?.synopsis ?? title.synopsis) : title.synopsis

export const titleGenres = (title: Title, language: Language) =>
  language === 'zh' ? (zhTitles[title.id]?.genres ?? title.genres) : title.genres

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

export const episodeName = (episode: Episode, language: Language) =>
  language === 'zh' ? (zhEpisodes[episode.id]?.name ?? episode.name) : episode.name

export const episodeSynopsis = (episode: Episode, language: Language) =>
  language === 'zh' ? (zhEpisodes[episode.id]?.synopsis ?? episode.synopsis) : episode.synopsis

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

export const searchTextFor = (title: Title) => {
  const zh = zhTitles[title.id]
  const episodes = title.episodes ?? []
  return [
    title.name,
    zh?.name,
    ...title.genres,
    ...(zh?.genres ?? []),
    ...title.cast,
    title.creator,
    title.language,
    languageZh[title.language],
    title.synopsis,
    zh?.synopsis,
    ...episodes.flatMap((episode) => [
      episode.name,
      zhEpisodes[episode.id]?.name,
      episode.synopsis,
      zhEpisodes[episode.id]?.synopsis,
    ]),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}
