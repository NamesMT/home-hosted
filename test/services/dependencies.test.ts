import { type } from 'arktype'
import { describe, expect, it } from 'vitest'
import { dependenciesOf, dependentsOf, orderByDependencies } from '#src/services/dependencies'
import { serverSchema } from '#src/shared/contracts'

function servers(spec: Array<[string, string[]]>) {
  return spec.map(([id, dependsOn]) => {
    const parsed = serverSchema({ id, command: 'node', dependsOn })
    if (parsed instanceof type.errors)
      throw new Error(parsed.summary)
    return { ...parsed, port: parsed.port ?? null }
  })
}

const names = (list: Array<{ id: string }>) => list.map(entry => entry.id)

describe('dependency ordering', () => {
  it('puts every dependency before its dependent', () => {
    const list = servers([['app', ['db', 'cache']], ['db', []], ['cache', ['db']], ['proxy', ['app']]])
    expect(names(orderByDependencies(list))).toEqual(['db', 'cache', 'app', 'proxy'])
  })

  it('keeps independent servers in their original order', () => {
    const list = servers([['a', []], ['b', []], ['c', []]])
    expect(names(orderByDependencies(list))).toEqual(['a', 'b', 'c'])
  })

  it('ignores unknown ids and cycles instead of failing', () => {
    const list = servers([['a', ['ghost']], ['x', ['y']], ['y', ['x']]])
    const ordered = orderByDependencies(list)
    expect(ordered).toHaveLength(3)
    expect(names(ordered)).toContain('a')
  })

  /**
   * **Deepest first**, because that is the order they have to be *started* in.
   *
   * This asserted `['db', 'disk']`, which is not topological: `db` depends on `disk`, so starting `db`
   * first means starting it without its own dependency running. `startDependencies` walks this list in
   * order and awaits each one's readiness, so the order is the behaviour.
   */
  it('reports the transitive dependencies of a server, deepest first', () => {
    const list = servers([['app', ['db']], ['db', ['disk']], ['disk', []], ['other', []]])
    const app = list.find(entry => entry.id === 'app')!
    expect(names(dependenciesOf(app, list))).toEqual(['disk', 'db'])
  })

  it('orders every entry after the dependencies it needs', () => {
    // `a -> [b, c], b -> [x], c -> [b]`: `b` must follow `x`, and pushing before recursing put it first.
    const list = servers([['a', ['b', 'c']], ['b', ['x']], ['c', ['b']], ['x', []]])
    const ordered = names(dependenciesOf(list[0]!, list))
    const position = new Map(ordered.map((id, index) => [id, index]))
    const violations = ordered.filter((id) => {
      const server = list.find(entry => entry.id === id)!
      return server.dependsOn.some(dependency => position.has(dependency) && position.get(dependency)! > position.get(id)!)
    })
    expect(violations, 'a dependency must not follow something that depends on it').toEqual([])
  })

  it('reports who must stop before a server', () => {
    const list = servers([['app', ['db']], ['db', ['disk']], ['disk', []], ['other', []]])
    const db = list.find(entry => entry.id === 'db')!
    expect(names(dependentsOf(db, list))).toEqual(['app'])
  })
})
