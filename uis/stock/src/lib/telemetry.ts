/**
 * Chart helpers over the sample history. The history itself is built by the shared live store
 * (`@shared/live-series`): one ring per server, capped at `SERIES_CAPACITY` points.
 */
export type { ServerSeries } from '@shared/live-series'

export const SERIES_CAPACITY = 120

export function seriesMax(values: (number | null)[]): number {
  let max = 0
  for (const value of values) {
    if (value !== null && value > max)
      max = value
  }
  return max
}

export function seriesLast(values: (number | null)[]): number | null {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    const value = values[i]
    if (value !== undefined && value !== null)
      return value
  }
  return null
}
