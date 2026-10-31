import { useI18n } from '../i18n'
import { cx } from '../lib'

interface RoomSwitchProps {
  on: boolean
  onToggle: () => void
}

export default function RoomSwitch({ on, onToggle }: RoomSwitchProps) {
  const { t } = useI18n()
  return (
    <button
      className={cx('room-switch', on && 'is-on')}
      role="switch"
      aria-checked={on}
      aria-label={t('room.lighting')}
      title={on ? t('room.dim') : t('room.bright')}
      onClick={onToggle}
    >
      <span className="room-switch-knob" />
    </button>
  )
}
