/**
 * Repairs a form whose numeric boxes were emptied before it is diffed against live config.
 *
 * `v-model.number` writes an empty **string** when an `<input type="number">` is cleared —
 * not a number and not `null`. The value then travels into the patch, and the patch schema
 * validates the *whole* body before it is sent, so clearing one box refused an entire save
 * with a raw "must be a number (was a string)" and no field hint. Clearing a box to retype a
 * value is ordinary, and there are 31 such inputs across the views.
 *
 * A cleared box means "I have not decided anything here", which for a schema-required number
 * is the value already on the panel — so fall back to it, and the field simply drops out of
 * the diff. Repairing centrally is deliberate: the alternative is 31 bindings each needing
 * its own guard, and a new field silently re-opens the bug.
 */

/** A box this helper understands as "emptied": the string a cleared number input reports. */
function isEmptied(value: unknown): boolean {
  return value === '' || value === null || value === undefined || (typeof value === 'number' && Number.isNaN(value))
}

/**
 * Copies `current` over any emptied or non-finite number in `next`, in place, recursing into
 * nested groups and objects. Non-numeric values (`''` for a text field, a boolean, a list)
 * are left exactly as they are — only a slot the live config holds a number in is repaired.
 */
export function repairNumbers<T extends Record<string, unknown>>(next: T, current: Record<string, unknown>): T {
  for (const [key, value] of Object.entries(next)) {
    const live = current[key]

    // A field the live config has no counterpart for is left alone: there is nothing to
    // fall back to, and it is not this helper's job to invent one.
    if (live === undefined)
      continue

    if (isEmptied(value)) {
      if (typeof live === 'number' && Number.isFinite(live))
        (next as Record<string, unknown>)[key] = live
      continue
    }

    if (Array.isArray(value)) {
      // A list of objects (DDNS domains) is repaired element-wise against the live one.
      if (Array.isArray(live)) {
        for (const [index, entry] of value.entries()) {
          const liveEntry = live[index]
          if (isRecord(entry) && isRecord(liveEntry))
            repairNumbers(entry, liveEntry)
        }
      }
      continue
    }

    if (isRecord(value))
      repairNumbers(value, isRecord(live) ? live : {})
  }
  return next
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether a live config object is a genuine change from the one a form was filled from.
 *
 * Extracted from `ServerConfigView`'s watcher so it can be tested directly: that view reads
 * its config from a composable rather than a prop, so the guard had no test at all — while its
 * `uis/stock` counterpart, which does take a prop, pins both of its behaviours.
 *
 * The comparison is by value, because the control plane re-creates every config object on each
 * state frame: an identity check would call every frame a change and wipe whatever the user had
 * typed. `snapshot` must be an *independent copy* of what the form was filled from — a live
 * reference would move with the store and the guard would stop noticing real changes.
 */
export function isLiveConfigChange(next: unknown, snapshot: unknown): boolean {
  if (next === null || next === undefined)
    return false
  return JSON.stringify(next) !== JSON.stringify(snapshot ?? null)
}

/** An independent copy, so a snapshot can never alias the live state it is compared against. */
export function detachConfig<T>(config: T): T {
  return JSON.parse(JSON.stringify(config)) as T
}
