import { describe, expect, it } from 'vitest'
import { cssRules, stripComments } from './strip-comments'

/**
 * The reader every scan uses, and the corpus that breaks a regex.
 *
 * Each case here is a shape that was measured eating a guard's evidence, not a syntax tour.
 */
describe('the shared comment reader', () => {
  it('does not open a comment at a `/*` inside a JavaScript string', () => {
    // `uis/stock/src/i18n/index.ts` holds this glob: the pattern opened at `/*` and closed at the
    // next real comment, so everything between them was invisible.
    const source = 'const loaders = import.meta.glob(\'../../i18n/generated/**/*.json\')\nconst copy = createI18n({})\n/* explains */\n'
    const stripped = stripComments(source, 'index.ts')
    expect(stripped).toContain('createI18n')
    expect(stripped).not.toContain('explains')
  })

  it('does not open a comment at a `//` inside a URL', () => {
    const source = 'const url = \'http://127.0.0.1:6181\'\nconst live = structuredClone(x)\n'
    expect(stripComments(source, 'rpc.ts')).toContain('structuredClone')
  })

  it('keeps the line count so a reported `:line` is the line the author edits', () => {
    const source = 'const a = 1\n// gone\nconst b = 2\n'
    expect(stripComments(source, 'a.ts').split('\n')).toHaveLength(source.split('\n').length)
  })

  it('reads a `.vue` template as markup, so a `//` in an attribute is not a comment', () => {
    const vue = '<template>\n  <input placeholder="http://10.0.0.5:8080">\n  <b>{{ live.responseMs }}</b>\n</template>\n'
    const stripped = stripComments(vue, 'Panel.vue')
    expect(stripped).toContain('{{ live.responseMs }}')
  })

  /**
   * A regex literal opens after whitespace as often as after a delimiter.
   *
   * `regexCanFollow` tested the character *immediately* before the `/`, so `= /^https?:\/\//`
   * — the shape the corpus writes everywhere (`src/services/proxy.ts:2054`,
   * `src/providers/ui-release.ts:127`) — was not a regex at all: the `\/` pairs were read as
   * code, and the second one opened a **line comment** at `//i.exec(trimmed)`, blanking the
   * rest of the line. A scan reading `proxy.ts` therefore never saw `parseUpstream`'s
   * `explicit !== null` check, the branch the whole function exists for.
   */
  it('reads a regex literal that follows a space, so its escaped slashes are not a comment', () => {
    const source = 'const explicit = /^([a-z][a-z0-9+.-]*):\\/\\//i.exec(trimmed)\nconst next = 1\n'
    const stripped = stripComments(source, 'proxy.ts')
    expect(stripped).toContain('.exec(trimmed)')
    expect(stripped).toContain('const next = 1')
  })

  it('reads a regex literal that follows `return`, `(`, or a comma', () => {
    for (const source of [
      'function f(u) {\n  return /^https?:\\/\\//.test(u)\n}\nconst next = 1\n',
      'const ok = f(/^a\\/\\//, 1)\nconst next = 1\n',
      'const xs = [/a\\/\\//, /b\\/\\//]\nconst next = 1\n',
    ])
      expect(stripComments(source, 'a.ts'), source).toContain('const next = 1')
  })

  /**
   * A `${}` interpolation is code, and may hold a template literal of its own.
   *
   * `src/cli/backup.ts:758` writes `` `  ${dim(`! the panel's listener changed`)}\n` ``. The reader
   * treated the whole outer template as one string, so the **inner** backtick closed it: the rest of
   * the line became code, the inner `'` opened a string that ran past the end of the line, and every
   * comment after it survived — 39 of 111 comments in that file were left in place, so a dependent
   * scan read comment prose as code. The first case below is the shape without an apostrophe, which
   * happened to survive; it is here so the two are told apart.
   */
  it('keeps a template literal inside a `${}` interpolation, including a nested backtick', () => {
    const source = `process.stdout.write(\`  ${'$'}{dim(\`load ${'$'}{hook.serverId}: ${'$'}{hook.output ?? 'staged'}\`)}\\n\`)\n// gone\nconst live = structuredClone(x)\n`
    const stripped = stripComments(source, 'backup.ts')
    expect(stripped).toContain('const live = structuredClone(x)')
    expect(stripped).toContain(`\`load ${'$'}{hook.serverId}: ${'$'}{hook.output ?? 'staged'}\``)
    expect(stripped).not.toContain('gone')
  })

  it('does not let an apostrophe in a nested template swallow the comments after it', () => {
    const source = `process.stdout.write(\`  ${'$'}{dim(\`! the panel's listener changed\`)}\\n\`)\n/** the note */\nconst live = structuredClone(x)\n`
    const stripped = stripComments(source, 'backup.ts')
    expect(stripped).toContain('const live = structuredClone(x)')
    expect(stripped).not.toContain('the note')
  })

  it('does not read a `//` inside a nested template as a comment', () => {
    const source = `const s = \`${'$'}{xs.map(x => \`${'$'}{x} // y\`).join('')}\`\nconst live = structuredClone(x)\n`
    const stripped = stripComments(source, 'a.ts')
    expect(stripped).toContain('const live = structuredClone(x)')
    expect(stripped).toContain(`\`${'$'}{x} // y\``)
  })

  /**
   * Comments are blanked to spaces, so a caller can slice the result by a source offset.
   *
   * `stripVue` relies on it: it copies each `<script>` body back over the markup-stripped text at
   * the same offsets. A `.vue` script also lives inside a template whose `</script>` may be text.
   */
  it('blanks a comment in a `.vue` script without touching a `</script>` inside a string', () => {
    const vue = [
      '<template><b>{{ x }}</b></template>',
      '<script setup lang="ts">',
      '// gone',
      'const close = \'</script>\'',
      '</script>',
    ].join('\n')
    const stripped = stripComments(vue, 'Panel.vue')
    expect(stripped).toContain('const close = \'</script>\'')
    expect(stripped).not.toContain('gone')
  })
})

/**
 * The CSS mode, and why it exists: `.probe::after { content: '/*' }` is content, not a comment.
 *
 * Measured against `uis/noc-console/src/styles.css`: the old regex opened a "comment" at that
 * string and closed it at the next `/*`, deleting the rules between them — a `.btn--icon` pinned
 * under the tap floor stayed green in `test/shared/ui-tap-targets.test.ts`.
 */
describe('the CSS reader', () => {
  it('does not open a comment at a `/*` inside a quoted string', () => {
    const css = '.a::after { content: \'/*\'; }\n.btn--icon { min-width: 10px; }\n'
    expect(stripComments(css, 'styles.css')).toContain('min-width: 10px')
  })

  it('still blanks a real comment', () => {
    const css = '/* a note */ .btn--icon { min-width: 10px; }\n'
    const stripped = stripComments(css, 'styles.css')
    expect(stripped).not.toContain('a note')
    expect(stripped).toContain('min-width: 10px')
  })

  it('parses a rule list, a comma-separated selector list and a nested tier', () => {
    const css = [
      '@source \'./**/*.{vue,ts,html}\';',
      '.a, .b { width: auto; }',
      '@media (width <= 860px) {',
      '  .c { flex-wrap: wrap; }',
      '}',
    ].join('\n')
    const rules = cssRules(css)
    expect(rules.map(rule => rule.selectors)).toEqual([['.a', '.b'], ['.c']])
    expect(rules[1]!.media).toEqual(['(width <= 860px)'])
  })

  it('does not let a brace inside quoted content close a block early', () => {
    const css = '.a::after { content: \'{\'; }\n.b { width: auto; }\n'
    expect(cssRules(css).map(rule => rule.selectors)).toEqual([['.a::after'], ['.b']])
  })
})

/**
 * The CSS reader's own escape, and why a `\"` matters.
 *
 * `.probe::after { content: "\\"" }` is a valid stylesheet — the escaped quote is content, not a
 * delimiter. The reader advanced to the next `"`, which was the **closing** quote of the string, so
 * the rest of the declaration was read as code: the `{`/`}` counting in `cssRules` then saw a
 * close without an open and dropped the rule, and every rule after it in that file with it.
 */
describe('the CSS reader and escaped quotes', () => {
  it('does not end a quoted string at a backslash-escaped quote', () => {
    const css = '.a::after { content: "\\""; }\n.b { min-width: 10px; }\n'
    expect(stripComments(css, 'x.css')).toContain('min-width: 10px')
    expect(cssRules(css).map(rule => rule.selectors)).toEqual([['.a::after'], ['.b']])
  })

  it('does not end a single-quoted string at an escaped quote either', () => {
    const css = '.a::after { content: \'it\\\'s\' }\n.b { min-width: 10px; }\n'
    expect(cssRules(css).map(rule => rule.selectors)).toEqual([['.a::after'], ['.b']])
  })
})

/**
 * A `.vue` script ends where the *script* ends, not at the first `</script>` in the text.
 *
 * The block was found with a lazy `/<script\b[^>]*>([\s\S]*?)<\/script>/`, so a string holding
 * `'</script>'` truncated it. Everything after that string was read as markup: the real comment on
 * the next line survived, and a `'<!--'` in the same string opened a markup comment that blanked
 * the rest of the script — real code lost, in the file kind the render scans read most.
 */
describe('the `.vue` reader and `</script>` inside a script string', () => {
  it('does not end the block at a `</script>` inside a string', () => {
    const vue = [
      '<template><b>{{ x }}</b></template>',
      '<script setup lang="ts">',
      'const close = \'</script>\'',
      '// structuredClone(toRaw(form)) is the bug',
      'const after = structuredClone({ a: 1 })',
      '</script>',
    ].join('\n')
    const stripped = stripComments(vue, 'X.vue')
    expect(stripped).toContain('const after = structuredClone({ a: 1 })')
    expect(stripped).not.toContain('toRaw(form)')
  })

  it('does not let a `<!--` in a script string blank the rest of the script', () => {
    const vue = [
      '<template><b>{{ x }}</b></template>',
      '<script setup lang="ts">',
      'const marker = \'<!--\'',
      'const live = structuredClone({ a: 1 })',
      '</script>',
    ].join('\n')
    expect(stripComments(vue, 'Y.vue')).toContain('const live = structuredClone({ a: 1 })')
  })

  it('still reads a second `<script>` block, and stops at its real end', () => {
    const vue = [
      '<script lang="ts">',
      'export const a = 1 // gone',
      '</script>',
      '<script setup lang="ts">',
      'const b = structuredClone({ c: 2 }) // gone too',
      '</script>',
    ].join('\n')
    const stripped = stripComments(vue, 'Z.vue')
    expect(stripped).toContain('export const a = 1')
    expect(stripped).toContain('const b = structuredClone({ c: 2 })')
    expect(stripped).not.toContain('gone')
  })
})

/**
 * A `.vue` open tag ends at the first `>` **outside** an attribute value.
 *
 * `<script\b[^>]*>` stops at the `>` inside `generic="T extends Record<string, unknown>"` — a
 * constraint Vue's own SFC parser reads fine (`errors: 0`). The block then started mid-tag, at the
 * `"` that closes the attribute, so the reader began inside a string that ran over the lines below
 * it and every comment in the block survived — the false-positive direction, where a comment that
 * merely *names* `structuredClone` fails a scan on a file with no call.
 */
describe('the `.vue` reader and a `>` inside a script attribute', () => {
  it('does not end the open tag at a `>` inside an attribute value', () => {
    const vue = [
      '<script setup lang="ts" generic="T extends Record<string, unknown>">',
      '// gone',
      'const keep = structuredClone({ a: 1 })',
      '</script>',
      '<template><b>{{ keep }}</b></template>',
    ].join('\n')
    const stripped = stripComments(vue, 'G.vue')
    expect(stripped).toContain('const keep = structuredClone({ a: 1 })')
    expect(stripped).not.toContain('gone')
  })

  it('reads a `>` in any attribute, not only in `generic`', () => {
    const vue = [
      '<script setup lang="ts" data-note="a > b">',
      '// gone',
      'const keep = 1',
      '</script>',
    ].join('\n')
    const stripped = stripComments(vue, 'H.vue')
    expect(stripped).toContain('const keep = 1')
    expect(stripped).not.toContain('gone')
  })
})
