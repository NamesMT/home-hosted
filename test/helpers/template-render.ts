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
 * width counts, because that is a judgement about the surface, not about template syntax. That
 * decision is `isGeometry` below, and it reads the binding, not one spelling of it.
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

/**
 * Whether a rendered expression decides geometry or a colour, rather than the text beside them.
 *
 * `:style` and `v-bind:style` are one binding, so one predicate: Vue reads both the same way, and a
 * scan that excused only the short spelling would read a bar's width written the long way as text a
 * person reads. Both callers filter with this, so the two spellings had to agree here rather than at
 * each scan.
 */
export function isGeometry(expression: RenderedExpression): boolean {
  return expression.attribute !== null && /^(?::|v-bind:)(?:style|class)\b/.test(expression.attribute)
}

/**
 * Every opening tag of one component in a template, self-closing or paired.
 *
 * `<MetricSpark … />` and `<MetricSpark …></MetricSpark>` are one call site spelled two ways; a scan
 * that matches only `/>` treats the second as no call site at all, so a required attribute dropped
 * there is invisible. The returned text is the opening tag alone, so its attributes are what a
 * caller reads; a lazy `[\s\S]*?` up to the first `/>` instead runs to the next self-closing
 * sibling and reads that sibling's attributes as this tag's.
 */
export function openingTags(markup: string, component: string): string[] {
  const found: string[] = []
  for (const match of markup.matchAll(new RegExp(`<${component}(?![\\w.:-])`, 'g'))) {
    const end = tagEnd(markup, match.index + match[0].length)
    if (end >= 0)
      found.push(markup.slice(match.index, end + 1))
  }
  return found
}

/** One element a template renders: its opening tag, its own body, and every class it applies. */
export interface TemplateElement {
  /** The tag name as written, lowercase for markup. */
  tag: string
  /** The opening tag alone, to its own `>` — attributes are what a caller reads. */
  opening: string
  /** Everything between the opening and its matching close tag; empty when self-closing. */
  body: string
  /** Class tokens from a literal `class` *and* from the string literals of a bound one. */
  classes: string[]
}

/**
 * Every lowercase element in a template, with its own body and its resolved class list.
 *
 * Two spellings a scan keeps missing, read once here:
 *
 *  - an element's body is the span to its **matching** close, counted by depth. A matcher that
 *    slices from a class string's first occurrence, or takes the first `</div>`, reads a sibling's
 *    or a parent's markup as this element's — measured: a second `<button class="grid size-4 …">`
 *    planted beside the first left `mobile-layout.test.ts` green about its 16 px target;
 *  - `class` is also written as `:class="cn('…')"` / `v-bind:class`, which this corpus uses in 60
 *    places. A regex on `class="…"` reads neither, so a bound `flex flex-wrap shrink-0` was no row
 *    at all — measured green on `uis/stock/test/mobile-layout.test.ts`.
 */
export function templateElements(markup: string): TemplateElement[] {
  const found: TemplateElement[] = []
  const opener = /<([a-z][a-z0-9-]*)(?=[\s/>])/g
  // A `<div` inside a quoted attribute is data, so the walk skips past each tag it has read.
  let consumed = 0
  for (const match of markup.matchAll(opener)) {
    const start = match.index
    if (start < consumed)
      continue
    const tag = match[1]!
    const end = tagEnd(markup, start + match[0].length)
    if (end < 0)
      break
    consumed = end + 1
    const opening = markup.slice(start, end + 1)
    const attributes = opening.slice(match[0].length, -1).replace(/\/\s*$/, '')
    const selfClosing = /\/\s*>$/.test(opening)
    let body = ''
    if (!selfClosing) {
      const close = closeTag(markup, tag, end + 1)
      if (close < 0)
        continue
      body = markup.slice(end + 1, close)
    }
    found.push({ tag, opening, body, classes: classTokens(attributes) })
  }
  return found
}

/**
 * Every class an element applies, from either spelling of the attribute.
 *
 * A literal is split on whitespace; a bound one is an expression, so its **string literals** are the
 * classes it can apply and everything else (`grid`, `focusRing`, `props.class`) is resolved at
 * render time. Reading the literals is what sees `cn('flex flex-wrap shrink-0')`.
 */
function classTokens(attributes: string): string[] {
  const tokens: string[] = []
  for (const match of attributes.matchAll(/(?<![\w:.-])(:class|v-bind:class|class)\s*=\s*"([^"]*)"/g)) {
    const [, attribute, value] = match
    if (attribute === 'class') {
      tokens.push(...value!.split(/\s+/))
    }
    else {
      for (const literal of value!.matchAll(/'([^']*)'|"([^"]*)"/g))
        tokens.push(...(literal[1] ?? literal[2] ?? '').split(/\s+/))
    }
  }
  return [...new Set(tokens.filter(Boolean))]
}

/** The index of the `</tag>` matching an element whose body starts at `from`, counted by depth. */
function closeTag(markup: string, tag: string, from: number): number {
  const pattern = new RegExp(`<(/?)${tag}(?=[\\s/>])`, 'g')
  pattern.lastIndex = from
  let depth = 0
  for (let match = pattern.exec(markup); match !== null; match = pattern.exec(markup)) {
    const end = tagEnd(markup, match.index + match[0].length)
    if (end < 0)
      return -1
    if (match[1] === '/') {
      if (depth === 0)
        return match.index
      depth -= 1
    }
    else if (!/\/\s*>$/.test(markup.slice(match.index, end + 1))) {
      depth += 1
    }
    pattern.lastIndex = end + 1
  }
  return -1
}

/**
 * The `>` that ends an opening tag, skipping any `>` inside a quoted attribute value.
 *
 * An attribute is quoted, so that is the only place a `>` may hide — a `:title` ternary contains
 * one, and a matcher that stops at the first `>` splits the tag mid-attribute.
 */
function tagEnd(markup: string, from: number): number {
  for (let at = from; at < markup.length; at += 1) {
    const char = markup[at]
    if (char === '"' || char === '\'') {
      const close = markup.indexOf(char, at + 1)
      if (close < 0)
        return -1
      at = close
    }
    else if (char === '>') {
      return at
    }
  }
  return -1
}
