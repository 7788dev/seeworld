import type { PlayDetail, PlayErrorInfo, PlayTarget } from './play'

export type PlaybackStatus =
  | 'resolving'
  | 'loading'
  | 'ready'
  | 'playing'
  | 'buffering'
  | 'paused'
  | 'ended'
  | 'error'

export interface PlaybackState {
  titleId: string
  episodeId?: string
  episodeNumber?: number
  episodeIndex?: number
  lineIndex?: number
  sourceKey?: string
  current: number
  duration: number
  playing: boolean
  volume: number
  muted: boolean
  status: PlaybackStatus
  error?: PlayErrorInfo
  target?: PlayTarget
  detail?: PlayDetail
  retryNonce?: number
  slowStartup?: boolean
  autoRecovering?: boolean
}

export interface PlaybackProgress {
  current: number
  duration: number
  episodeId?: string
  // Source episode index, persisted so resume still works when Title.episodes is not loaded yet.
  episodeIndex?: number
  updatedAt?: number
}
