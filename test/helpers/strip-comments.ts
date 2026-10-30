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

/** A character after which a `/` begins a regex literal rather than a division. */
const REGEX_AFTER = new Set('=(,:;[!&|?{}+\-*/%<>~^')

/** A keyword after which a `/` begins a regex literal: `return /…/`, `typeof /…/`, `case /…/`. */
const REGEX_KEYWORDS = new Set(['await', 'case', 'delete', 'do', 'else', 'in', 'instanceof', 'new', 'of', 'return', 'throw', 'typeof', 'void', 'yield'])

/** What the scanner is inside of; a `${}` interpolation pushes a nested `code` frame. */
type Frame
  = { kind: 'code', braces: number }
    | { kind: 'string', quote: string }
    | { kind: 'template' }
    | { kind: 'regex', inClass: boolean }

/**
 * The JavaScript half of the stripper: comments blanked, string and template literals preserved.
 *
 * Comment characters become spaces rather than vanishing, so a scan that reports `:line` still
 * reports the line in the file the author edits.
 *
 * The state is a stack, not one state: a `${}` interpolation is code again, and may hold a template
 * literal of its own — `` `  ${dim(`load ${id}`)}` `` is in `src/cli/backup.ts` — so one flat
 * "template" state closes the outer literal at the inner backtick and reads the rest of the file
 * through a string that never ends. A regex starts after any place a value may begin, including
 * after whitespace and after a keyword (`return`), because `= /^https?:\/\//` is how every regex in
 * this corpus is written and the character before the first `/` there is a space.
 */
/**
 * Blank the comments in `source[start…]`, stopping at `stopAt` when it is given.
 *
 * `stopAt` is consulted only in code, so a `</script>` inside a string, template or regex is text
 * rather than the end of the block. Returns the whole-file character array (offsets preserved) and
 * the index the scan stopped at.
 */
function scanJavaScript(source: string, from = 0, stopAt?: (index: number) => boolean): { out: string[], end: number } {
  const out = source.split('')
  const blank = (start: number, to: number): void => {
    for (let at = start; at < to && at < source.length; at += 1) {
      if (source[at] !== '\n')
        out[at] = ' '
    }
  }

  const frames: Frame[] = [{ kind: 'code', braces: 0 }]
  let lastCode = ''
  let lastCodeAt = -1
  const wordBefore = (): string => {
    if (!/[\w$]/.test(lastCode))
      return ''
    let from = lastCodeAt
    while (from > 0 && /[\w$]/.test(source[from - 1] ?? ''))
      from -= 1
    return source.slice(from, lastCodeAt + 1)
  }
  // Only code sets `lastCode`, so a keyword inside a comment or a string cannot start one.
  const regexCanFollow = (): boolean =>
    lastCode === '' || REGEX_AFTER.has(lastCode) || REGEX_KEYWORDS.has(wordBefore())

  let index = from
  while (index < source.length) {
    const char = source[index]!
    const frame = frames[frames.length - 1]!
    // Only code asks the boundary: a `</script>` inside a string, template or regex is text.
    if (frame.kind === 'code' && stopAt?.(index) === true)
      break

    if (frame.kind === 'string') {
      if (char === '\\') {
        index += 2
      }
      else {
        if (char === frame.quote) {
          frames.pop()
          // A closed string is a value, so a `/` after it is division, not a regex.
          lastCode = char
          lastCodeAt = index
        }
        index += 1
      }
      continue
    }

    if (frame.kind === 'template') {
      if (char === '\\') {
        index += 2
      }
      else if (char === '`') {
        frames.pop()
        lastCode = '`'
        lastCodeAt = index
        index += 1
      }
      else if (char === '$' && source[index + 1] === '{') {
        frames.push({ kind: 'code', braces: 0 })
        lastCode = '{'
        lastCodeAt = index + 1
        index += 2
      }
      else {
        index += 1
      }
      continue
    }

    if (frame.kind === 'regex') {
      if (char === '\\') {
        index += 2
      }
      else if (char === '[') {
        // A `/` inside a character class does not close the literal.
        frame.inClass = true
        index += 1
      }
      else if (char === ']' && frame.inClass) {
        frame.inClass = false
        index += 1
      }
      else if (char === '/' && !frame.inClass) {
        frames.pop()
        lastCode = '/'
        lastCodeAt = index
        index += 1
      }
      else {
        index += 1
      }
      continue
    }

    if (char === '/' && source[index + 1] === '/') {
      let stop = index
      while (stop < source.length && source[stop] !== '\n')
        stop += 1
      blank(index, stop)
      index = stop
      continue
    }
    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2)
      const stop = end < 0 ? source.length : end + 2
      blank(index, stop)
      index = stop
      continue
    }
    if (char === '"' || char === '\'') {
      frames.push({ kind: 'string', quote: char })
      index += 1
      continue
    }
    if (char === '`') {
      frames.push({ kind: 'template' })
      index += 1
      continue
    }
    if (char === '/' && regexCanFollow()) {
      frames.push({ kind: 'regex', inClass: false })
      index += 1
      continue
    }
    if (char === '{') {
      frame.braces += 1
    }
    else if (char === '}') {
      if (frame.braces > 0) {
        frame.braces -= 1
      }
      // A `}` that closes a `${}` returns to the template around it.
      else if (frames.length > 1) {
        frames.pop()
        index += 1
        continue
      }
    }
    if (char.trim().length > 0) {
      lastCode = char
      lastCodeAt = index
    }
    index += 1
  }
  return { out, end: index }
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
        // A backslash escapes the next character, so `content: "\""` holds a quote, not the end.
        if (source[index] === '\\')
          index += 1
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

/**
 * The markup half of a `.vue` file: `<!-- -->` blanked, attributes and text untouched.
 *
 * A `<!--` inside a quoted attribute value is data, not a comment opener — `:title="'<!--'"`
 * is how a template shows that literal — so the value is stepped over whole while the reader is
 * inside a tag. Text between tags is *not* quoted: `it's fine` holds an apostrophe that is a
 * character, and reading the rest of the template as a string would swallow the real comment
 * after it. A `<style>` block is the other language here and is read by `stripCss`, never by this,
 * so its span is stepped over whole rather than scanned for markup comments.
 */
function stripMarkup(source: string, opaque: Array<[number, number]> = []): string {
  const out = source.split('')
  /** Inside an element's open or close tag, where a bare quote begins an attribute value. */
  let inTag = false
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    // A region another language owns (`<style>`) has no markup comment in it.
    const region = opaque.find(([from, to]) => index >= from && index < to)
    if (region !== undefined) {
      index = region[1] - 1
      continue
    }
    if (!inTag && source.startsWith('<!--', index)) {
      const end = source.indexOf('-->', index + 4)
      const stop = end < 0 ? source.length : end + 2
      for (let blank = index; blank <= stop && blank < source.length; blank += 1) {
        if (source[blank] !== '\n')
          out[blank] = ' '
      }
      index = stop
      continue
    }
    if (char === '<') {
      // A tag starts at `<name` or `</name`; a `<` in prose or arithmetic closes nothing.
      if (/[a-z/]/i.test(source[index + 1] ?? ''))
        inTag = true
      continue
    }
    if (char === '>' && inTag) {
      inTag = false
      continue
    }
    if (inTag && (char === '"' || char === '\'')) {
      const close = source.indexOf(char, index + 1)
      index = close < 0 ? source.length : close
    }
  }
  return out.join('')
}

/**
 * Split a `.vue` source into its `<script>` bodies and its template, each stripped by its own rules.
 *
 * The regions are found by position and reassembled in order, so the result keeps the file's line
 * count and every offset — the same property `stripJavaScript` has on its own.
 *
 * The end of a block is decided by the *script* reader, not by a `</script>` in the text: a string
 * may hold one (`const close = '</script>'`), and a lazy match ends the block there. Everything
 * after it was then read as markup, so the line's real comment survived — and a `<!--` in the same
 * string opened a "markup comment" that blanked the rest of the script. The close is the first one
 * the reader meets in code, which is also what the Vue compiler does.
 *
 * The **open** tag is read the same way: `/<script\b[^>]*>/` stops at a `>` inside an attribute
 * value, so `<script generic="T extends Record<string, unknown>">` — legal, `errors: 0` in Vue's own
 * SFC parser — began the block at the `"` that closes the attribute, and the string it opened ran
 * over the lines below, leaving every comment in the block in place.
 */
interface VueScan {
  /** The whole file with each region's comments blanked, offsets preserved. */
  text: string
  /** `<script>` and `<style>` spans, whose bodies are another language. */
  opaque: Array<[number, number]>
}

function scanVue(source: string): VueScan {
  const out = source.split('')
  const scriptRanges: Array<[number, number]> = []
  /** The `>` that closes an open tag, skipping any `>` inside a quoted attribute value. */
  const tagEnd = (from: number): number => {
    for (let at = from; at < source.length; at += 1) {
      const char = source[at]
      if (char === '"' || char === '\'') {
        // An attribute value is quoted, so a `>` in it is data: `generic="T extends Record<K, V>"`.
        const close = source.indexOf(char, at + 1)
        if (close < 0)
          return source.length
        at = close
      }
      else if (char === '>') {
        return at
      }
      else if (char === '\n') {
        // An open tag is one line in every SFC this corpus writes; a stray `<script` in prose is not.
        return -1
      }
    }
    return -1
  }
  const opener = /<script\b/g
  for (let match = opener.exec(source); match !== null; match = opener.exec(source)) {
    const tagClosed = tagEnd(match.index + match[0].length)
    if (tagClosed < 0)
      continue
    const start = tagClosed + 1
    const scanned = scanJavaScript(source, start, index => source.startsWith('</script>', index))
    // Only this block's span: a later scan starts from a fresh copy of the source, so copying all of
    // it would put an earlier block's comments back.
    for (let offset = start; offset < scanned.end; offset += 1)
      out[offset] = scanned.out[offset]!
    const close = source.indexOf('</script>', scanned.end)
    const end = close < 0 ? source.length : close + '</script>'.length
    scriptRanges.push([match.index, end])
    // Resume after the close so a second block is found, and never re-open the one just read.
    opener.lastIndex = end
  }
  // A `<style>` block is **CSS**, not markup, so it is read by the CSS reader and stepped over by
  // the markup one.
  //
  // Read as markup it was wrong in both directions: `content: "<!--"` opened a markup comment that
  // ran to the next `-->` — and with `<style>` before `<template>`, which Vue's own SFC parser
  // accepts (`errors: 0`), that blanked the whole template, so a render scan found nothing. And a
  // CSS comment (`/* … structuredClone(toRaw(x)) … */`) is a comment to every scan, but markup has no
  // such syntax, so it survived and **failed `test/shared/ui-parity.test.ts`** on a file with no
  // call — the false-positive direction, measured.
  const styleRanges: Array<{ body: number, end: number }> = []
  const styleOpener = /<style\b/g
  for (let match = styleOpener.exec(source); match !== null; match = styleOpener.exec(source)) {
    const tagClosed = tagEnd(match.index + match[0].length)
    if (tagClosed < 0)
      continue
    const body = tagClosed + 1
    const close = source.indexOf('</style>', body)
    const end = close < 0 ? source.length : close
    styleRanges.push({ body, end })
    styleOpener.lastIndex = end
  }
  // Everything outside a script or style block is markup: the template, and any text around it.
  // The block's body is passed as opaque, never its open tag: the tag is markup.
  const markup = stripMarkup(source, styleRanges.map(range => [range.body, range.end]))
  for (let index = 0; index < out.length; index += 1) {
    if (scriptRanges.some(([from, to]) => index >= from && index < to))
      continue
    out[index] = markup[index]!
  }
  for (const { body, end } of styleRanges) {
    // Only this block's span: `stripCss` returns the whole file with its own comments blanked, and
    // copying all of it would undo the script and markup work around it.
    const scanned = stripCss(source.slice(body, end))
    for (let offset = 0; offset < scanned.length; offset += 1)
      out[body + offset] = scanned[offset]!
  }
  return {
    text: out.join(''),
    opaque: [
      ...scriptRanges,
      ...styleRanges.map(({ body, end }): [number, number] => [body, end]),
    ],
  }
}

function stripVue(source: string): string {
  return scanVue(source).text
}

/** A source file with its comments blanked; `.vue` is read as markup plus script blocks. */
export function stripComments(source: string, file = ''): string {
  if (file.endsWith('.css'))
    return stripCss(source)
  return file.endsWith('.vue') ? stripVue(source) : scanJavaScript(source).out.join('')
}

/**
 * The root `<template>` of a `.vue` file: comments blanked, scripts and styles left out.
 *
 * A scan that slices from `indexOf('<template>')` to the last `</template>` reads a `</template>`
 * held in a *string* as the end of the region, and finds nothing when the root tag carries an
 * attribute (`<template lang="pug">`). Regions are counted by depth over the blanked source, and
 * only real tags count: a `<template>` inside a quoted attribute value or a `<script>` body is
 * stepped over rather than read.
 */
export function templateRegion(source: string): string {
  const { text, opaque } = scanVue(source)
  const out = text.split('')
  // Another language's body cannot hold a template tag, so it is hidden before tags are counted.
  for (const [from, to] of opaque) {
    for (let at = from; at < to; at += 1) {
      if (out[at] !== '\n')
        out[at] = ' '
    }
  }
  const markup = out.join('')
  let depth = 0
  let start = -1
  for (let at = 0; at < markup.length; at += 1) {
    if (markup[at] !== '<' || !/[a-z/]/i.test(markup[at + 1] ?? ''))
      continue
    // A tag ends at its own `>`, so one inside a quoted attribute (`v-if="a > b"`) is data.
    const end = tagClose(markup, at + 1)
    if (end < 0)
      break
    const tag = markup.slice(at, end + 1)
    at = end
    if (!/^<\s*(?:\/\s*)?template\b/i.test(tag))
      continue
    if (/^<\s*\//.test(tag)) {
      if (depth === 0)
        continue
      depth -= 1
      if (depth === 0)
        return text.slice(start, end + 1 - tag.length)
      continue
    }
    // `<template />` is an empty slot: it opens no region and closes none.
    if (tag.endsWith('/>'))
      continue
    if (depth === 0)
      start = end + 1
    depth += 1
  }
  return start < 0 ? '' : text.slice(start)
}

/** The first `>` at or after `from` that is not inside a quoted attribute value, or `-1`. */
function tagClose(source: string, from: number): number {
  for (let at = from; at < source.length; at += 1) {
    const char = source[at]
    if (char === '"' || char === '\'') {
      const close = source.indexOf(char, at + 1)
      if (close < 0)
        return -1
      at = close
    }
    else if (char === '>') {
      return at
    }
    else if (char === '<') {
      // A `<` before any `>` closes nothing: the tag ended at a `>` we already passed.
      return at - 1
    }
  }
  return -1
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
