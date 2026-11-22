/**
 * The log shapes: buffered lines, the on-disk history with its rotation and search window, and what a
 * page needs to explain an empty answer.
 *
 * A server's log and a job's log share a shape because they obey the same rule — `enabled` is the
 * workspace's `logs.persist`, and a page must say "nothing kept" rather than "nothing printed".
 */
import { type } from 'arktype'
import { logLineSchema, serverStatusSchema } from '../contracts'
import { lazy } from '../lazy'
import { integerParam } from '../query-params'

/** `GET /api/servers/:id/logs` — the buffered lines, straight from memory: no window, no rotation. */
export const bufferedLogsResponseSchema = lazy(() => type({
  lines: logLineSchema.array(),
}))

/**
 * One job's own log lines, plus what the page needs to explain an empty answer: `enabled` is the
 * workspace's `logs.persist`, and a page must say "nothing kept" rather than "nothing printed".
 */
export const jobLogViewSchema = lazy(() => type({
  jobId: 'string',
  enabled: 'boolean',
  sizeBytes: 'number',
  files: 'string[]',
  lines: logLineSchema.array(),
}))
export type JobLogView = typeof jobLogViewSchema.infer

export const logLinesResponseSchema = lazy(() => type({
  serverId: 'string',
  enabled: 'boolean',
  sizeBytes: 'number',
  /** The rotated files this entry has, newest first. */
  files: 'string[]',
  /** How many lines the search looked at, or null when the request carried no `search`. */
  searched: 'number | null',
  lines: logLineSchema.array(),
}))

export const logHistoryQuerySchema = lazy(() => type({
  /**
   * How many lines to show: a whole number, 50–5000.
   *
   * Both bounds are the route's own (`MIN_TAIL`/`MAX_TAIL` in `src/api/logs.ts`) and a value outside
   * them is a `400`, not a silent clamp — `tail=3` used to be raised to 50 and `tail=abc` fell back
   * to the default, so a typo changed what a page reported it had searched.
   */
  'tail?': integerParam(50, 5000),
  /**
   * Case-insensitive substring filter. Both this and `stream` are filters, so the route reads a
   * wider window than `tail` and applies them to that: filtering only the display tail would
   * report an older match as "no results", and "the last N stderr lines" as whatever happened
   * to fall in a window sized for all streams. `searched` reports how many lines were read.
   */
  'search': 'string?',
  'stream': '"stdout" | "stderr" | "system"?',
  /**
   * Return the lines **after** this cursor, for a client that keeps one and polls forward.
   *
   * A cursor is a line's `ts` — the one identity a log line has across a rotation, and what the SSE
   * `log` frames already carry per line. `since` and `before` are the two halves of one window: a
   * caller that names neither gets the tail, as it always did.
   *
   * A negative cursor is refused at the boundary rather than clamped to zero: it names nothing, and
   * silently reading it as "from the beginning" would answer a question the caller did not ask.
   */
  'since?': integerParam(0, 9_999_999_999_999),
  /** Return the lines **before** this cursor — the other direction, for backfill. */
  'before?': integerParam(0, 9_999_999_999_999),
}))

const logFileInfoSchema = lazy(() => type({
  name: 'string',
  sizeBytes: 'number',
}))

const logServerViewSchema = lazy(() => type({
  serverId: 'string',
  label: 'string',
  status: serverStatusSchema,
  enabled: 'boolean',
  sizeBytes: 'number',
  files: logFileInfoSchema.array(),
}))
export type LogServerView = typeof logServerViewSchema.infer

export const logServersViewSchema = lazy(() => type({
  servers: logServerViewSchema.array(),
}))

/** One entry's log **from disk**, with its rotation and search window — the shape the UIs parse. */
export const logHistoryViewSchema = lazy(() => type({
  serverId: 'string',
  enabled: 'boolean',
  sizeBytes: 'number',
  files: type('string[]'),
  /** How many lines the search looked at, or null when not searching. */
  searched: 'number | null',
  lines: logLineSchema.array(),
}))
export type LogHistoryView = typeof logHistoryViewSchema.infer
