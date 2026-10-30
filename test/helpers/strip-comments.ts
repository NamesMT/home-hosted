/**
 * A source file with its comments removed, and everything that is not a comment left alone.
 *
 * Three guards used to strip comments with `/\/\*[\s\S]*?\*\//` and `/^\s*\/\/.*$/gm`, which reads a
 * `//` or `/*` inside a **string** as the start of a comment. That is an assumption about the corpus,
 * not a property of the stripper, and the corpus already breaks it in both directions:
 *
 *  - `uis/stock/src/i18n/index.ts` holds `'../../i18n/generated/**\/*.json'`, so the block pattern
 *    opens at that `/*` and closes at the end of the *next* comment — deleting the `createI18n(...)`
 *    call between them, and with it any `structuredClone` planted there:
 *    `test/shared/ui-parity.test.ts` stayed green on a real planted copy;
 *  - `placeholder="http://10.0.0.5:8080"` in a `.vue` template made the line pattern truncate the
 *    rest of the line, so the markup after it was invisible to the render scans;
 *  - the same corpus breaks the CSS copies, where `.probe::after { content: '/*' }` opens a comment
 *    that runs to the next **real** `/*`, deleting every rule between them — a `.btn--icon` pinned
 *    under the tap floor stayed green in `test/shared/ui-tap-targets.test.ts`.
 *
 * So the stripper tracks what it is inside of. A `.vue` file is two languages, and each is read
 * with its own rules: the template region strips `<!-- -->` and leaves every attribute string alone,
 * and each `<script>` block is read as JavaScript, where `'` inside HTML text is not a string
 * delimiter and `//` inside a URL is not a comment. A `.css` file is one language with two
 * delimiters of its own: `/* *\/` is a comment and `'…'`/`"…"` is not.
 */

/**
 * The JavaScript half of the stripper: comments blanked, string and template literals preserved.
 *
 * Comment characters become spaces rather than vanishing, so a scan that reports `:line` still
 * reports the line in the file the author edits.
 */
function stripJavaScript(source: string): string {
  const out = source.split('')
  let state: 'code' | 'string' | 'template' | 'regex' = 'code'
  let quote = ''
  // A `/` begins a regex only where a value may begin; after an identifier or `)` it is division.
  const regexCanFollow = /[=(,:;[!&|?{}+\-*/%<>~^]$/

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!
    const next = source[index + 1]

    if (state === 'string' || state === 'template') {
      if (char === '\\')
        index += 1
      else if (char === quote)
        state = 'code'
      continue
    }
    if (state === 'regex') {
      if (char === '\\') {
        index += 1
      }
      else if (char === '[') {
        // A `/` inside a character class does not close the literal.
        while (index < source.length && source[index] !== ']') {
          index += 1
        }
      }
      else if (char === '/') {
        state = 'code'
      }
      continue
    }

    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') {
        out[index] = ' '
        index += 1
      }
      index -= 1
      continue
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2)
      const stop = end < 0 ? source.length : end + 1
      for (let blank = index; blank <= stop && blank < source.length; blank += 1) {
        if (source[blank] !== '\n')
          out[blank] = ' '
      }
      index = stop
      continue
    }
    if (char === '"' || char === '\'' || char === '`') {
      state = char === '`' ? 'template' : 'string'
      quote = char
      continue
    }
    if (char === '/' && regexCanFollow.test(source.slice(Math.max(0, index - 1), index)))
      state = 'regex'
  }
  return out.join('')
}

/**
 * The CSS half of the stripper: `/* *\/` blanked, and so is the body of every quoted string.
 *
 * A CSS scan reads selectors and declarations, and neither is ever inside a string — `content: '/*'`
 * is content. Blanking it is what keeps a brace in that content from closing a block early, so the
 * rule parser below can count braces over the result.
 */
function stripCss(source: string): string {
  const out = source.split('')
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (char === '\'' || char === '"') {
      for (index += 1; index < source.length && source[index] !== char; index += 1) {
        if (source[index] !== '\n')
          out[index] = ' '
      }
      continue
    }
    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2)
      const stop = end < 0 ? source.length : end + 1
      for (let blank = index; blank <= stop && blank < source.length; blank += 1) {
        if (source[blank] !== '\n')
          out[blank] = ' '
      }
      index = stop
    }
  }
  return out.join('')
}

/** The template half of a `.vue` file: `<!-- -->` blanked, attributes and text untouched. */
function stripMarkup(source: string): string {
  const out = source.split('')
  for (let index = 0; index < source.length; index += 1) {
    if (source.startsWith('<!--', index)) {
      const end = source.indexOf('-->', index + 4)
      const stop = end < 0 ? source.length : end + 2
      for (let blank = index; blank <= stop && blank < source.length; blank += 1) {
        if (source[blank] !== '\n')
          out[blank] = ' '
      }
      index = stop
    }
  }
  return out.join('')
}

/**
 * Split a `.vue` source into its `<script>` bodies and its template, each stripped by its own rules.
 *
 * The regions are found by position and reassembled in order, so the result keeps the file's line
 * count and every offset — the same property `stripJavaScript` has on its own.
 */
function stripVue(source: string): string {
  const out = source.split('')
  const blocks = [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
  for (const block of blocks) {
    const start = block.index! + block[0].indexOf(block[1]!) - (block[1] === '' ? 0 : 0)
    const body = stripJavaScript(block[1] ?? '')
    for (let offset = 0; offset < body.length; offset += 1)
      out[start + offset] = body[offset]!
  }
  // Everything outside a script block is markup: the template, plus any `<style>` (which has its
  // own comment syntax this scan has never needed — it holds no reading and no clipboard write).
  const markup = stripMarkup(source)
  const scriptRanges = blocks.map(block => [block.index!, block.index! + block[0].length] as const)
  for (let index = 0; index < out.length; index += 1) {
    if (scriptRanges.some(([from, to]) => index >= from && index < to))
      continue
    out[index] = markup[index]!
  }
  return out.join('')
}

/** A source file with its comments blanked; `.vue` is read as markup plus script blocks. */
export function stripComments(source: string, file = ''): string {
  if (file.endsWith('.css'))
    return stripCss(source)
  return file.endsWith('.vue') ? stripVue(source) : stripJavaScript(source)
}

/** One CSS rule: the at-rule conditions it sits inside, its selector list and its body. */
export interface CssRule {
  /** Enclosing at-rule conditions in source order, e.g. `['(width <= 860px)']` at top level `[]`. */
  media: string[]
  /** The selector list, split on a comma and trimmed. */
  selectors: string[]
  /** The declaration body, comments and quoted strings blanked. */
  body: string
}

/**
 * Every rule in a stylesheet, as the tiers it sits in, a selector list and a body — parsed, never
 * pattern-matched.
 *
 * A scan for `selector {` is a scan for one spelling: a selector list splits on a comma, a comment
 * between two rules belongs to neither, and a rule inside `@media` is not visible from outside it.
 * Braces are counted over the comment- and string-blanked source, so a `{` inside `content: '{'`
 * cannot close a block early. A caller picks a tier by its condition, which is how a scan says "in
 * the phone block" without slicing the file by hand.
 */
export function cssRules(css: string): CssRule[] {
  const source = stripCss(css)
  return cssRulesIn(source, [])
}

function cssRulesIn(source: string, media: string[]): CssRule[] {
  const rules: CssRule[] = []
  let index = 0
  let prelude = ''
  for (; index < source.length; index += 1) {
    const char = source[index]
    if (char === ';') {
      // A statement (`@import …;`, `@source …;`) is not a rule and has no body.
      prelude = ''
      continue
    }
    if (char === '}') {
      // A stray close is the end of the container this text was sliced from.
      prelude = ''
      continue
    }
    if (char !== '{') {
      prelude += char
      continue
    }
    let depth = 1
    let close = index + 1
    for (; close < source.length && depth > 0; close += 1) {
      if (source[close] === '{')
        depth += 1
      else if (source[close] === '}')
        depth -= 1
    }
    if (depth !== 0)
      // An unbalanced stylesheet is a broken file, not a scan to guess around.
      break
    const body = source.slice(index + 1, close - 1)
    const head = prelude.trim()
    prelude = ''
    index = close - 1
    if (head.length === 0)
      continue
    if (head.startsWith('@')) {
      // A container: its header is a condition, not a selector, so the rules are inside it.
      rules.push(...cssRulesIn(body, [...media, head.replace(/^@[\w-]+\s*/, '').trim()]))
      continue
    }
    rules.push({ media, selectors: head.split(',').map(part => part.trim()).filter(part => part.length > 0), body })
  }
  return rules
}
