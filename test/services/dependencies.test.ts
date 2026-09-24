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

  it('reports the transitive dependencies of a server', () => {
    const list = servers([['app', ['db']], ['db', ['disk']], ['disk', []], ['other', []]])
    const app = list.find(entry => entry.id === 'app')!
    expect(names(dependenciesOf(app, list))).toEqual(['db', 'disk'])
  })

  it('reports who must stop before a server', () => {
    const list = servers([['app', ['db']], ['db', ['disk']], ['disk', []], ['other', []]])
    const db = list.find(entry => entry.id === 'db')!
    expect(names(dependentsOf(db, list))).toEqual(['app'])
  })
})
