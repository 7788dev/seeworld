import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Copy, Minus, Square, X } from 'lucide-react'
import { useI18n } from '../i18n'

type WindowAction = 'minimize' | 'toggleMaximize' | 'close'
type ResizeDirection =
  | 'East'
  | 'North'
  | 'NorthEast'
  | 'NorthWest'
  | 'South'
  | 'SouthEast'
  | 'SouthWest'
  | 'West'

const resizeDirections: ResizeDirection[] = [
  'North',
  'South',
  'East',
  'West',
  'NorthEast',
  'NorthWest',
  'SouthEast',
  'SouthWest',
]

export default function TitleBar() {
  const { t } = useI18n()
  const [maximized, setMaximized] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)

  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('is-window-maximized', maximized)
    return () => root.classList.remove('is-window-maximized')
  }, [maximized])

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined

    void import('@tauri-apps/api/window')
      .then(async ({ getCurrentWindow }) => {
        const win = getCurrentWindow()
        const sync = async () => {
          try {
            const [isMaximized, isFullscreen] = await Promise.all([
              win.isMaximized(),
              win.isFullscreen(),
            ])
            if (!disposed) {
              setMaximized(isMaximized)
              setFullscreen(isFullscreen)
            }
          } catch {
            // the window API can be unavailable while the shell is starting
          }
        }
        await sync()
        unlisten = await win.onResized(() => void sync())
      })
      .catch(() => undefined)

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  const run = (action: WindowAction) => {
    void import('@tauri-apps/api/window')
      .then(async ({ getCurrentWindow }) => {
        const win = getCurrentWindow()
        if (action === 'minimize') {
          await win.minimize()
        } else if (action === 'close') {
          await win.close()
        } else {
          await win.toggleMaximize()
          setMaximized(await win.isMaximized())
        }
      })
      .catch(() => undefined)
  }

  const resize = (direction: ResizeDirection) => {
    void import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => getCurrentWindow().startResizeDragging(direction))
      .catch(() => undefined)
  }

  const startDrag = () => {
    void import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => getCurrentWindow().startDragging())
      .catch(() => undefined)
  }

  return (
    <>
      <header className="app-titlebar">
        <div
          className="app-titlebar__drag"
          onPointerDown={(event) => {
            if (event.button !== 0) return
            event.preventDefault()
            startDrag()
          }}
        >
          <div className="app-titlebar__brand">
            <span className="app-titlebar__mark" aria-hidden>
              S
            </span>
            <span className="app-titlebar__name">见界</span>
            <span className="app-titlebar__sub">{t('titlebar.subtitle')}</span>
          </div>
        </div>
        <div className="window-controls">
          <button
            type="button"
            className="window-control"
            aria-label={t('titlebar.minimize')}
            title={t('titlebar.minimize')}
            onClick={() => run('minimize')}
          >
            <Minus size={14} strokeWidth={1.8} />
          </button>
          <button
            type="button"
            className="window-control"
            aria-label={maximized ? t('titlebar.restore') : t('titlebar.maximize')}
            title={maximized ? t('titlebar.restore') : t('titlebar.maximize')}
            onClick={() => run('toggleMaximize')}
          >
            {maximized ? <Copy size={12} strokeWidth={1.7} /> : <Square size={12} strokeWidth={1.7} />}
          </button>
          <button
            type="button"
            className="window-control window-control--close"
            aria-label={t('titlebar.close')}
            title={t('titlebar.close')}
            onClick={() => run('close')}
          >
            <X size={15} strokeWidth={1.8} />
          </button>
        </div>
      </header>
      {!maximized &&
        !fullscreen &&
        createPortal(
          <div className="window-resize-layer" aria-hidden>
            {resizeDirections.map((direction) => (
              <div
                key={direction}
                className={`window-resize window-resize--${direction.toLowerCase()}`}
                onPointerDown={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  resize(direction)
                }}
              />
            ))}
          </div>,
          document.body,
        )}
    </>
  )
}
