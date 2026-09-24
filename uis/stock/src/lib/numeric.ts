/**
 * Reading and rendering one `<input type="number">`.
 *
 * Vue's `vModelText` runs `looseToNumber` over a number input's value before it
 * reaches the model, so a setter receives a `number` for anything numeric and a
 * `string` only when the field is empty or unparseable. Both shapes are handled
 * here — the component must never assume it was handed a string.
 */

/** What a `number | null` model should display; `NaN` reads as "invalid, blank". */
export function numberText(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value))
    return ''
  return String(value)
}

/**
 * The model value for what an input reported. An emptied field is `null` when
 * the field is nullable, and `NaN` when it is not, so a required field left
 * blank reads as invalid rather than silently becoming 0.
 */
export function readNumber(raw: unknown, nullable: boolean): number | null {
  const text = String(raw ?? '').trim()
  if (text.length === 0)
    return nullable ? null : Number.NaN
  const parsed = Number(text)
  return Number.isNaN(parsed) ? Number.NaN : parsed
}
