import { describe, expect, it } from 'vitest'
import { parseServersFile } from '#src/config/parse'

/**
 * Dependency validation: dangling ids and cycles are *reported*, never fatal, because
 * supervision has to keep running for everything else in the file. None of this had a
 * test — the three messages below were unreachable by the suite.
 */

function parse(servers: unknown[]): { errors: string[], warnings: string[] } {
  return parseServersFile({ servers }, {})
}

describe('dependency validation', () => {
  it('reports a dependency on an id that is not in the file', () => {
    const { errors, warnings } = parse([{ id: 'app', command: 'node', dependsOn: ['ghost'] }])

    expect(warnings).toEqual(['"app" depends on unknown server "ghost"'])
    // Reported, not fatal: the entry is still supervised.
    expect(errors).toEqual([])
  })

  it('reports a server that depends on itself', () => {
    const { warnings } = parse([{ id: 'solo', command: 'node', dependsOn: ['solo'] }])

    expect(warnings).toContain('"solo" depends on itself')
  })

  it('reports a cycle, and finds one that is not the first component', () => {
    // A clean pair first, so the walk has to keep going past the settled component
    // rather than stopping once something is known-good.
    const { warnings } = parse([
      { id: 'app', command: 'node', dependsOn: ['db'] },
      { id: 'db', command: 'node' },
      { id: 'x', command: 'node', dependsOn: ['y'] },
      { id: 'y', command: 'node', dependsOn: ['x'] },
    ])

    expect(warnings.filter(warning => warning.startsWith('dependency cycle'))).toHaveLength(1)
    expect(warnings.some(warning => warning.includes('"x"') || warning.includes('"y"'))).toBe(true)
  })

  it('reports a three-node cycle, once', () => {
    const { warnings } = parse([
      { id: 'a', command: 'node', dependsOn: ['b'] },
      { id: 'b', command: 'node', dependsOn: ['c'] },
      { id: 'c', command: 'node', dependsOn: ['a'] },
    ])

    // Every node of the cycle is visited, so the dedupe is what keeps this to one line.
    expect(warnings.filter(warning => warning.startsWith('dependency cycle'))).toHaveLength(1)
  })

  it('says nothing about a well-formed graph, including a diamond', () => {
    const { errors, warnings } = parse([
      { id: 'top', command: 'node', dependsOn: ['left', 'right'] },
      { id: 'left', command: 'node', dependsOn: ['base'] },
      { id: 'right', command: 'node', dependsOn: ['base'] },
      { id: 'base', command: 'node' },
    ])

    expect(warnings).toEqual([])
    expect(errors).toEqual([])
  })
})
