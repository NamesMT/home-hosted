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

describe('cross-field validation', () => {
  /**
   * `HEAD` cannot satisfy a body requirement, so the probe skips the assertion.
   *
   * Measured with the real probe: `method: HEAD` with `expectBody` set reported a server **healthy**
   * whose body did not match the requirement, while the same config with `GET` correctly reported
   * unhealthy. A health check that silently stops checking is worse than one that fails, because a
   * failing one restarts or alerts and this one did neither.
   */
  it('warns when a HEAD probe is asked to check a body it cannot see', () => {
    const { errors, warnings } = parse([{
      id: 'app',
      command: 'node',
      health: { mode: 'http', http: { method: 'HEAD', expectBody: 'ready' } },
    }])

    expect(errors).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('"app"')
    expect(warnings[0]).toContain('HEAD')
    expect(warnings[0]).toContain('ignored')
  })

  it('says nothing for the combinations that work', () => {
    const cases = [
      // A body requirement with GET is checked normally.
      { mode: 'http', http: { method: 'GET', expectBody: 'ready' } },
      // HEAD with no body requirement asserts only the status.
      { mode: 'http', http: { method: 'HEAD', expectBody: '' } },
      // `port` mode never reads the response at all.
      { mode: 'port', http: { method: 'HEAD', expectBody: 'ready' } },
    ]
    for (const health of cases) {
      const { warnings } = parse([{ id: 'app', command: 'node', health }])
      expect(warnings, JSON.stringify(health)).toEqual([])
    }
  })
})

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
