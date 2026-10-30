/**
 * What a Vue template *renders*, in every shape an author writes it.
 *
 * A scan that reads only `{{ }}` matches one spelling of "on screen", not the rule. A measurement
 * handed to a component (`:value`, `:display`, `:hint`) or set through `v-text`/`v-bind` is just as
 * visible to a person, and it was invisible to both render guards: `:display="`${Math.round(
 * readings.tempCelsius ?? 0)}°C`"` — a fabricated `0 °C` in the tile that exists to warn about
 * heat — stayed green in `test/shared/host-readings.test.ts`, and the same shape would have walked
 * past `test/shared/ui-readings.test.ts`.
 *
 * `:style` and `:class` are returned like every other binding; a caller decides whether a bar's
 * width counts, because that is a judgement about the surface, not about template syntax.
 */

/** One expression a template renders, with the attribute it came through (`null` for `{{ }}`). */
export interface RenderedExpression {
  /** The attribute name, e.g. `:value`, `v-bind:label`, `v-text`; `null` for interpolation text. */
  attribute: string | null
  /** The expression itself, trimmed. */
  text: string
  /** The whole match, for a readable failure message. */
  source: string
}

/**
 * Every rendered expression in a template, in source order.
 *
 * Deliberately syntax-only: no field names, no zero test. A guard that mixed the two could not be
 * reused by the next surface that needs to ask what a template shows.
 */
export function renderedExpressions(template: string): RenderedExpression[] {
  const found: RenderedExpression[] = []
  // Interpolation text, or a bound attribute — `:x`, `v-bind:x`, `v-bind`, `v-text`, `v-html`.
  const shape = /(\{\{([\s\S]*?)\}\}|(?:^|\s)(:[A-Za-z][\w.:-]*|v-bind(?::[\w.:-]+)?|v-text|v-html)="([^"]*)")/g
  for (const match of template.matchAll(shape)) {
    const attribute = match[3] ?? null
    const text = (match[2] ?? match[4] ?? '').trim()
    if (text.length === 0)
      continue
    found.push({ attribute, text, source: match[1]!.trim() })
  }
  return found
}

/** Whether a rendered expression decides geometry or a colour, rather than the text beside them. */
export function isGeometry(expression: RenderedExpression): boolean {
  return expression.attribute !== null && /^:(?:style|class)\b/.test(expression.attribute)
}
