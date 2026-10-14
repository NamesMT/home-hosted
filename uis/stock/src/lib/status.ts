import type { HealthState, ServerStatus } from '@shared/contracts'

export type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral' | 'accent'

export interface StatusMeta {
  /** A catalog key, not the text: the label is read at render time, in the viewer's language. */
  labelKey: string
  tone: Tone
  /** The process is somewhere between two stable states. */
  transitional: boolean
}

export const STATUS_META: Record<ServerStatus, StatusMeta> = {
  stopped: { labelKey: 'status.stopped', tone: 'neutral', transitional: false },
  starting: { labelKey: 'status.starting', tone: 'warn', transitional: true },
  running: { labelKey: 'status.running', tone: 'ok', transitional: false },
  stopping: { labelKey: 'status.stopping', tone: 'warn', transitional: true },
  backoff: { labelKey: 'status.backoff', tone: 'warn', transitional: true },
  crashed: { labelKey: 'status.crashed', tone: 'danger', transitional: false },
  conflict: { labelKey: 'status.conflict', tone: 'danger', transitional: false },
}

export const HEALTH_META: Record<HealthState, { labelKey: string, tone: Tone }> = {
  disabled: { labelKey: 'health.disabled', tone: 'neutral' },
  unknown: { labelKey: 'health.unknown', tone: 'neutral' },
  healthy: { labelKey: 'health.healthy', tone: 'ok' },
  unhealthy: { labelKey: 'health.unhealthy', tone: 'danger' },
}

export const TONE_TEXT: Record<Tone, string> = {
  ok: 'text-ok',
  warn: 'text-warn',
  danger: 'text-danger',
  info: 'text-info',
  neutral: 'text-muted',
  accent: 'text-accent',
}

export const TONE_SURFACE: Record<Tone, string> = {
  ok: 'bg-ok-soft text-ok border-ok/25',
  warn: 'bg-warn-soft text-warn border-warn/25',
  danger: 'bg-danger-soft text-danger border-danger/25',
  info: 'bg-info-soft text-info border-info/25',
  neutral: 'bg-hover text-muted border-line',
  accent: 'bg-accent-soft text-accent border-accent/25',
}

export const TONE_DOT: Record<Tone, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-danger',
  info: 'bg-info',
  neutral: 'bg-faint',
  accent: 'bg-accent',
}

/** health first, then lifecycle: the worst signal colours the card. */
export function serverTone(status: ServerStatus, health: HealthState): Tone {
  if (status === 'crashed' || status === 'conflict')
    return 'danger'
  if (health === 'unhealthy')
    return 'danger'
  if (status === 'starting' || status === 'stopping' || status === 'backoff')
    return 'warn'
  if (status === 'running')
    return 'ok'
  return 'neutral'
}

export const HISTORY_TYPE_LABEL_KEY = {
  'start': 'history.start',
  'exit': 'history.exit',
  'crash': 'history.crash',
  'forced-restart': 'history.forcedRestart',
  'unhealthy': 'history.unhealthy',
  'recovered': 'history.recovered',
} as const

export type HistoryType = keyof typeof HISTORY_TYPE_LABEL_KEY

export const HISTORY_TYPE_TONE: Record<HistoryType, Tone> = {
  'start': 'ok',
  'exit': 'neutral',
  'crash': 'danger',
  'forced-restart': 'warn',
  'unhealthy': 'warn',
  'recovered': 'info',
}
