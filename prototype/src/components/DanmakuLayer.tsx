import { useEffect, useRef } from 'react'
import type { DanmakuItem } from '../play'

interface ActiveDanmaku {
  item: DanmakuItem
  lane: number
  x: number
  width: number
  spawnAt: number // 激活时的视频时间(秒)
  duration: number // 通过全屏所需秒数
}

interface DanmakuLayerProps {
  items: DanmakuItem[]
  time: number // 视频当前时间(秒)
  playing: boolean
  enabled: boolean
}

/**
 * Canvas 弹幕层:滚动/顶部/底部三种模式,与视频时间轴对齐。
 * 拖动进度条时按视频时间直接对齐(已过时间不再补显)。
 */
export default function DanmakuLayer({ items, time, playing, enabled }: DanmakuLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const stateRef = useRef({
    cursor: 0, // 已激活的弹幕索引(items 按 timeMs 升序)
    active: [] as ActiveDanmaku[],
    lastTime: time,
    raf: 0,
  })
  const itemsRef = useRef(items)
  itemsRef.current = items
  const timeRef = useRef(time)
  timeRef.current = time
  const playingRef = useRef(playing)
  playingRef.current = playing

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !enabled) return
    const context = canvas.getContext('2d')
    if (!context) return

    let lastFrame = performance.now()

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.max(1, Math.round(rect.width * dpr))
      canvas.height = Math.max(1, Math.round(rect.height * dpr))
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)

    const loop = () => {
      stateRef.current.raf = requestAnimationFrame(loop)
      const now = performance.now()
      const dt = Math.min(0.12, (now - lastFrame) / 1000)
      lastFrame = now

      const rect = canvas.getBoundingClientRect()
      const width = rect.width
      const height = rect.height
      if (width < 10 || height < 10) return
      context.clearRect(0, 0, width, height)

      const state = stateRef.current
      const currentItems = itemsRef.current
      const videoTime = timeRef.current
      const isPlaying = playingRef.current

      // 视频时间回退(seek 往回):重置游标并清屏
      if (videoTime < state.lastTime - 0.5) {
        state.cursor = 0
        state.active = []
        // 快进游标到当前时间
        while (
          state.cursor < currentItems.length &&
          currentItems[state.cursor].timeMs / 1000 < videoTime
        ) {
          state.cursor += 1
        }
      } else if (videoTime > state.lastTime + 2.5) {
        // 快进:跳过中间弹幕
        while (
          state.cursor < currentItems.length &&
          currentItems[state.cursor].timeMs / 1000 <= videoTime
        ) {
          state.cursor += 1
        }
        state.active = []
      }
      state.lastTime = videoTime

      const fontSize = Math.max(14, Math.round(height * 0.055))
      const laneHeight = fontSize * 1.35
      const laneCount = Math.max(3, Math.floor(height * 0.82 / laneHeight))
      const scrollDuration = Math.max(7, width / 130)

      // 激活新弹幕
      if (isPlaying) {
        while (
          state.cursor < currentItems.length &&
          currentItems[state.cursor].timeMs / 1000 <= videoTime
        ) {
          const item = currentItems[state.cursor]
          state.cursor += 1
          context.font = `bold ${fontSize}px 'PingFang SC', 'Microsoft YaHei UI', 'Microsoft YaHei', sans-serif`
          const textWidth = context.measureText(item.text).width
          if (item.mode === 'scroll') {
            // 找一条右端不会立即重叠的轨道
            let lane = -1
            let bestLane = 0
            let bestFree = -1
            for (let index = 0; index < laneCount; index += 1) {
              const occupant = state.active.find(
                (active) => active.lane === index && active.item.mode === 'scroll',
              )
              if (!occupant) {
                lane = index
                break
              }
              const freeAt = (videoTime - occupant.spawnAt) / occupant.duration
              const gap = freeAt * (width + occupant.width)
              if (gap > occupant.width * 0.6 && freeAt > bestFree) {
                bestFree = freeAt
                bestLane = index
              }
            }
            if (lane < 0 && bestFree >= 0) lane = bestLane
            if (lane >= 0) {
              state.active.push({
                item,
                lane,
                x: width,
                width: textWidth,
                spawnAt: videoTime,
                duration: scrollDuration,
              })
            }
          } else {
            // top/bottom:该模式同 lane 同时最多一条
            const modeLaneBase = item.mode === 'top' ? 0 : Math.floor(laneCount / 2)
            const modeLaneCount = Math.floor(laneCount / 2)
            let lane = -1
            for (let offset = 0; offset < modeLaneCount; offset += 1) {
              const candidate = (modeLaneBase + offset) % laneCount
              const occupant = state.active.find(
                (active) => active.lane === candidate && active.item.mode === item.mode,
              )
              if (!occupant || videoTime - occupant.spawnAt > 4.2) {
                lane = candidate
                break
              }
            }
            if (lane >= 0) {
              state.active.push({
                item,
                lane,
                x: (width - textWidth) / 2,
                width: textWidth,
                spawnAt: videoTime,
                duration: 4.5,
              })
            }
          }
          if (state.active.length > 240) {
            state.active.splice(0, state.active.length - 240)
          }
        }
      }

      // 绘制
      context.font = `bold ${fontSize}px 'PingFang SC', 'Microsoft YaHei UI', 'Microsoft YaHei', sans-serif`
      context.textBaseline = 'middle'
      const nextActive: ActiveDanmaku[] = []
      for (const active of state.active) {
        if (isPlaying && active.item.mode === 'scroll') {
          active.x -= (dt * (width + active.width)) / active.duration
        }
        const age = videoTime - active.spawnAt
        if (active.item.mode !== 'scroll' && age > active.duration) continue
        if (active.item.mode === 'scroll' && active.x + active.width < -20) continue
        const y = active.lane * laneHeight + laneHeight / 2 + height * 0.04
        context.globalAlpha = 0.88
        context.shadowColor = 'rgba(0, 0, 0, 0.8)'
        context.shadowBlur = 4
        context.fillStyle = /^#[0-9a-fA-F]{6}$/.test(active.item.color)
          ? active.item.color
          : '#ffffff'
        context.fillText(active.item.text, active.x, y)
        context.shadowBlur = 0
        context.globalAlpha = 1
        nextActive.push(active)
      }
      state.active = nextActive
    }
    stateRef.current.raf = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(stateRef.current.raf)
      observer.disconnect()
    }
  }, [enabled])

  if (!enabled) return null
  return (
    <canvas
      ref={canvasRef}
      className="danmaku-layer"
      aria-hidden
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 2 }}
    />
  )
}
