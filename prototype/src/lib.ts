import { useEffect, useState } from 'react'

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

export function usePersistentState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key)
      return stored ? (JSON.parse(stored) as T) : initial
    } catch {
      return initial
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // storage can be unavailable in private browsing
    }
  }, [key, value])

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
