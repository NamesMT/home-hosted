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
