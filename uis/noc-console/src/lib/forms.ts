import { clonePlain } from '@shared/clone'
import { readSeconds } from '@shared/ui-format'

/** Moved to `src/shared` so both UIs' server forms read the same repair and the same guard. */
export { repairNumbers } from '@shared/form-repair'
export { isLiveConfigChange } from '@shared/server-form'
/**
 * An independent copy, so a snapshot can never alias the live state it is compared against.
 *
 * `clonePlain` rather than `JSON.parse(JSON.stringify(...))`: that dropped `undefined` members and
 * flattened a `Date`, and it was the third copy of "detach this form data".
 */
export function detachConfig<T>(config: T): T {
  return clonePlain(config)
}

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
