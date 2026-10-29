import type { CpuBand } from '@shared/cpu-scale'

/**
 * The two ways this UI paints a `CpuBand`: an SVG stroke and a `metric__v` modifier class.
 *
 * Both maps live here because the list and the detail page show the same reading, and a table of
 * colours copied into each is how they start disagreeing. `Record<CpuBand, …>` is what keeps them
 * total: a new band is a compile error here rather than a silently unstyled value.
 */

/** The sparkline's stroke. An absent reading is dim, never accent — it is not a healthy zero. */
export const CPU_STROKE: Record<CpuBand, string> = {
  unknown: 'var(--dim)',
  ok: 'var(--accent)',
  warn: 'var(--warn)',
  danger: 'var(--danger)',
}

/** The number's own colour, beside it. `ok` is the default text colour, so it adds no class. */
export const CPU_VALUE_CLASS: Record<CpuBand, string> = {
  unknown: 'metric__v--dim',
  ok: '',
  warn: 'metric__v--warn',
  danger: 'metric__v--danger',
}
