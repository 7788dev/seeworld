import { ChevronDown, RotateCcw } from 'lucide-react'
import type { ExploreSort, ExploreValues } from '../douban'
import type { FilterConfig } from '../filters'
import { useI18n } from '../i18n'

interface FilterBarProps {
  config: FilterConfig
  value: ExploreValues
  active: boolean
  onChange: (next: ExploreValues) => void
  onReset: () => void
}

interface SelectOption {
  value: string
  label: string
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: SelectOption[]
  onChange: (next: string) => void
}) {
  return (
    <label className="filter-field">
      <span>{label}</span>
      <span className="filter-select-wrap">
        <select value={value} onChange={(event) => onChange(event.target.value)}>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDown size={13} aria-hidden />
      </span>
    </label>
  )
}

export default function FilterBar({
  config,
  value,
  active,
  onChange,
  onReset,
}: FilterBarProps) {
  const { t } = useI18n()
  const all = t('filter.all')
  const withAll = (options: string[]): SelectOption[] => [
    { value: '', label: all },
    ...options.map((option) => ({ value: option, label: option })),
  ]
  const ratingOptions: SelectOption[] = [
    { value: '0', label: t('filter.ratingAny') },
    ...[9, 8, 7, 6].map((rating) => ({
      value: String(rating),
      label: `${rating}.0+`,
    })),
  ]

  return (
    <div className="explore-filters" role="group" aria-label={t('filter.aria')}>
      {config.forms && (
        <FilterSelect
          label={t('filter.format')}
          value={value.form}
          options={config.forms.map((form) => ({
            value: form.value,
            label: t(form.labelKey),
          }))}
          onChange={(form) => onChange({ ...value, form })}
        />
      )}

      <FilterSelect
        label={t('filter.genre')}
        value={value.genre}
        options={withAll(config.genres)}
        onChange={(genre) => onChange({ ...value, genre })}
      />
      <FilterSelect
        label={t('filter.region')}
        value={value.region}
        options={withAll(config.regions)}
        onChange={(region) => onChange({ ...value, region })}
      />
      <FilterSelect
        label={t('filter.year')}
        value={value.year}
        options={withAll(config.years)}
        onChange={(year) => onChange({ ...value, year })}
      />
      <FilterSelect
        label={t('filter.rating')}
        value={String(value.minRating)}
        options={ratingOptions}
        onChange={(rating) => onChange({ ...value, minRating: Number(rating) })}
      />
      <FilterSelect
        label={t('filter.sort')}
        value={value.sort}
        options={config.sorts.map((sort) => ({
          value: sort.value,
          label: t(sort.labelKey),
        }))}
        onChange={(sort) => onChange({ ...value, sort: sort as ExploreSort })}
      />

      {active && (
        <button type="button" className="filter-reset" onClick={onReset}>
          <RotateCcw size={13} aria-hidden />
          {t('filter.reset')}
        </button>
      )}
    </div>
  )
}
