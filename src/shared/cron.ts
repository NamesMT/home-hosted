/**
 * A 5-field cron expression, parsed once and asked two questions: is it due now, and when does it
 * next run.
 *
 * **Five fields only, and the host's local timezone.** `minute hour day-of-month month
 * day-of-week`, no seconds field and no `@reboot`/`@daily` macros: a 6-field expression accepted as
 * 5 would run on a schedule nobody typed (the leading field read as minutes), and a macro is a
 * different language. Both are refused by name in the message.
 *
 * Reading the wall clock in the host's own zone is deliberate. This panel runs on a home server
 * whose owner thinks in that machine's time ("every night at 03:00"), and a job that silently
 * shifted by an hour after a DST change would be worse than one documented as local.
 *
 * **Daylight saving, measured rather than assumed** (`TZ=Europe/Berlin`, 2026 transitions):
 * - a local time that does not exist — 02:30 on the spring-forward day — is **skipped for that day**.
 *   `nextCronRun('30 2 * * *', 2026-03-28T23:00)` answers 2026-03-30T02:30, and `cronDueAt` is false
 *   at 01:59 and 03:00 alike. This matches Vixie cron, and firing at an arbitrary instant once a
 *   year would be worse than missing one run;
 * - a local time that occurs **twice** — 02:30 on the autumn day — runs on the **first** only, which
 *   is what the search naturally finds: it stops at the first matching wall-clock minute, and the
 *   second 02:30 is an hour of real time later.
 *
 * An earlier version of this comment claimed the spring-forward case "runs at the instant the clock
 * jumps past it". It never did. The comment was wrong, not the code.
 *
 * No date library: the module is imported by both the panel and the UIs (the preview under the
 * schedule field), so it may not reach for `node:` or a dependency.
 */

/** The numbers one expression selects, as sets — membership is what every question asks. */
export interface CronSpec {
  minutes: Set<number>
  hours: Set<number>
  daysOfMonth: Set<number>
  months: Set<number>
  /** `0` and `7` both mean Sunday, so both are in here. */
  daysOfWeek: Set<number>
  /**
   * Vixie cron's rule: when **both** day fields are restricted, a day matching *either* is due
   * (`0 0 1 * 1` = the 1st of the month *and* every Monday). When only one is restricted the other
   * is a wildcard and the match is an ordinary AND.
   */
  domRestricted: boolean
  dowRestricted: boolean
}

export type CronParse
  = | { ok: true, spec: CronSpec }
    | { ok: false, problem: string }

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] as const
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const

/** One field of the expression: its bounds, its names, and how the message calls it. */
interface FieldSpec {
  label: string
  min: number
  max: number
  names?: readonly string[]
  /** How a name maps to a number: month names are 1-based, weekday names 0-based. */
  nameBase?: number
}

const FIELDS: readonly FieldSpec[] = [
  { label: 'minute', min: 0, max: 59 },
  { label: 'hour', min: 0, max: 23 },
  { label: 'day-of-month', min: 1, max: 31 },
  { label: 'month', min: 1, max: 12, names: MONTH_NAMES, nameBase: 1 },
  { label: 'day-of-week', min: 0, max: 7, names: DAY_NAMES, nameBase: 0 },
]

const FIELD_COUNT_MESSAGE = 'a cron expression has 5 fields (minute hour day-of-month month day-of-week) — seconds and @macros are not supported'

/** A single number, a name, or `a-b` — the part a `/step` may follow. */
function parseAtom(text: string, field: FieldSpec, raw: string): { value: number } | { problem: string } {
  const lower = text.toLowerCase()
  // `indexOf` answers -1 for a name this field does not know, and -1 is a number: reading it as
  // "the first name minus one" turned every numeric month into a month that does not exist.
  const named = field.names === undefined ? -1 : (field.names as readonly string[]).indexOf(lower)
  if (named >= 0) {
    const value = field.nameBase === 1 ? named + 1 : named
    return { value }
  }
  // A name this field does not know is a typo, not a number: say which names exist.
  if (/^[a-z]+$/.test(lower)) {
    return {
      problem: field.names === undefined
        ? `${field.label} does not take a name (was "${text}")`
        : `${field.label}: "${text}" is not one of ${field.names.join(', ')}`,
    }
  }
  if (!/^\d+$/.test(text))
    return { problem: `${field.label}: "${text}" is not a number, a name, a range or a step` }
  const value = Number(text)
  if (value < field.min || value > field.max)
    return { problem: `${field.label} must be between ${field.min} and ${field.max} (was "${text}" in "${raw}")` }
  return { value }
}

/** One comma-separated part: `*`, `n`, `a-b`, each with an optional `/step`. */
function parsePart(part: string, field: FieldSpec, raw: string): { values: number[] } | { problem: string } {
  const [rangeText, stepText, ...rest] = part.split('/')
  if (rest.length > 0)
    return { problem: `${field.label}: "${part}" has more than one step` }

  let step = 1
  if (stepText !== undefined) {
    if (!/^\d+$/.test(stepText))
      return { problem: `${field.label}: the step in "${part}" must be a whole number` }
    // `*/0` never comes due in any cron, and refusing it is the only answer that is not a silent
    // schedule that never runs.
    if (Number(stepText) < 1)
      return { problem: `${field.label}: the step in "${part}" must be at least 1` }
    step = Number(stepText)
  }

  const values: number[] = []
  if (rangeText === '*') {
    for (let value = field.min; value <= field.max; value += step) values.push(value)
    return { values }
  }

  const bounds = rangeText!.split('-')
  if (bounds.length > 2)
    return { problem: `${field.label}: "${part}" is not a range` }
  const low = parseAtom(bounds[0]!, field, raw)
  if ('problem' in low)
    return low
  // `n/step` is `n-max/step` — GNU cron's reading of a bare number with a step, and the only one
  // that makes `5/20` mean anything (05, 25, 45) rather than the single minute 5.
  const high = bounds.length === 1
    ? (stepText === undefined ? low : { value: field.max })
    : parseAtom(bounds[1]!, field, raw)
  if ('problem' in high)
    return high
  if (high.value < low.value)
    return { problem: `${field.label}: the range "${part}" counts backwards (${low.value} to ${high.value})` }
  // A plain number with a step is `n-max/step`, the spelling cron accepts.
  for (let value = low.value; value <= high.value; value += step) values.push(value)
  return { values }
}

function parseField(text: string, field: FieldSpec): { values: Set<number> } | { problem: string } {
  const values = new Set<number>()
  for (const part of text.split(',')) {
    if (part.length === 0)
      return { problem: `${field.label}: "${text}" has an empty element between commas` }
    const parsed = parsePart(part, field, text)
    if ('problem' in parsed)
      return parsed
    for (const value of parsed.values) values.add(value)
  }
  // `7` is Sunday as well as `0`, and a set carrying both would make "next Sunday" ambiguous.
  if (field.label === 'day-of-week' && values.has(7)) {
    values.delete(7)
    values.add(0)
  }
  return { values }
}

/** Parses an expression, or says what is wrong with it in the terms the person typed. */
export function parseCron(expression: string): CronParse {
  const trimmed = expression.trim()
  if (trimmed.length === 0)
    return { ok: false, problem: 'the schedule is empty — a cron expression looks like "0 3 * * *"' }
  if (trimmed.startsWith('@'))
    return { ok: false, problem: `"${trimmed}" is a cron macro, and this release supports 5-field expressions only (e.g. "0 3 * * *")` }

  const fields = trimmed.split(/\s+/)
  if (fields.length !== 5) {
    return {
      ok: false,
      problem: `${FIELD_COUNT_MESSAGE}; "${trimmed}" has ${fields.length}`,
    }
  }

  const sets: Array<Set<number>> = []
  for (const [index, field] of FIELDS.entries()) {
    const parsed = parseField(fields[index]!, field)
    if ('problem' in parsed)
      return { ok: false, problem: parsed.problem }
    sets.push(parsed.values)
  }

  return {
    ok: true,
    spec: {
      minutes: sets[0]!,
      hours: sets[1]!,
      daysOfMonth: sets[2]!,
      months: sets[3]!,
      daysOfWeek: sets[4]!,
      domRestricted: fields[2] !== '*',
      dowRestricted: fields[4] !== '*',
    },
  }
}

/** What is wrong with a schedule, or `null` when it parses. The form and the store both ask this. */
export function cronProblem(expression: string): string | null {
  const parsed = parseCron(expression)
  return parsed.ok ? null : parsed.problem
}

/**
 * Whether a local time matches the day and time fields.
 *
 * The OR between the two day fields is Vixie cron's, and it is what a person writing `0 0 1 * 1`
 * expects: first of the month, or Monday.
 */
function dayMatches(spec: CronSpec, date: Date): boolean {
  const dom = spec.daysOfMonth.has(date.getDate())
  const dow = spec.daysOfWeek.has(date.getDay())
  if (spec.domRestricted && spec.dowRestricted)
    return dom || dow
  return dom && dow
}

/** Whether this minute is one the expression selects (seconds ignored — a minute is the unit). */
export function cronDueAt(spec: CronSpec, date: Date): boolean {
  return spec.minutes.has(date.getMinutes())
    && spec.hours.has(date.getHours())
    && spec.months.has(date.getMonth() + 1)
    && dayMatches(spec, date)
}

/** One step of the search: the next local minute, hour, day or month boundary that could match. */
function advance(candidate: Date, unit: 'minute' | 'hour' | 'day' | 'month'): Date {
  const next = new Date(candidate.getTime())
  switch (unit) {
    case 'minute':
      next.setMinutes(next.getMinutes() + 1, 0, 0)
      break
    case 'hour':
      next.setHours(next.getHours() + 1, 0, 0, 0)
      break
    case 'day':
      next.setHours(0, 0, 0, 0)
      next.setDate(next.getDate() + 1)
      break
    case 'month':
      next.setHours(0, 0, 0, 0)
      next.setDate(1)
      next.setMonth(next.getMonth() + 1)
      break
  }
  return next
}

/** How far ahead the search looks before answering "never". Four years covers a leap day. */
const SEARCH_LIMIT_MS = 4 * 366 * 24 * 60 * 60 * 1000

/**
 * The first minute strictly after `from` that the expression selects, in the host's local timezone,
 * or `null` when it names a day that cannot occur (29 February in a century year, `31` in April).
 *
 * Strictly after, because the caller has just handled that minute: reporting it again would run a
 * job twice for one occurrence. The search jumps by whole months/days/hours rather than crawling a
 * minute at a time, so an expression like `0 0 29 2 *` costs a few hundred steps, not millions.
 */
export function nextCronRun(spec: CronSpec, from: Date = new Date()): number | null {
  const limit = from.getTime() + SEARCH_LIMIT_MS
  // Start at the next whole minute: `from` itself belongs to whoever asked.
  let candidate = advance(from, 'minute')
  while (candidate.getTime() <= limit) {
    if (!spec.months.has(candidate.getMonth() + 1)) {
      candidate = advance(candidate, 'month')
      continue
    }
    if (!dayMatches(spec, candidate)) {
      candidate = advance(candidate, 'day')
      continue
    }
    if (!spec.hours.has(candidate.getHours())) {
      candidate = advance(candidate, 'hour')
      continue
    }
    if (!spec.minutes.has(candidate.getMinutes())) {
      candidate = advance(candidate, 'minute')
      continue
    }
    return candidate.getTime()
  }
  return null
}

/**
 * The last minute at or before `at` that the expression selects, or `null`.
 *
 * This is the scheduler's "which occurrence is due now": one cron tick must not depend on how often
 * the panel's clock ticks, so the panel asks for the occurrence, not the second.
 */
export function previousCronRun(spec: CronSpec, at: Date = new Date()): number | null {
  const limit = at.getTime() - SEARCH_LIMIT_MS
  let candidate = new Date(at.getTime())
  candidate.setSeconds(0, 0)
  while (candidate.getTime() >= limit) {
    if (!spec.months.has(candidate.getMonth() + 1)) {
      // The last minute of the previous month.
      candidate.setDate(1)
      candidate.setHours(0, 0, 0, 0)
      candidate = new Date(candidate.getTime() - 60_000)
      continue
    }
    if (!dayMatches(spec, candidate)) {
      candidate.setHours(0, 0, 0, 0)
      candidate = new Date(candidate.getTime() - 60_000)
      continue
    }
    if (!spec.hours.has(candidate.getHours())) {
      candidate.setMinutes(0, 0, 0)
      candidate = new Date(candidate.getTime() - 60_000)
      continue
    }
    if (!spec.minutes.has(candidate.getMinutes())) {
      candidate = new Date(candidate.getTime() - 60_000)
      continue
    }
    return candidate.getTime()
  }
  return null
}

/**
 * What a schedule says in a form a UI can put into words.
 *
 * The words are **not** here: `src/shared` may not import a UI's i18n, and a panel-formatted sentence
 * is one a UI cannot translate. A UI reads this descriptor and looks up its own strings, so "every
 * day at 03:00" is written in each language instead of sent as English.
 */
export type CronSummary
  = | { kind: 'custom' }
  /** An every-n-minutes step with every other field wild. */
    | { kind: 'everyMinutes', minutes: number }
  /** `m * * * *`. */
    | { kind: 'hourly', minute: number }
  /** `m h * * *`. */
    | { kind: 'daily', hour: number, minute: number }
  /** `m h * * w[,w…]`. */
    | { kind: 'weekly', days: number[], hour: number, minute: number }
  /** `m h d * *`. */
    | { kind: 'monthly', day: number, hour: number, minute: number }

const ALL_MINUTES = 60
const ALL_HOURS = 24
const ALL_DAYS = 31
const ALL_MONTHS = 12
const ALL_WEEKDAYS = 7

function single(set: Set<number>): number | null {
  return set.size === 1 ? [...set][0]! : null
}

/** The step of an arithmetic set starting at `start` and running to the field's end, or null. */
function stepOf(set: Set<number>, start: number, size: number): number | null {
  const sorted = [...set].sort((a, b) => a - b)
  if (sorted.length < 2 || sorted[0] !== start)
    return null
  const step = sorted[1]! - sorted[0]!
  if (step < 1)
    return null
  for (const [index, value] of sorted.entries()) {
    if (value !== start + index * step)
      return null
  }
  // The shape too, not only the spacing: `0-58` is arithmetic but does not reach the end of the
  // field, and calling it "every n minutes" would promise runs the expression never has.
  return sorted[sorted.length - 1]! + step >= size ? step : null
}

/** The descriptor a UI turns into a sentence. Falls back to `custom` rather than approximating. */
export function cronSummary(spec: CronSpec): CronSummary {
  const minute = single(spec.minutes)
  const hour = single(spec.hours)
  const day = single(spec.daysOfMonth)
  const everyMinute = stepOf(spec.minutes, 0, ALL_MINUTES)
  const monthWide = spec.months.size === ALL_MONTHS
  const hourWide = spec.hours.size === ALL_HOURS
  const dayWide = !spec.domRestricted && spec.daysOfMonth.size === ALL_DAYS
  const weekdayWide = !spec.dowRestricted && spec.daysOfWeek.size === ALL_WEEKDAYS

  // An every-n-minutes step, one included: the same sentence with a step of one.
  if (everyMinute !== null && hourWide && dayWide && weekdayWide && monthWide)
    return { kind: 'everyMinutes', minutes: everyMinute }
  if (minute !== null && hourWide && dayWide && weekdayWide && monthWide)
    return { kind: 'hourly', minute }
  if (minute === null && spec.minutes.size === ALL_MINUTES && hourWide && dayWide && weekdayWide && monthWide)
    return { kind: 'everyMinutes', minutes: 1 }
  if (minute !== null && hour !== null && dayWide && weekdayWide && monthWide)
    return { kind: 'daily', hour, minute }
  if (minute !== null && hour !== null && dayWide && !weekdayWide && monthWide && spec.daysOfWeek.size > 0)
    return { kind: 'weekly', days: [...spec.daysOfWeek].sort((a, b) => a - b), hour, minute }
  if (minute !== null && hour !== null && day !== null && spec.domRestricted && weekdayWide && monthWide)
    return { kind: 'monthly', day, hour, minute }
  return { kind: 'custom' }
}

/** `03:04`, zero-padded — the clock part a caller puts into its own sentence. */
export function cronClock(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}
