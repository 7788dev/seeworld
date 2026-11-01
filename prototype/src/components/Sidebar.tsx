import { useRef } from 'react'
import {
  Bookmark,
  Clapperboard,
  Clock3,
  Flame,
  Home,
  Plus,
  Search,
  Settings,
  Sparkles,
  Tv,
  X,
} from 'lucide-react'
import type { ViewKey } from '../data'
import { useI18n } from '../i18n'
import { cx } from '../lib'
import { useFocusTrap } from '../useFocusTrap'

interface SidebarProps {
  active: ViewKey
  query: string
  open: boolean
  composing: boolean
  onNavigate: (view: ViewKey) => void
  onQuery: (query: string) => void
  onCompositionChange: (composing: boolean) => void
  onClose: () => void
}

const browseItems = [
  { key: 'home' as const, labelKey: 'nav.home' as const, icon: Home },
  { key: 'new' as const, labelKey: 'nav.new' as const, icon: Flame },
  { key: 'tv' as const, labelKey: 'nav.tv' as const, icon: Tv },
  { key: 'movies' as const, labelKey: 'nav.movies' as const, icon: Clapperboard },
  { key: 'anime' as const, labelKey: 'nav.anime' as const, icon: Sparkles },
  { key: 'my-list' as const, labelKey: 'nav.myList' as const, icon: Plus },
]

const libraryItems = [
  { key: 'recent' as const, labelKey: 'nav.recent' as const, icon: Clock3 },
  { key: 'later' as const, labelKey: 'nav.later' as const, icon: Bookmark },
  { key: 'settings' as const, labelKey: 'nav.settings' as const, icon: Settings },
]

export default function Sidebar({
  active,
  query,
  open,
  composing,
  onNavigate,
  onQuery,
  onCompositionChange,
  onClose,
}: SidebarProps) {
  const { t } = useI18n()
  const sidebarRef = useRef<HTMLElement>(null)
  useFocusTrap(sidebarRef, open)

  const select = (key: ViewKey) => {
    onNavigate(key)
    onClose()
  }

  return (
    <>
      <button
        className={cx('drawer-scrim', open && 'is-visible')}
        aria-label={t('nav.close')}
        tabIndex={open ? 0 : -1}
        onClick={onClose}
      />
      <aside className={cx('sidebar', open && 'is-open')} ref={sidebarRef}>
        <button className="sidebar-close" aria-label={t('nav.close')} onClick={onClose}>
          <X size={18} />
        </button>

        <button className="logo" aria-label={t('nav.brandHome')} onClick={() => select('home')}>
          SEEWORLD
        </button>

        <label className="search-field">
          <Search size={15} strokeWidth={1.9} aria-hidden />
          <input
            className="search-input"
            type="text"
            placeholder={t('search.placeholder')}
            aria-label={t('search.aria')}
            value={query}
            aria-busy={composing}
            onChange={(event) => onQuery(event.target.value)}
            onCompositionStart={() => onCompositionChange(true)}
            onCompositionEnd={() => onCompositionChange(false)}
          />
          {query && (
            <button
              className="search-clear"
              type="button"
              aria-label={t('search.clear')}
              onClick={() => onQuery('')}
            >
              <X size={13} />
            </button>
          )}
        </label>

        <nav className="side-nav" aria-label={t('nav.browseAria')}>
          <p className="nav-label">{t('nav.groupBrowse')}</p>
          <ul>
            {browseItems.map(({ key, labelKey, icon: Icon }) => (
              <li key={key}>
                <button
                  className={cx('nav-item', active === key && !query && 'is-active')}
                  aria-current={active === key && !query ? 'page' : undefined}
                  onClick={() => select(key)}
                >
                  <Icon size={18} strokeWidth={1.65} aria-hidden />
                  <span>{t(labelKey)}</span>
                </button>
              </li>
            ))}
          </ul>

          <p className="nav-label nav-label--library">{t('nav.groupLibrary')}</p>
          <ul>
            {libraryItems.map(({ key, labelKey, icon: Icon }) => (
              <li key={key}>
                <button
                  className={cx('nav-item', active === key && !query && 'is-active')}
                  aria-current={active === key && !query ? 'page' : undefined}
                  onClick={() => select(key)}
                >
                  <Icon size={18} strokeWidth={1.65} aria-hidden />
                  <span>{t(labelKey)}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
      </aside>
    </>
  )
}