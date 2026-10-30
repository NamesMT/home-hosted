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
