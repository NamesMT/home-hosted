import type { CpuBand } from '@shared/cpu-scale'
import type { ProbeBand } from '@shared/probe-latency'

/**
 * The ways this UI paints a band: an SVG stroke and a `metric__v` modifier class.
 *
 * Both maps live here because the list and the detail page show the same reading, and a table of
 * colours copied into each is how they start disagreeing. `Record<…, …>` is what keeps them total: a
 * new band is a compile error here rather than a silently unstyled value.
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

/**
 * The probe latency's verdict, painted in the three vocabularies this UI has: a sparkline stroke, a
 * `metric__v` modifier on the detail tile's number, and a plain cell modifier on the list row.
 *
 * The verdict itself is `probeBand` — one function, so these maps cannot disagree about *when* a
 * reading is slow. Each is total over `ProbeBand`, so a new band is a compile error here.
 */
export const PROBE_STROKE: Record<ProbeBand, string> = {
  unknown: 'var(--dim)',
  ok: 'var(--accent)',
  warn: 'var(--warn)',
  danger: 'var(--danger)',
}

export const PROBE_VALUE_CLASS: Record<ProbeBand, string> = {
  unknown: 'metric__v--dim',
  ok: '',
  warn: 'metric__v--warn',
  danger: 'metric__v--danger',
}

/** The list row's own vocabulary: `warn`/`danger` colour a `td`, and `faint` marks no reading. */
export const PROBE_CELL_CLASS: Record<ProbeBand, string> = {
  unknown: 'faint',
  ok: '',
  warn: 'warn',
  danger: 'danger',
}
