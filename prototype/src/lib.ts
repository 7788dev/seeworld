import { useCallback, useEffect, useRef, useState } from 'react'
import type { SyntheticEvent } from 'react'

export const cx = (...parts: Array<string | false | null | undefined>) =>
  parts.filter(Boolean).join(' ')

export const isPortraitImage = (image: HTMLImageElement) =>
  image.naturalWidth > 0 && image.naturalHeight > image.naturalWidth * 1.1

export const isDesktopApp =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export const parseRuntime = (value?: string) => {
  if (!value) return undefined
  const hours = /(\d+)\s*h/.exec(value)?.[1]
  const minutes = /(\d+)\s*m/.exec(value)?.[1]
  if (!hours && !minutes) return undefined
  return Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60
}

export function usePersistentState<T>(
  key: string,
  initial: T,
  normalize?: (value: unknown) => T,
  options: { debounceMs?: number } = {},
) {
  const debounceMs = options.debounceMs ?? 0
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key)
      if (!stored) return initial
      const parsed: unknown = JSON.parse(stored)
      return normalize ? normalize(parsed) : (parsed as T)
    } catch {
      return initial
    }
  })

  const valueRef = useRef(value)
  valueRef.current = value

  const write = useCallback(
    (next: T) => {
      try {
        localStorage.setItem(key, JSON.stringify(next))
      } catch {
        // storage can be unavailable in private browsing / quota can be exceeded
        if (typeof window !== 'undefined') {
          window.dispatchEvent(
            new CustomEvent('jj-storage-error', { detail: { key } }),
          )
        }
      }
    },
    [key],
  )

  useEffect(() => {
    // 高频值（音量滑块、播放进度）不必每帧写盘：防抖后写一次。
    if (debounceMs <= 0) {
      write(value)
      return
    }
    const timer = window.setTimeout(() => write(valueRef.current), debounceMs)
    return () => window.clearTimeout(timer)
  }, [debounceMs, value, write])

  // 卸载时补写尚未落盘的防抖值，避免"拖到 40% 直接关播放器"丢设置。
  useEffect(() => () => write(valueRef.current), [write])

  return [value, setValue] as const
}

// 源站简介常带 <p>/<br/> 等 HTML 标签,展示前统一清洗。
export const stripHtml = (value: string) =>
  value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()

export const percentage = (current: number, duration: number) =>
  Math.min(100, Math.max(0, duration > 0 ? (current / duration) * 100 : 0))

export const FINISHED_EPSILON_SEC = 5

export const isProgressFinished = (current: number, duration: number) =>
  duration > 0 && current >= duration - FINISHED_EPSILON_SEC

/**
 * 海报兜底：豆瓣图床与 CMS 源图经常 404/防盗链。
 * 加载失败时摘掉 src 并打上 is-image-failed，由 CSS 给一层同色系渐变，
 * 避免整屏黑块和浏览器默认的裂图图标。
 */
export const onImageError = (event: SyntheticEvent<HTMLImageElement>) => {
  const image = event.currentTarget
  if (image.dataset.fallback === '1') return
  image.dataset.fallback = '1'
  image.classList.add('is-image-failed')
  image.removeAttribute('src')
}
