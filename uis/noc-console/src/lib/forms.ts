import { readSeconds } from '@shared/ui-format'

/** Moved to `src/shared` so both UIs' server forms read the same repair and the same guard. */
export { repairNumbers } from '@shared/form-repair'
export { isLiveConfigChange } from '@shared/server-form'

/**
 * The seconds an `<input>` reports, as a number.
 *
 * A box a person cleared reports `''`, and `Number('')` is `0` — which would store "every 0
 * seconds" for a field whose floor is a minute. `NaN` is what both callers already treat as
 * "nothing decided here": `repairNumbers` restores the live value, and `requiredDdnsNumber` falls
 * back to the schema default. The read itself is shared, so both UIs answer the same way.
 */
export function secondsOf(event: Event): number {
  return readSeconds((event.target as HTMLInputElement).value)
}
