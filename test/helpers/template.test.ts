import { describe, expect, it } from 'vitest'
import { resolveRecord, resolveTemplate, resolveTemplates } from '#src/helpers/template'

describe('resolveTemplate', () => {
  it('substitutes known placeholders', () => {
    expect(resolveTemplate('tcp://{host}:{port}', { host: '127.0.0.1', port: 4010 }))
      .toBe('tcp://127.0.0.1:4010')
  })

  it('substitutes the same placeholder repeatedly', () => {
    expect(resolveTemplate('{port}-{port}', { port: 1 })).toBe('1-1')
  })

  it('leaves unknown placeholders untouched so typos stay visible', () => {
    expect(resolveTemplate('{host}:{nope}', { host: 'x' })).toBe('x:{nope}')
  })

  /**
   * A substituted **value** is inserted literally, never re-interpreted.
   *
   * `String.replace` expands `$$`, `$&`, ``$` `` and `$1` when the replacement is a *string*. This
   * function passes a callback, so those sequences stay literal — which matters because the values are
   * user config: a `dataEnvs` value of `$&` would otherwise expand to the matched `{name}` and rewrite
   * the template it was substituted into. Nothing pinned that, so a refactor to the string form would
   * have opened it silently.
   */
  it('inserts a value literally, even when it looks like a replacement pattern', () => {
    for (const value of ['$&', '$1', '$`', '$$', '$&INJECTED'])
      expect(resolveTemplate('pre {id} post', { id: value }), value).toBe(`pre ${value} post`)
  })

  it('does not expand a placeholder that a value carries', () => {
    // One pass only: the replacement is not rescanned, so a value cannot pull in a second variable.
    expect(resolveTemplate('{id}', { id: '{port}', port: 999 })).toBe('{port}')
  })

  it('does not treat shell-looking text as a placeholder', () => {
    // eslint-disable-next-line no-template-curly-in-string
    expect(resolveTemplate('--bind=${host}', { host: 'x' })).toBe('--bind=${host}')
  })
})

describe('resolveTemplates', () => {
  it('maps over argument arrays', () => {
    expect(resolveTemplates(['-l', 'tcp://{host}:{port}'], { host: 'h', port: 1 })).toEqual(['-l', 'tcp://h:1'])
  })
})

describe('resolveRecord', () => {
  it('resolves every env value', () => {
    expect(resolveRecord({ DATA_DIR: '{dataDir}', PORT: '{port}' }, { dataDir: '/d', port: 4000 }))
      .toEqual({ DATA_DIR: '/d', PORT: '4000' })
  })
})
