import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  ListVideo,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  RotateCcw,
  SkipBack,
  SkipForward,
  Volume1,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import {
  episodeName,
  formatEpisodeLabel,
  formatRuntimeLabel,
  mediaLabel,
  titleName,
} from '../content'
import { formatTime } from '../data'
import type { Episode, Title } from '../data'
import { useI18n } from '../i18n'
import { cx, isDesktopApp, percentage, usePersistentState } from '../lib'
import { isPlayableEpisode, isPlayableLine, nextPlayableLineIndex, playableLines } from '../play'
import type { AggregateLine, PlayErrorInfo, PlayProbeLine, PlayProbeResult } from '../play'
import type { PlaybackState, PlaybackStatus } from '../types'
import { useHlsPlayer } from '../player/useHlsPlayer'
import type { MediaPhase } from '../player/useHlsPlayer'
import { useFocusTrap } from '../useFocusTrap'
import type { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/window'

interface TheaterProps {
  title: Title
  playback: PlaybackState
  probe?: PlayProbeResult
  sourceName?: string
  allLines: AggregateLine[]
  expectedDuration?: number
  onClose: () => void
  onProgress: (current: number, duration: number, episodeId?: string, episodeIndex?: number) => void
  onLiveTime: (current: number, duration: number) => void
  onFirstFrame: () => void
  onStatus: (status: PlaybackStatus) => void
  onMediaError: (error: PlayErrorInfo) => void
  onShortBuffer: (stallMs: number) => void
  onRebufferSwitch: (count: number) => void
  onSingleStall: () => void
  onStartupActivity: () => void
  onRetry: () => void
  onSwitchLine: (lineIndex: number) => void
  onSwitchToLine: (sourceKey: string, lineIndex: number) => void
  onSwitchSource: () => void
  onPlayEpisode: (episode: Episode) => void
  onSelectSourceEpisode: (index: number) => void
  onEnded: () => void
}

const formatSpeed = (kbps: number) =>
  kbps >= 1024 ? `${(kbps / 1024).toFixed(1)} MB/s` : `${Math.max(1, Math.round(kbps))} KB/s`

const toPlaybackStatus = (phase: MediaPhase): PlaybackStatus | null => {
  switch (phase) {
    case 'idle':
      return null
    case 'loading':
      return 'loading'
    case 'ready':
      return 'ready'
    case 'playing':
      return 'playing'
    case 'paused':
      return 'paused'
    case 'buffering':
      return 'buffering'
    case 'ended':
      return 'ended'
    case 'error':
      return 'error'
  }
}

export default function Theater({
  title,
  playback,
  probe,
  sourceName,
  allLines,
  expectedDuration,
  onClose,
  onProgress,
  onLiveTime,
  onFirstFrame,
  onStatus,
  onMediaError,
  onShortBuffer,
  onRebufferSwitch,
  onSingleStall,
  onStartupActivity,
  onRetry,
  onSwitchLine,
  onSwitchToLine,
  onSwitchSource,
  onPlayEpisode,
  onSelectSourceEpisode,
  onEnded,
}: TheaterProps) {
  const { language, t } = useI18n()
  const [episodesOpen, setEpisodesOpen] = useState(false)
  const [immersive, setImmersive] = useState(false)
  const [chromeVisible, setChromeVisible] = useState(true)
  const [hoverPct, setHoverPct] = useState<number | null>(null)
  const [online, setOnline] = useState(
    typeof navigator === 'undefined' ? true : navigator.onLine,
  )
  const [volume, setVolume] = usePersistentState(
    'jj-player-volume',
    playback.volume > 0 ? playback.volume : 0.72,
    (value) =>
      typeof value === 'number' && Number.isFinite(value)
        ? Math.min(1, Math.max(0, value))
        : 0.72,
  )
  const [muted, setMuted] = usePersistentState(
    'jj-player-muted',
    playback.muted,
    (value) => (typeof value === 'boolean' ? value : false),
  )
  const hideTimer = useRef<number | null>(null)
  const stageClickTimer = useRef<number | null>(null)
  const lastPointer = useRef<{ x: number; y: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  useFocusTrap(rootRef)
  const topRef = useRef<HTMLElement>(null)
  const dockRef = useRef<HTMLDivElement>(null)
  const onProgressRef = useRef(onProgress)
  onProgressRef.current = onProgress
  const onLiveTimeRef = useRef(onLiveTime)
  onLiveTimeRef.current = onLiveTime
  const onFirstFrameRef = useRef(onFirstFrame)
  onFirstFrameRef.current = onFirstFrame
  const onShortBufferRef = useRef(onShortBuffer)
  onShortBufferRef.current = onShortBuffer
  const onRebufferSwitchRef = useRef(onRebufferSwitch)
  onRebufferSwitchRef.current = onRebufferSwitch
  const onSingleStallRef = useRef(onSingleStall)
  onSingleStallRef.current = onSingleStall
  const onStartupActivityRef = useRef(onStartupActivity)
  onStartupActivityRef.current = onStartupActivity
  const firstFrameSeenRef = useRef(false)
  const reportedBufferRef = useRef(0)
  const volumeRef = useRef<HTMLDivElement>(null)
  const volumeStateRef = useRef({ volume, muted })
  volumeStateRef.current = { volume, muted }
  const liveSentRef = useRef(0)
  const progressRef = useRef({ current: 0, duration: 0, lastSent: 0, dirty: false })
  const desktopRestore = useRef<{
    maximized: boolean
    position?: PhysicalPosition
    size?: PhysicalSize
  } | null>(null)

  const flushProgress = useCallback((force: boolean, snapshot?: { episodeId?: string; episodeIndex?: number }) => {
    const s = progressRef.current
    if (!(s.duration > 0)) return
    if (!force && !s.dirty) return
    onProgressRef.current(s.current, s.duration, snapshot?.episodeId, snapshot?.episodeIndex)
    s.lastSent = Date.now()
    s.dirty = false
  }, [])

  const handleTime = useCallback((current: number, duration: number) => {
    const snapshot = progressRef.current
    if (!(duration > 0)) return
    snapshot.current = current
    snapshot.duration = duration
    snapshot.dirty = true
    const now = Date.now()
    if (now - snapshot.lastSent >= 5000) {
      snapshot.lastSent = now
      snapshot.dirty = false
      onProgressRef.current(current, duration)
    }
  }, [])

  const media = useHlsPlayer({
    target: playback.target ?? null,
    startTime: playback.current,
    autoplay: true,
    volume,
    muted,
    reloadKey: playback.retryNonce ?? 0,
    expectedDuration,
    callbacks: {
      onTime: (current, duration) => {
        handleTime(current, duration)
        const now = Date.now()
        if (now - liveSentRef.current >= 1000) {
          liveSentRef.current = now
          onLiveTimeRef.current(current, duration)
        }
      },
      onPhase: (phase) => {
        const status = toPlaybackStatus(phase)
        if (status) onStatus(status)
        if (phase === 'paused' || phase === 'ended' || phase === 'error') flushProgress(true)
      },
      onError: (error) => onMediaError(error),
      onShortBuffer: (stallMs) => onShortBufferRef.current(stallMs),
      onRebufferSwitch: (count) => onRebufferSwitchRef.current(count),
      onSingleStall: () => onSingleStallRef.current(),
      onFirstFrame: () => {
        firstFrameSeenRef.current = true
        onFirstFrameRef.current()
      },
      onEnded: () => {
        flushProgress(true)
        onEnded()
      },
    },
  })

  const targetKey = playback.target
    ? `${playback.target.sourceKey}|${playback.target.lineIndex}|${playback.target.episodeIndex}`
    : 'none'

  useEffect(() => {
    // cleanup 闭包捕获的是本 effect 所属渲染的集数信息（targetKey 变化前的旧集），
    // 换集时补发的最终快照因此归属旧集，不会写错到新集头上。
    const snapshot = { episodeId: playback.episodeId, episodeIndex: playback.episodeIndex }
    progressRef.current = { current: 0, duration: 0, lastSent: 0, dirty: false }
    firstFrameSeenRef.current = false
    reportedBufferRef.current = 0
    return () => flushProgress(true, snapshot)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey, flushProgress])

  // 首帧前缓冲仍在增长 = 源"慢而活"(分片在正常下载),上报活动让启动窗口延长,
  // 避免慢源被固定 10s 启动超时误杀。
  useEffect(() => {
    if (firstFrameSeenRef.current) return
    if (media.buffered >= reportedBufferRef.current + 0.5) {
      reportedBufferRef.current = media.buffered
      onStartupActivityRef.current()
    }
  }, [media.buffered])

  const lines = playback.detail?.lines ?? []
  const activeLineIndex = playback.lineIndex ?? 0
  const activeLine = lines[activeLineIndex]
  const sourceEpisodes = activeLine?.episodes ?? []
  const doubanEpisodes = title.episodes ?? []
  const hasSourceEpisodes = sourceEpisodes.length > 0
  const hasEpisodeList = hasSourceEpisodes || doubanEpisodes.length > 0


  // 线路面板:优先展示跨源聚合结果(每条带源名与集数);聚合未就绪时回退当前源线路。
  interface LineTabView {
    sourceKey: string
    sourceName: string
    lineIndex: number
    lineName: string
    playable: boolean
    episodeCount: number
    active: boolean
    probeLine?: PlayProbeLine
  }
  const lineTabs: LineTabView[] =
    allLines.length > 0
      ? allLines.map((item) => ({
          sourceKey: item.sourceKey,
          sourceName: item.sourceName,
          lineIndex: item.lineIndex,
          lineName: item.lineName,
          playable: item.playable,
          episodeCount: item.episodeCount,
          active: item.sourceKey === playback.sourceKey && item.lineIndex === playback.lineIndex,
          probeLine:
            item.sourceKey === playback.sourceKey
              ? probe?.lines.find((entry) => entry.lineIndex === item.lineIndex)
              : undefined,
        }))
      : lines.map((line, index) => ({
          sourceKey: playback.sourceKey ?? '',
          sourceName: sourceName ?? '',
          lineIndex: index,
          lineName: line.name,
          playable: isPlayableLine(line),
          episodeCount: line.episodes.length,
          active: index === activeLineIndex,
          probeLine: probe?.lines.find((entry) => entry.lineIndex === index),
        }))

  // 线路条横向滑动:鼠标滚轮把垂直滚动转为横向;按住左键拖拽自由滑动,
  // 拖拽后的 click 会被吞掉,避免拖拽误触发线路切换。
  // 线路条随抽屉按需挂载,监听必须在节点出现后重新绑定。
  const lineTabsRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const node = lineTabsRef.current
    if (!node) return
    const draggable = () => node.scrollWidth > node.clientWidth + 4
    const dragState = { dragging: false, moved: false, startX: 0, startScroll: 0 }
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
      if (!draggable()) return
      node.scrollLeft += event.deltaY
      event.preventDefault()
    }
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || !draggable()) return
      dragState.dragging = true
      dragState.moved = false
      dragState.startX = event.clientX
      dragState.startScroll = node.scrollLeft
    }
    const onPointerMove = (event: PointerEvent) => {
      if (!dragState.dragging) return
      const delta = event.clientX - dragState.startX
      if (Math.abs(delta) > 5) dragState.moved = true
      node.scrollLeft = dragState.startScroll - delta
    }
    const onPointerUp = () => {
      dragState.dragging = false
    }
    const onClickCapture = (event: MouseEvent) => {
      if (!dragState.moved) return
      dragState.moved = false
      event.preventDefault()
      event.stopPropagation()
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    node.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
    node.addEventListener('click', onClickCapture, true)
    return () => {
      node.removeEventListener('wheel', onWheel)
      node.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
      node.removeEventListener('click', onClickCapture, true)
    }
  }, [episodesOpen, hasEpisodeList, lineTabs.length])
  const currentSourceEpisode =
    sourceEpisodes[
      Math.min(playback.episodeIndex ?? 0, Math.max(0, sourceEpisodes.length - 1))
    ]
  const currentDoubanEpisode = playback.episodeId
    ? doubanEpisodes.find((episode) => episode.id === playback.episodeId)
    : undefined
  const duration = media.duration > 0 ? media.duration : playback.duration
  const progressPct = percentage(media.time, duration)
  const bufferPct = percentage(media.buffered, duration)
  const isPlaying = media.phase === 'playing'
  const chromeHidden = !chromeVisible
  const localizedName = titleName(title, language)
  const activeError = playback.error ?? media.error
  const autoSwitching = Boolean(playback.autoRecovering)
  const isResolving = playback.status === 'resolving' && !playback.target && !activeError
  const isLoadingVideo = Boolean(playback.target) && media.phase === 'loading' && !activeError
  const showError =
    !autoSwitching && (Boolean(activeError || media.phase === 'error'))
  const showCenterPlay =
    !showError &&
    !autoSwitching &&
    !isResolving &&
    !isLoadingVideo &&
    (media.phase === 'ready' || media.phase === 'paused' || media.phase === 'ended')

  const osdTimer = useRef<number | null>(null)
  const [volumeOsd, setVolumeOsd] = useState(false)
  const flashVolumeOsd = useCallback(() => {
    setVolumeOsd(true)
    if (osdTimer.current !== null) window.clearTimeout(osdTimer.current)
    osdTimer.current = window.setTimeout(() => setVolumeOsd(false), 1400)
  }, [])

  useEffect(
    () => () => {
      if (osdTimer.current !== null) window.clearTimeout(osdTimer.current)
      if (stageClickTimer.current !== null) window.clearTimeout(stageClickTimer.current)
    },
    [],
  )

  const changeVolume = useCallback(
    (delta: number) => {
      const next = Math.min(
        1,
        Math.max(0, Math.round((volumeStateRef.current.volume + delta) * 100) / 100),
      )
      setVolume(next)
      setMuted(next === 0)
      flashVolumeOsd()
    },
    [flashVolumeOsd, setMuted, setVolume],
  )

  // Scroll over the volume control adjusts volume, like desktop players.
  useEffect(() => {
    const node = volumeRef.current
    if (!node) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      event.stopPropagation()
      changeVolume(event.deltaY > 0 ? -0.05 : 0.05)
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => node.removeEventListener('wheel', onWheel)
  }, [changeVolume])

  // Startup 8s without a visible frame: retry the same line through jjstream once.
  useEffect(() => {
    const target = playback.target
    if (!playback.slowStartup || playback.autoRecovering) return
    if (!target || target.useProxy || media.usingProxy) return
    if (!target.proxyUrl || target.proxyUrl === target.url) return
    const timer = window.setTimeout(() => {
      console.info('[jj] direct slow -> proxy retry', {
        titleId: playback.titleId,
        sourceKey: target.sourceKey,
        lineIndex: target.lineIndex,
        episodeIndex: target.episodeIndex,
      })
      media.retryOnProxy()
    }, 3000)
    return () => window.clearTimeout(timer)
  }, [
    playback.autoRecovering,
    playback.slowStartup,
    playback.target,
    playback.titleId,
    media.usingProxy,
    media.retryOnProxy,
  ])
  const subtitle = currentSourceEpisode
    ? [activeLine?.name, currentSourceEpisode.name].filter(Boolean).join(' · ')
    : currentDoubanEpisode
      ? formatEpisodeLabel(
          currentDoubanEpisode.season,
          currentDoubanEpisode.number,
          episodeName(currentDoubanEpisode, language),
          language,
        )
      : title.mediaType === 'series'
        ? t('player.series')
        : t('player.film', { duration: formatRuntimeLabel(title.duration, language) })
  const volumeIcon =
    muted || volume === 0 ? VolumeX : volume < 0.55 ? Volume1 : Volume2

  const errorMessage = (error: PlayErrorInfo) => {
    switch (error.code) {
      case 'no-source':
        return t('player.errorNoSource')
      case 'unsupported':
        return t('player.errorUnsupported')
      case 'proxy-failed':
        return t('player.errorProxy')
      default:
        return t('player.errorLoad')
    }
  }

  // Manual startDragging (same approach as TitleBar): the bare data-tauri-drag-region
  // attribute is unreliable inside the theater because the stage swallows pointer hits.
  const startWindowDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    void import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => getCurrentWindow().startDragging())
      .catch(() => undefined)
  }

  const restoreDesktopWindow = async () => {
    const saved = desktopRestore.current
    desktopRestore.current = null
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      const win = getCurrentWindow()
      if (saved?.maximized) {
        await win.maximize()
      } else if (saved?.position && saved.size) {
        await win.setPosition(saved.position)
        await win.setSize(saved.size)
      }
      await win.setAlwaysOnTop(false)
    } catch {
      // the window may already be closing
    }
  }

  const enterDesktopImmersive = async () => {
    try {
      const { getCurrentWindow, currentMonitor } = await import('@tauri-apps/api/window')
      const win = getCurrentWindow()
      if (desktopRestore.current) return
      const maximized = await win.isMaximized()
      if (maximized) {
        desktopRestore.current = { maximized: true }
        await win.unmaximize()
      } else {
        const [position, size] = await Promise.all([win.outerPosition(), win.innerSize()])
        desktopRestore.current = { maximized: false, position, size }
      }
      const monitor = await currentMonitor()
      if (monitor) {
        await win.setPosition(monitor.position)
        await win.setSize(monitor.size)
      }
      await win.setAlwaysOnTop(true)
    } catch {
      // keep the player inside the current window when the monitor is unavailable
    }
  }

  const clearHideTimer = () => {
    if (hideTimer.current !== null) {
      window.clearTimeout(hideTimer.current)
      hideTimer.current = null
    }
  }

  const controlsUnder = (x: number, y: number) =>
    [topRef.current, dockRef.current].some((node) => {
      if (!node) return false
      const rect = node.getBoundingClientRect()
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
    })

  const holdChrome = () => {
    clearHideTimer()
  }

  const releaseChrome = () => {
    clearHideTimer()
    if (isPlaying && !episodesOpen) {
      hideTimer.current = window.setTimeout(() => setChromeVisible(false), 2800)
    }
  }

  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  useEffect(() => {
    if (isDesktopApp) return
    const onFullscreenChange = () => {
      if (!document.fullscreenElement) setImmersive(false)
    }
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange)
      if (document.fullscreenElement) {
        void document.exitFullscreen().catch(() => undefined)
      }
    }
  }, [])

  useEffect(() => {
    if (!isDesktopApp) return
    return () => {
      if (desktopRestore.current) void restoreDesktopWindow()
    }
  }, [])

  useEffect(() => {
    const canAutoHide = isPlaying && !episodesOpen
    const scheduleHide = () => {
      clearHideTimer()
      if (!canAutoHide) return
      hideTimer.current = window.setTimeout(() => setChromeVisible(false), 2800)
    }
    const reveal = (event?: Event) => {
      let point: { x: number; y: number } | undefined
      if (event instanceof MouseEvent) {
        point = { x: event.clientX, y: event.clientY }
        if (event.type === 'pointermove' || event.type === 'mousemove') {
          const last = lastPointer.current
          if (last && last.x === point.x && last.y === point.y) return
          lastPointer.current = point
        }
      }
      setChromeVisible(true)
      clearHideTimer()
      if (!canAutoHide) return
      const activePoint = point ?? lastPointer.current
      if (activePoint && controlsUnder(activePoint.x, activePoint.y)) return
      scheduleHide()
    }
    reveal()
    window.addEventListener('pointermove', reveal)
    window.addEventListener('mousemove', reveal)
    window.addEventListener('pointerdown', reveal)
    window.addEventListener('keydown', reveal)
    return () => {
      window.removeEventListener('pointermove', reveal)
      window.removeEventListener('mousemove', reveal)
      window.removeEventListener('pointerdown', reveal)
      window.removeEventListener('keydown', reveal)
      clearHideTimer()
    }
  }, [immersive, isPlaying, episodesOpen])

  // 键盘处理用 ref 载荷:监听器只挂载一次,不被每秒的时间更新牵着重新挂载。
  const keyHandlerRef = useRef<(event: KeyboardEvent) => void>(() => {})
  keyHandlerRef.current = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null
    if (event.key === 'Escape') {
      if (episodesOpen) {
        event.preventDefault()
        event.stopImmediatePropagation()
        setEpisodesOpen(false)
        return
      }
      if (immersive || document.fullscreenElement) {
        event.preventDefault()
        event.stopImmediatePropagation()
        void exitImmersive()
      }
      return
    }
    if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
    if (event.code === 'Space') {
      event.preventDefault()
      media.toggle()
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      media.seek(media.time + 10)
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      media.seek(media.time - 10)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      changeVolume(0.05)
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      changeVolume(-0.05)
    } else if (event.key.toLowerCase() === 'm') {
      setMuted((value) => !value)
    } else if (event.key.toLowerCase() === 'f') {
      event.preventDefault()
      void toggleFullscreen()
    }
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => keyHandlerRef.current(event)
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const enterImmersive = () => {
    setImmersive(true)
    setChromeVisible(true)
    if (isDesktopApp) {
      void enterDesktopImmersive()
      return
    }
    const request = rootRef.current?.requestFullscreen?.()
    if (request) request.catch(() => undefined)
  }

  const exitImmersive = async () => {
    if (isDesktopApp) {
      await restoreDesktopWindow()
      setImmersive(false)
      return
    }
    setImmersive(false)
    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen()
      } catch {
        // the browser may already have left fullscreen
      }
    }
  }

  const toggleFullscreen = () => {
    if (immersive) {
      void exitImmersive()
    } else {
      enterImmersive()
    }
  }

  const previewSeek = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const pct = ((event.clientX - rect.left) / rect.width) * 100
    setHoverPct(Math.min(100, Math.max(0, pct)))
  }

  // Single click toggles playback; double click toggles fullscreen (YouTube-style:
  // the pending single-click action is cancelled when a double click arrives).
  const handleStageClick = () => {
    if (!playback.target || showError) return
    if (stageClickTimer.current !== null) return
    stageClickTimer.current = window.setTimeout(() => {
      stageClickTimer.current = null
      media.toggle()
    }, 250)
  }

  const handleStageDoubleClick = () => {
    if (stageClickTimer.current !== null) {
      window.clearTimeout(stageClickTimer.current)
      stageClickTimer.current = null
    }
    toggleFullscreen()
  }

  const requestClose = () => {
    flushProgress(true)
    onClose()
  }

  return (
    <div
      className={cx('theater', immersive && 'is-immersive', chromeHidden && 'is-chrome-hidden')}
      role="dialog"
      aria-modal="true"
      aria-label={t('player.nowPlaying', { name: localizedName })}
      ref={rootRef}
    >
      <div
        className="theater-stage"
        onClick={handleStageClick}
        onDoubleClick={handleStageDoubleClick}
      >
        <div
          className="theater-ambient"
          style={{ backgroundImage: `url(${title.hero ?? title.poster})` }}
          aria-hidden
        />
        <div className="theater-screen">
          <img
            className={cx('theater-art', title.hero && 'theater-art--wide')}
            src={title.hero ?? title.poster}
            alt=""
            key={title.id}
          />
          <video
            className={cx('theater-video', !playback.target && 'is-idle')}
            ref={media.videoRef}
            playsInline
            preload="metadata"
          />
          <div className="theater-vignette" aria-hidden />
          <div className="theater-grain" aria-hidden />
        </div>
      </div>

      <header
        className="theater-top"
        ref={topRef}
        onPointerEnter={holdChrome}
        onPointerLeave={releaseChrome}
      >
        {isDesktopApp && !immersive && (
          <div className="theater-drag-region" onPointerDown={startWindowDrag} aria-hidden />
        )}
        <button type="button" className="theater-back" onClick={requestClose}>
          <ArrowLeft size={17} aria-hidden />
          <span>{t('player.back')}</span>
        </button>
        <div className="theater-id">
          <span className="theater-brand">
            <span className="n-mark">S</span>
            {mediaLabel(title.mediaType, language)}
          </span>
          <strong>{localizedName}</strong>
        </div>
        <div className="theater-tools">
          {media.quality && <span className="quality-chip">{media.quality}</span>}
          {media.usingProxy && (
            <span className="quality-chip quality-chip--proxy">{t('player.proxyChip')}</span>
          )}
          {hasEpisodeList && (
            <button
              type="button"
              className={cx('theater-tool', episodesOpen && 'is-active')}
              aria-expanded={episodesOpen}
              onClick={() => setEpisodesOpen((open) => !open)}
            >
              <ListVideo size={16} aria-hidden />
              {t('player.episodes')}
            </button>
          )}
        </div>
      </header>

      {(isResolving || isLoadingVideo || autoSwitching) && (
        <div className="theater-overlay" role="status" aria-live="polite">
          <span className="theater-spinner" aria-hidden />
          <p>
            {!online
              ? t('player.networkLost')
              : autoSwitching
                ? t('player.switching')
                : isResolving
                  ? t('player.resolving')
                  : t('player.loading')}
          </p>
        </div>
      )}

      {playback.slowStartup && !showError && !autoSwitching && (
        <div className="theater-slow" role="status">
          <span>{t('player.slowLoading')}</span>
          <div className="theater-slow-actions">
            {playback.detail && playableLines(playback.detail).length > 1 && (
              <button
                type="button"
                className="theater-action theater-action--small"
                onClick={() =>
                  onSwitchLine(nextPlayableLineIndex(playback.detail!, activeLineIndex))
                }
              >
                {t('player.switchLine')}
              </button>
            )}
            <button
              type="button"
              className="theater-action theater-action--small"
              onClick={onSwitchSource}
            >
              {t('player.switchSource')}
            </button>
          </div>
        </div>
      )}

      {media.phase === 'buffering' && !showError && (
        <div className="theater-buffering" role="status" aria-live="polite">
          <span className="theater-spinner" aria-hidden />
          <span>{online ? t('player.buffering') : t('player.networkLost')}</span>
        </div>
      )}

      {volumeOsd && (
        <div className="theater-osd" role="status">
          {volumeIcon === VolumeX ? (
            <VolumeX size={15} aria-hidden />
          ) : volumeIcon === Volume1 ? (
            <Volume1 size={15} aria-hidden />
          ) : (
            <Volume2 size={15} aria-hidden />
          )}
          <span className="theater-osd-track" aria-hidden>
            <span
              className="theater-osd-fill"
              style={{ width: `${Math.round((muted ? 0 : volume) * 100)}%` }}
            />
          </span>
          <em>{Math.round((muted ? 0 : volume) * 100)}%</em>
        </div>
      )}

      {showError && activeError && (
        <div className="theater-overlay theater-overlay--error">
          <div className="theater-error-card" role="alert">
            <span className="theater-error-icon" aria-hidden>
              <AlertTriangle size={22} />
            </span>
            <h3>{t('player.errorTitle')}</h3>
            <p>{errorMessage(activeError)}</p>
            {activeError.detail && language === 'zh' && (
              <p className="theater-error-detail">{activeError.detail}</p>
            )}
            <div className="theater-error-actions">
              <button type="button" className="theater-action theater-action--primary" onClick={onRetry}>
                {t('player.retry')}
              </button>
              {playback.detail && playableLines(playback.detail).length > 1 && (
                <button
                  type="button"
                  className="theater-action"
                  onClick={() =>
                    onSwitchLine(nextPlayableLineIndex(playback.detail!, activeLineIndex))
                  }
                >
                  {t('player.switchLine')}
                </button>
              )}
              <button type="button" className="theater-action" onClick={onSwitchSource}>
                {t('player.switchSource')}
              </button>
              <button type="button" className="theater-action" onClick={requestClose}>
                {t('player.back')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showCenterPlay && (
        <button
          type="button"
          className="theater-center"
          aria-label={t('player.resume')}
          onClick={(event) => {
            event.stopPropagation()
            media.toggle()
          }}
        >
          <Play size={30} fill="currentColor" strokeWidth={0} aria-hidden />
        </button>
      )}

      <div className="theater-bottom">
        <div
          className="dock"
          ref={dockRef}
          onPointerEnter={holdChrome}
          onPointerLeave={releaseChrome}
        >
          <div className="dock-row">
            <div className="dock-meta">
              <div className="dock-thumb">
                <img src={title.hero ?? title.poster} alt="" />
                <span className="dock-thumb-glow" aria-hidden />
              </div>
              <div className="dock-id">
                <strong>{localizedName}</strong>
                <span>{subtitle}</span>
              </div>
            </div>

            <div className="dock-controls">
              <button
                type="button"
                className="dock-btn"
                aria-label={t('player.close')}
                onClick={requestClose}
              >
                <X size={19} strokeWidth={1.8} />
              </button>
              <button
                type="button"
                className="dock-btn"
                aria-label={t('player.back10')}
                onClick={() => media.seek(media.time - 10)}
              >
                <SkipBack size={19} fill="currentColor" strokeWidth={0} />
              </button>
              <button
                type="button"
                className="dock-play"
                aria-label={isPlaying ? t('player.pause') : t('player.play')}
                onClick={() => media.toggle()}
              >
                {isPlaying ? (
                  <Pause size={21} fill="currentColor" strokeWidth={0} />
                ) : (
                  <Play size={21} fill="currentColor" strokeWidth={0} />
                )}
              </button>
              <button
                type="button"
                className="dock-btn"
                aria-label={t('player.forward10')}
                onClick={() => media.seek(media.time + 10)}
              >
                <SkipForward size={19} fill="currentColor" strokeWidth={0} />
              </button>
              <button
                type="button"
                className="dock-btn"
                aria-label={t('player.restart')}
                onClick={() => {
                  media.seek(0)
                  media.play()
                }}
              >
                <RotateCcw size={18} strokeWidth={1.8} />
              </button>
            </div>

            <div className="dock-tools">
              <div className="volume" ref={volumeRef}>
                <button
                  type="button"
                  className="dock-btn volume-btn"
                  aria-label={muted ? t('player.unmute') : t('player.mute')}
                  onClick={() => setMuted((value) => !value)}
                >
                  {volumeIcon === VolumeX ? (
                    <VolumeX size={19} />
                  ) : volumeIcon === Volume1 ? (
                    <Volume1 size={19} />
                  ) : (
                    <Volume2 size={19} />
                  )}
                </button>
                <input
                  className="volume-slider"
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={muted ? 0 : volume}
                  aria-label={t('player.volume')}
                  onChange={(event) => {
                    const next = Number(event.target.value)
                    setVolume(next)
                    setMuted(next === 0)
                  }}
                />
              </div>
              <button
                type="button"
                className="dock-btn dock-fullscreen"
                aria-label={
                  immersive ? t('player.exitFullscreenAria') : t('player.enterFullscreenAria')
                }
                aria-pressed={immersive}
                title={immersive ? t('player.exitFullscreen') : t('player.fullscreen')}
                onClick={toggleFullscreen}
              >
                {immersive ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
              </button>
            </div>
          </div>

          <div className="dock-timeline">
            <span className="dock-time">{formatTime(media.time)}</span>
            <div
              className="seek"
              onPointerMove={previewSeek}
              onPointerLeave={() => setHoverPct(null)}
            >
              <div className="seek-track">
                <span className="seek-buffer" style={{ width: `${bufferPct}%` }} />
                <span className="seek-fill" style={{ width: `${progressPct}%` }} />
                <span className="seek-thumb" style={{ left: `${progressPct}%` }} />
              </div>
              {hoverPct !== null && duration > 0 && (
                <span className="seek-preview" style={{ left: `${hoverPct}%` }}>
                  {formatTime((hoverPct / 100) * duration)}
                </span>
              )}
              <input
                className="seek-input"
                type="range"
                min={0}
                max={duration || 0}
                step={1}
                value={media.time}
                aria-label={t('player.seek')}
                disabled={duration <= 0}
                onChange={(event) => media.seek(Number(event.target.value))}
              />
            </div>
            <span className="dock-time dock-time--total">{formatTime(duration)}</span>
          </div>
        </div>
      </div>

      {episodesOpen && hasEpisodeList && (
        <aside className="episode-drawer" aria-label={t('player.episodes')}>
          <div className="episode-drawer-head">
            <div>
              <span>
                {hasSourceEpisodes ? t('player.sourceEpisodes') : t('player.episodes')}
              </span>
              <h2>{t('player.episodes')}</h2>
            </div>
            <button
              type="button"
              className="theater-tool theater-tool--icon"
              aria-label={t('player.closeEpisodes')}
              onClick={() => setEpisodesOpen(false)}
            >
              <X size={17} />
            </button>
          </div>

          {lineTabs.length > 0 && (
            <div ref={lineTabsRef} className="line-tabs" role="tablist" aria-label={t('player.lineLabel')}>
              {lineTabs.map((tab) => {
                const qualityLabel =
                  tab.probeLine && tab.probeLine.height > 0 ? `${tab.probeLine.height}P` : ''
                const speedLabel =
                  tab.probeLine && tab.probeLine.ok && tab.probeLine.speedKbps > 0
                    ? formatSpeed(tab.probeLine.speedKbps)
                    : ''
                const episodeLabel =
                  tab.episodeCount > 0
                    ? t('player.lineEpisodes', { count: tab.episodeCount })
                    : ''
                // 正在播放的线路以真实播放状态为准,不显示"探测失败"。
                const probeMeta = tab.active
                  ? [t('player.playingNow'), qualityLabel].filter(Boolean).join(' · ')
                  : tab.probeLine
                    ? tab.probeLine.ok
                      ? [
                          tab.probeLine.recommended ? t('player.recommended') : '',
                          qualityLabel,
                          speedLabel,
                        ]
                          .filter(Boolean)
                          .join(' · ')
                      : t('player.probeFailed')
                    : ''
                const meta = [
                  !tab.playable ? t('player.lineUnsupported') : probeMeta,
                  episodeLabel,
                ]
                  .filter(Boolean)
                  .join(' · ')
                return (
                  <button
                    key={`${tab.sourceKey}-${tab.lineIndex}-${tab.lineName}`}
                    type="button"
                    role="tab"
                    aria-selected={tab.active}
                    disabled={!tab.playable || tab.active}
                    title={[tab.sourceName, tab.lineName, meta, tab.probeLine?.error ?? '']
                      .filter(Boolean)
                      .join(' · ')}
                    className={cx(
                      'line-tab',
                      tab.active && 'is-active',
                      !tab.playable && 'is-disabled',
                    )}
                    onClick={() => {
                      if (tab.active) return
                      if (tab.sourceKey && tab.sourceKey !== playback.sourceKey) {
                        onSwitchToLine(tab.sourceKey, tab.lineIndex)
                      } else {
                        onSwitchLine(tab.lineIndex)
                      }
                    }}
                  >
                    <span>
                      {[tab.sourceName, tab.lineName || `${t('player.lineLabel')} ${tab.lineIndex + 1}`]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                    {meta && <em>{meta}</em>}
                  </button>
                )
              })}
            </div>
          )}

          <div className="episode-list">
            {hasSourceEpisodes
              ? sourceEpisodes.map((episode, index) => {
                  const active = (playback.episodeIndex ?? -1) === index
                  const playable = isPlayableEpisode(episode)
                  return (
                    <button
                      key={`${episode.name}-${index}`}
                      type="button"
                      className={cx(
                        'episode-row',
                        active && 'is-active',
                        !playable && 'is-disabled',
                      )}
                      disabled={!playable}
                      title={playable ? episode.name : t('player.lineUnsupported')}
                      onClick={() => {
                        if (playable) onSelectSourceEpisode(index)
                      }}
                    >
                      <span className="episode-number">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <span className="episode-copy">
                        <strong>{episode.name || `${t('player.episodes')} ${index + 1}`}</strong>
                        <span>
                          {playable
                            ? t('player.sourceTag', { index: (episode.index ?? index) + 1 })
                            : t('player.lineUnsupported')}
                        </span>
                      </span>
                      <span className="episode-play" aria-hidden>
                        {active && isPlaying ? (
                          <Pause size={13} fill="currentColor" strokeWidth={0} />
                        ) : (
                          <Play size={13} fill="currentColor" strokeWidth={0} />
                        )}
                      </span>
                    </button>
                  )
                })
              : doubanEpisodes.map((episode) => {
                  const active = playback.episodeId === episode.id
                  return (
                    <button
                      key={episode.id}
                      type="button"
                      className={cx('episode-row', active && 'is-active')}
                      onClick={() => onPlayEpisode(episode)}
                    >
                      <span className="episode-number">
                        {String(episode.number).padStart(2, '0')}
                      </span>
                      <span className="episode-copy">
                        <strong>{episodeName(episode, language)}</strong>
                        <span>{formatRuntimeLabel(episode.runtime, language)}</span>
                      </span>
                      <span className="episode-play" aria-hidden>
                        {active && isPlaying ? (
                          <Pause size={13} fill="currentColor" strokeWidth={0} />
                        ) : (
                          <Play size={13} fill="currentColor" strokeWidth={0} />
                        )}
                      </span>
                    </button>
                  )
                })}
            {!hasSourceEpisodes && doubanEpisodes.length > 0 && (
              <p className="episode-hint">{t('player.placeholderEpisodes')}</p>
            )}
          </div>
        </aside>
      )}
    </div>
  )
}
