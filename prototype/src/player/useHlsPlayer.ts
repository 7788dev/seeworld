import { useCallback, useEffect, useRef, useState } from 'react'
import type HlsJs from 'hls.js'
import type { PlayErrorInfo, PlayTarget } from '../play'
import { FINISHED_EPSILON_SEC } from '../lib'

export type MediaPhase =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'buffering'
  | 'ended'
  | 'error'

export interface MediaCallbacks {
  onTime?: (current: number, duration: number) => void
  onPhase?: (phase: MediaPhase) => void
  onError?: (error: PlayErrorInfo) => void
  onEnded?: () => void
  onProxySwitch?: () => void
  onShortBuffer?: (stallMs: number) => void
  onRebufferSwitch?: (count: number) => void
  onSingleStall?: () => void
  onFirstFrame?: () => void
}

export interface UseHlsPlayerOptions {
  target: PlayTarget | null
  startTime?: number
  autoplay?: boolean
  volume?: number
  muted?: boolean
  reloadKey?: number
  expectedDuration?: number
  callbacks?: MediaCallbacks
}

export interface QualityLevel {
  index: number
  height: number
  bitrate: number
}

export interface HlsPlayerController {
  videoRef: React.RefObject<HTMLVideoElement | null>
  phase: MediaPhase
  time: number
  duration: number
  buffered: number
  quality: string | null
  levels: QualityLevel[]
  selectedLevel: number | 'auto'
  error: PlayErrorInfo | null
  usingProxy: boolean
  rate: number
  play: () => void
  pause: () => void
  toggle: () => void
  seek: (seconds: number) => void
  setRate: (rate: number) => void
  setLevel: (level: number | 'auto') => void
  retry: () => void
  retryOnProxy: () => void
}

const HLS_CONFIG = {
  enableWorker: true,
  lowLatencyMode: false,
  backBufferLength: 60,
  maxBufferLength: 90,
  maxMaxBufferLength: 180,
  maxBufferSize: 120 * 1024 * 1024,
  abrEwmaDefaultEstimate: 2_000_000,
  // Start on the lowest rendition for the fastest first frame; ABR takes over after.
  startLevel: 0,
  manifestLoadingTimeOut: 10_000,
  manifestLoadingMaxRetry: 3,
  levelLoadingMaxRetry: 3,
  fragLoadingTimeOut: 20_000,
  fragLoadingMaxRetry: 4,
}

const readBuffered = (video: HTMLVideoElement) => {
  const ranges = video.buffered
  if (!ranges || ranges.length === 0) return 0
  return ranges.end(ranges.length - 1)
}

const finiteDuration = (video: HTMLVideoElement) =>
  Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0

// Rebuffer policy: a stall only counts as a real rebuffer once playback actually
// stopped flowing for longer than STALL_MIN_MS — anything shorter is network
// jitter (伪缓冲) and must not accumulate toward the auto-switch. Two real
// rebuffers within STALL_WINDOW_MS trigger a source/line switch.
const STALL_MIN_MS = 1000
const STALL_WINDOW_MS = 300_000
// 5 分钟窗口内 3 次真实(>1s)卡顿才自动换源;亚秒抖动与单次卡顿不触发。
const STALL_SWITCH_COUNT = 3
// Stalls right after a user seek are the seek itself loading, not evidence of a
// bad source, so they never count toward the switch.
const SEEK_GRACE_MS = 2500

export function useHlsPlayer(options: UseHlsPlayerOptions): HlsPlayerController {
  const { target, startTime = 0, autoplay = true, volume = 0.72, muted = false, reloadKey = 0, expectedDuration = 0 } = options
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const hlsRef = useRef<HlsJs | null>(null)
  const callbacksRef = useRef<MediaCallbacks>(options.callbacks ?? {})
  const startTimeRef = useRef(startTime)
  const autoplayRef = useRef(autoplay)
  const expectedDurationRef = useRef(expectedDuration)
  const phaseRef = useRef<MediaPhase>('idle')

  const [phase, setPhaseState] = useState<MediaPhase>('idle')
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [buffered, setBuffered] = useState(0)
  const [quality, setQuality] = useState<string | null>(null)
  const [levels, setLevels] = useState<QualityLevel[]>([])
  const [selectedLevel, setSelectedLevel] = useState<number | 'auto'>('auto')
  const topLevelIndexRef = useRef(0)
  const [error, setError] = useState<PlayErrorInfo | null>(null)
  const [usingProxy, setUsingProxy] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [proxyNonce, setProxyNonce] = useState(0)
  const [rate, setRateState] = useState(1)
  const rateRef = useRef(1)
  const forceProxyRef = useRef(false)

  callbacksRef.current = options.callbacks ?? {}
  startTimeRef.current = startTime
  autoplayRef.current = autoplay
  expectedDurationRef.current = expectedDuration

  const updatePhase = useCallback((next: MediaPhase) => {
    if (phaseRef.current === next) return
    phaseRef.current = next
    setPhaseState(next)
    callbacksRef.current.onPhase?.(next)
  }, [])

  useEffect(() => {
    const video = videoRef.current
    if (video) {
      video.volume = Math.min(1, Math.max(0, volume))
      video.muted = muted
    }
  }, [volume, muted])

  useEffect(() => {
    forceProxyRef.current = false
  }, [target])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    setError(null)
    setTime(0)
    setDuration(0)
    setBuffered(0)
    setQuality(null)
    setLevels([])
    setSelectedLevel('auto')
    setUsingProxy(false)

    if (!target) {
      updatePhase('idle')
      return
    }

    let cancelled = false
    let hls: HlsJs | null = null
    let hlsCtor: typeof HlsJs | null = null
    const preferProxy = target.useProxy === true || forceProxyRef.current
    let useProxy = preferProxy
    let mediaRecovered = false
    let pendingPlay = autoplayRef.current
    let failed = false
    let hasPlayed = false
    let firstFrameSent = false
    let lastAdvanceAt = Date.now()
    let lastTime = 0
    let topLevelIndex = 0
    let bufferEpisodeActive = false
    let bufferCounted = false
    let bufferStartAt = 0
    let bufferEpisodes: number[] = []
    let rebufferSignaled = false
    let seekGraceUntil = 0
    let singleStallSignaled = false
    let firstFrameAt = 0
    let lastKnownTime = Math.max(0, startTimeRef.current || 0)
    let pendingRestore = lastKnownTime > 0
    // React 侧时间/缓冲只用于 UI：timeupdate 可达 4Hz，逐次 setState 会让
    // Theater（含剧集抽屉）整棵重渲染。1Hz 足够进度条与时间显示。
    let lastUiTimeAt = 0

    if (preferProxy) setUsingProxy(true)
    updatePhase('loading')

    const fail = (code: PlayErrorInfo['code'], detail?: string) => {
      if (cancelled || failed) return
      failed = true
      const info: PlayErrorInfo = { code, detail }
      setError(info)
      updatePhase('error')
      callbacksRef.current.onError?.(info)
      try {
        hls?.destroy()
      } catch {
        // ignore teardown races
      }
      hls = null
      hlsRef.current = null
      try {
        video.pause()
      } catch {
        // ignore
      }
    }

    const sourceUrl = (proxy: boolean) => (proxy ? target.proxyUrl || target.url : target.url)

    const switchToProxy = () => {
      useProxy = true
      setUsingProxy(true)
      lastAdvanceAt = Date.now()
      lastTime = video.currentTime
      lastKnownTime = video.currentTime
      pendingRestore = lastKnownTime > 0
      callbacksRef.current.onProxySwitch?.()
    }

    const updateResolution = () => {
      if (cancelled) return
      const width = video.videoWidth
      if (!width || width <= 0) {
        setQuality(null)
        return
      }
      if (width >= 3600) setQuality('4K')
      else if (width >= 2400) setQuality('1440P')
      else if (width >= 1800) setQuality('1080P')
      else if (width >= 1200) setQuality('720P')
      else if (width >= 800) setQuality('480P')
      else setQuality(`${video.videoHeight}P`)
    }

    const checkFirstFrame = () => {
      if (cancelled || firstFrameSent) return
      if (video.videoWidth > 0 && video.readyState >= 2 && video.currentTime > 0.05) {
        firstFrameSent = true
        callbacksRef.current.onFirstFrame?.()
      }
    }

    const applyStartTime = () => {
      if (!pendingRestore) return
      const total = finiteDuration(video)
      if (total <= 0) return
      const desired = lastKnownTime
      if (!(desired > 0) || desired > total - FINISHED_EPSILON_SEC) {
        // Near the end (or unknown): start over rather than ending instantly.
        pendingRestore = false
        return
      }
      const target = Math.min(Math.max(0, desired), Math.max(0, total - 1))
      if (Math.abs(video.currentTime - target) > 1) {
        try {
          video.currentTime = target
        } catch {
          return
        }
      }
      pendingRestore = false
    }

    const attemptPlay = () => {
      if (cancelled || !pendingPlay) return
      if (!video.paused) {
        pendingPlay = false
        return
      }
      void video
        .play()
        .then(() => {
          pendingPlay = false
        })
        .catch((reason: unknown) => {
          if (cancelled) return
          const name = reason instanceof DOMException ? reason.name : ''
          if (name === 'NotAllowedError') {
            pendingPlay = false
            updatePhase('ready')
            return
          }
          if (name === 'AbortError') return
          fail('load-failed', reason instanceof Error ? reason.message : undefined)
        })
    }

    const onLoadedMetadata = () => {
      if (cancelled) return
      const total = finiteDuration(video)
      setDuration(total)
      setBuffered(readBuffered(video))
      updateResolution()
      // 换集/换源会重建 media，浏览器把 playbackRate 重置成 1，这里恢复用户选择的倍速。
      try {
        video.playbackRate = rateRef.current
      } catch {
        // ignore unsupported rates
      }
      applyStartTime()
    }

    const onTimeUpdate = () => {
      if (cancelled) return
      lastKnownTime = video.currentTime
      if (firstFrameAt === 0 && video.currentTime > 0.05) firstFrameAt = Date.now()
      checkFirstFrame()
      if (video.currentTime > lastTime + 0.2) {
        lastTime = video.currentTime
        lastAdvanceAt = Date.now()
        singleStallSignaled = false
        endBufferEpisode()
      }
      const now = Date.now()
      if (now - lastUiTimeAt >= 1000 || video.ended) {
        lastUiTimeAt = now
        // 同一个 1Hz tick 内更新 time + buffered，React 会合并成一次渲染。
        setTime(video.currentTime)
        setBuffered(readBuffered(video))
      }
      callbacksRef.current.onTime?.(video.currentTime, finiteDuration(video))
    }

    const onPlay = () => {
      if (cancelled) return
      hasPlayed = true
      lastAdvanceAt = Date.now()
      lastTime = video.currentTime
      endBufferEpisode()
      singleStallSignaled = false
      checkFirstFrame()
      updatePhase('playing')
    }

    const onPause = () => {
      if (cancelled || video.ended) return
      // A pause the user initiated must not inflate an in-flight stall duration.
      bufferEpisodeActive = false
      bufferCounted = false
      setTime(video.currentTime)
      setBuffered(readBuffered(video))
      updatePhase(video.readyState >= 2 ? 'paused' : 'loading')
    }

    const onWaiting = () => {
      if (!cancelled) {
        noteBufferStart()
        updatePhase('buffering')
      }
    }

    const onPlaying = () => {
      if (cancelled) return
      hasPlayed = true
      lastAdvanceAt = Date.now()
      lastTime = video.currentTime
      endBufferEpisode()
      singleStallSignaled = false
      checkFirstFrame()
      updatePhase('playing')
    }

    const onSeeking = () => {
      lastAdvanceAt = Date.now()
      lastTime = video.currentTime
      lastKnownTime = video.currentTime
      pendingRestore = false
      // The stall (if any) that follows is the seek itself loading — discard the
      // current buffer episode and shield the next ones for a short grace period.
      seekGraceUntil = Date.now() + SEEK_GRACE_MS
      bufferEpisodeActive = false
      bufferCounted = false
    }

    const onSeeked = () => {
      lastAdvanceAt = Date.now()
      lastTime = video.currentTime
      lastKnownTime = video.currentTime
      pendingRestore = false
      setTime(video.currentTime)
      setBuffered(readBuffered(video))
      hasPlayed = true
    }

    const onResize = () => {
      updateResolution()
    }

    const onStalled = () => {
      if (!cancelled) noteBufferStart()
    }

    const noteBufferStart = () => {
      if (cancelled || failed || !hasPlayed) return
      if (video.paused || video.ended) return
      if (bufferEpisodeActive) return
      bufferEpisodeActive = true
      bufferCounted = false
      bufferStartAt = Date.now()
      singleStallSignaled = false
      // Startup buffering is handled by the 5s/8s/10s startup path, not counted here.
      if (!firstFrameAt || bufferStartAt - firstFrameAt < 10_000) return
      // A stall caused by the user seeking is the seek loading, not a slow source.
      if (bufferStartAt < seekGraceUntil) return
      // Not counted yet: the stall only enters the window once we know how long
      // it actually lasted (see endBufferEpisode).
      bufferCounted = true
    }

    const endBufferEpisode = () => {
      if (!bufferEpisodeActive) return
      bufferEpisodeActive = false
      if (cancelled || failed || !bufferCounted) return
      const stallMs = Date.now() - bufferStartAt
      if (stallMs <= STALL_MIN_MS) {
        // Fake buffer: recovered within a second — normal jitter, never counted.
        console.info(`[jj] fake buffer ${stallMs}ms ignored`)
        return
      }
      const now = Date.now()
      bufferEpisodes = bufferEpisodes.filter((time) => now - time <= STALL_WINDOW_MS)
      bufferEpisodes.push(bufferStartAt)
      if (!rebufferSignaled && bufferEpisodes.length >= STALL_SWITCH_COUNT) {
        rebufferSignaled = true
        callbacksRef.current.onRebufferSwitch?.(bufferEpisodes.length)
      } else if (!rebufferSignaled) {
        callbacksRef.current.onShortBuffer?.(stallMs)
      }
    }

    const onCanPlay = () => {
      if (cancelled) return
      const total = finiteDuration(video)
      if (total > 0) setDuration(total)
      setBuffered(readBuffered(video))
      updateResolution()
      checkFirstFrame()
      applyStartTime()
      if (pendingPlay) attemptPlay()
      else if (phaseRef.current === 'loading') updatePhase('ready')
    }

    const onLoadedData = () => {
      updateResolution()
      checkFirstFrame()
    }

    const onEnded = () => {
      if (cancelled) return
      pendingPlay = false
      setTime(video.currentTime)
      updatePhase('ended')
      callbacksRef.current.onEnded?.()
    }

    const onMediaError = () => {
      if (cancelled || failed) return
      const mediaError = video.error
      if (
        target.format === 'mp4' &&
        !useProxy &&
        !preferProxy &&
        target.proxyUrl &&
        target.proxyUrl !== target.url
      ) {
        switchToProxy()
        updatePhase('loading')
        video.src = target.proxyUrl
        video.load()
        return
      }
      const code = mediaError?.code
      if (code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED || code === MediaError.MEDIA_ERR_DECODE) {
        fail('unsupported', mediaError?.message)
      } else if (code === MediaError.MEDIA_ERR_NETWORK) {
        fail(useProxy ? 'proxy-failed' : 'load-failed', mediaError?.message)
      } else {
        fail('load-failed', mediaError?.message)
      }
    }

    const listeners: Array<[keyof HTMLMediaElementEventMap, () => void]> = [
      ['loadedmetadata', onLoadedMetadata],
      ['loadeddata', onLoadedData],
      ['durationchange', onLoadedMetadata],
      ['timeupdate', onTimeUpdate],
      ['play', onPlay],
      ['pause', onPause],
      ['waiting', onWaiting],
      ['playing', onPlaying],
      ['seeking', onSeeking],
      ['seeked', onSeeked],
      ['resize', onResize],
      ['stalled', onStalled],
      ['canplay', onCanPlay],
      ['ended', onEnded],
      ['error', onMediaError],
    ]
    for (const [event, handler] of listeners) video.addEventListener(event, handler)

    // Rebuffer policy: short buffers just keep waiting; one 60s stall triggers a switch.
    const watchdog = window.setInterval(() => {
      if (cancelled || failed || !hasPlayed) return
      if (video.paused || video.ended || singleStallSignaled) return
      if (Date.now() - lastAdvanceAt >= 60_000) {
        singleStallSignaled = true
        callbacksRef.current.onSingleStall?.()
      }
    }, 1000)

    const attachNative = (url: string) => {
      bufferEpisodeActive = false
      bufferCounted = false
      bufferStartAt = 0
      seekGraceUntil = 0
      bufferEpisodes = []
      rebufferSignaled = false
      singleStallSignaled = false
      if (lastKnownTime > 0) pendingRestore = true
      updatePhase('loading')
      video.src = url
      video.load()
    }

    const attachHls = async (proxy: boolean) => {
      bufferEpisodeActive = false
      bufferCounted = false
      bufferStartAt = 0
      seekGraceUntil = 0
      bufferEpisodes = []
      rebufferSignaled = false
      singleStallSignaled = false
      if (lastKnownTime > 0) pendingRestore = true
      try {
        if (!hlsCtor) {
          const module = await import('hls.js/light')
          hlsCtor = module.default
        }
        if (cancelled) return
        const Hls = hlsCtor
        if (!Hls.isSupported()) {
          if (video.canPlayType('application/vnd.apple.mpegurl')) {
            attachNative(sourceUrl(proxy))
          } else {
            fail('unsupported', 'MSE is not available in this runtime')
          }
          return
        }
        const instance = new Hls(HLS_CONFIG)
        hls = instance
        hlsRef.current = instance
        instance.on(Hls.Events.MANIFEST_PARSED, () => {
          if (cancelled) return
          let cappedIndex = -1
          instance.levels.forEach((level, index) => {
            if (level.height > 0 && level.height <= 1080) cappedIndex = index
          })
          topLevelIndex = cappedIndex >= 0 ? cappedIndex : 0
          topLevelIndexRef.current = topLevelIndex
          setLevels(
            instance.levels
              .map((level, index) => ({
                index,
                height: level.height || 0,
                bitrate: level.bitrate || 0,
              }))
              .filter((level) => level.height > 0),
          )
          try {
            // 1080P is the default ceiling; 4K is not auto-selected this round.
            instance.autoLevelCapping = topLevelIndex
          } catch {
            // ignore capping errors
          }
          attemptPlay()
        })
        instance.on(Hls.Events.LEVEL_LOADED, (_event, data) => {
          if (cancelled) return
          const details = data.details
          const fragments = details.fragments?.length ?? 0
          const total = details.totalduration ?? 0
          // hls.js does not expose ENDLIST directly; VOD playlists are treated as ended.
          const endList = !details.live
          const expected = expectedDurationRef.current
          console.info(
            `[jj] play hls level ${data.level} frags=${fragments} dur=${total.toFixed(1)} live=${details.live} endList=${endList}`,
          )
          if (details.live) return
          // 只对“已知电影时长”的明显截断做失败判定；剧集每集时长不同，
          // 短片段/短剧也不能仅凭绝对时长误杀。
          const truncated = expected > 120 && total > 0 && total < expected * 0.5
          if (truncated) {
            fail(
              'load-failed',
              `manifest truncated: frags=${fragments}, dur=${total.toFixed(1)}s, expected=${expected.toFixed(1)}s`,
            )
          }
        })
        instance.on(Hls.Events.ERROR, (_event, data) => {
          if (cancelled || !data.fatal) return
          const detail = [data.type, data.details, data.reason].filter(Boolean).join(' · ')
          const httpStatus = data.response?.code
          const httpFailed = typeof httpStatus === 'number' && httpStatus >= 400
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            if (!proxy && !preferProxy && target.proxyUrl && target.proxyUrl !== target.url) {
              switchToProxy()
              try {
                instance.destroy()
              } catch {
                // ignore teardown races
              }
              if (hls === instance) {
                hls = null
                hlsRef.current = null
              }
              void attachHls(true)
            } else {
              // F-02: HTTP failures (404/403/5xx) are load failures, not proxy rejections.
              fail(httpFailed ? 'load-failed' : proxy ? 'proxy-failed' : 'load-failed', detail)
            }
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            if (!mediaRecovered) {
              mediaRecovered = true
              try {
                instance.recoverMediaError()
              } catch {
                fail('unsupported', detail)
              }
            } else {
              fail('unsupported', detail)
            }
          } else {
            fail('load-failed', detail)
          }
        })
        instance.loadSource(sourceUrl(proxy))
        instance.attachMedia(video)
      } catch (reason) {
        fail('load-failed', reason instanceof Error ? reason.message : undefined)
      }
    }

    if (target.format === 'hls') {
      void attachHls(preferProxy)
    } else if (target.format === 'mp4') {
      attachNative(sourceUrl(preferProxy))
    } else {
      fail('unsupported', target.url)
    }

    return () => {
      cancelled = true
      window.clearInterval(watchdog)
      for (const [event, handler] of listeners) video.removeEventListener(event, handler)
      try {
        hls?.destroy()
      } catch {
        // ignore teardown races
      }
      hls = null
      hlsRef.current = null
      try {
        video.pause()
      } catch {
        // ignore
      }
      video.removeAttribute('src')
      try {
        video.load()
      } catch {
        // ignore
      }
    }
  }, [target, reloadKey, attempt, proxyNonce, updatePhase])

  const play = useCallback(() => {
    void videoRef.current?.play().catch(() => undefined)
  }, [])

  const pause = useCallback(() => {
    videoRef.current?.pause()
  }, [])

  const toggle = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) void video.play().catch(() => undefined)
    else video.pause()
  }, [])

  const seek = useCallback((seconds: number) => {
    const video = videoRef.current
    if (!video) return
    const total = finiteDuration(video)
    if (total <= 0) return
    const next = Math.min(total - 0.25, Math.max(0, seconds))
    try {
      video.currentTime = next
      setTime(next)
    } catch {
      // ignore unsupported seeks
    }
  }, [])

  const retry = useCallback(() => {
    setAttempt((current) => current + 1)
  }, [])

  const setRate = useCallback((next: number) => {
    if (!Number.isFinite(next)) return
    const clamped = Math.min(2, Math.max(0.5, next))
    rateRef.current = clamped
    setRateState(clamped)
    const video = videoRef.current
    if (!video) return
    try {
      video.playbackRate = clamped
    } catch {
      // ignore unsupported rates
    }
  }, [])

  const retryOnProxy = useCallback(() => {
    forceProxyRef.current = true
    setProxyNonce((current) => current + 1)
  }, [])

  const setLevel = useCallback((level: number | 'auto') => {
    const instance = hlsRef.current
    if (!instance) return
    try {
      if (level === 'auto') {
        // 手动选级会关闭 ABR；回到自动时恢复 1080 上限并交还给 hls.js。
        instance.autoLevelCapping = topLevelIndexRef.current
        instance.currentLevel = -1
        setSelectedLevel('auto')
      } else {
        const exists = instance.levels[level]
        if (!exists) return
        // 用户显式选择更高画质时解除默认 1080 上限。
        instance.autoLevelCapping = -1
        instance.currentLevel = level
        setSelectedLevel(level)
      }
    } catch {
      // ignore unsupported level switches
    }
  }, [])

  return {
    videoRef,
    phase,
    time,
    duration,
    buffered,
    quality,
    levels,
    selectedLevel,
    error,
    usingProxy,
    rate,
    play,
    pause,
    toggle,
    seek,
    setRate,
    setLevel,
    retry,
    retryOnProxy,
  }
}
