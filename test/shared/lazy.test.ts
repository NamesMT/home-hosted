import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { type } from 'arktype'
import { describe, expect, it, vi } from 'vitest'
import { lazy } from '#src/shared/lazy'

const packageRoot = fileURLToPath(new URL('../..', import.meta.url))

/**
 * `lazy()` stands in for an ArkType schema until first use. Everything that composes or calls a
 * schema must get the same answer it would from the schema itself.
 */
describe('lazy schemas', () => {
  const port = lazy(() => type('1 <= number.integer <= 65535'))
  const entry = lazy(() => type({ id: 'string', port }).onUndeclaredKey('reject'))

  it('builds on first use, once', () => {
    const build = vi.fn(() => type('string'))
    const schema = lazy(build)
    expect(build).not.toHaveBeenCalled()
    expect(schema('x')).toBe('x')
    expect(schema.allows(1)).toBe(false)
    expect(build).toHaveBeenCalledTimes(1)
  })

  it('composes as the real node: in an object, `.or`, `.array`, `type.or`', () => {
    expect(entry({ id: 'a', port: 80 })).toEqual({ id: 'a', port: 80 })
    expect(entry({ id: 'a', port: 0 })).toBeInstanceOf(type.errors)
    expect(entry({ id: 'a', port: 80, extra: 1 })).toBeInstanceOf(type.errors)

    const orNull = lazy(() => port.or('null'))
    expect(orNull(null)).toBeNull()
    expect(type({ ports: port.array() })({ ports: [1, 2] })).toEqual({ ports: [1, 2] })
    expect(type.or(port, 'string')('x')).toBe('x')
    // The composed node holds the real schema, not the wrapper, so its description is the real one.
    expect(type({ port }).expression).toBe(type({ port: type('1 <= number.integer <= 65535') }).expression)
  })

  it('answers methods, schema-valued properties and Standard Schema like the schema', () => {
    expect(() => port.assert(0)).toThrow()
    expect(port.assert(8080)).toBe(8080)
    expect(typeof port.in).toBe('function')
    expect(port.in.allows(1)).toBe(true)
    expect(port['~standard'].validate(22)).toEqual({ value: 22 })
    expect(port.toJsonSchema()).toEqual(type('1 <= number.integer <= 65535').toJsonSchema())
    expect('~standard' in port).toBe(true)
  })

  it('takes a default inside an object, built from the wrapper', () => {
    const bind = lazy(() => type('"local" | "lan"'))
    const withDefault = type({ bind: bind.default('local') })
    expect(withDefault({})).toEqual({ bind: 'local' })
  })
})

describe('the shared contracts', () => {
  it('builds nothing at import: a schema is paid for by the code that uses it', async () => {
    vi.resetModules()
    const { lazyBuilds } = await import('#src/shared/lazy')
    const before = lazyBuilds()
    await import('#src/shared/contracts')
    await import('#src/config/schema')
    expect(lazyBuilds() - before).toBe(0)
  })

  /**
   * A route module that composes a schema at its top level (`x.merge(y)`, an inline `type(...)`)
   * builds it — and everything it names — on import, which undoes the above for every `up`.
   */
  it('builds nothing when the route modules and the app are imported', async () => {
    vi.resetModules()
    const { lazyBuilds } = await import('#src/shared/lazy')
    const before = lazyBuilds()
    const dir = path.join(packageRoot, 'src/api')
    const modules = fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter(file => file.endsWith('.ts'))
    expect(modules.length).toBeGreaterThan(15)
    for (const file of modules)
      await import(pathToFileURL(path.join(dir, file)).href)
    await import('#src/app')
    expect(lazyBuilds() - before).toBe(0)
  })

  it('every exported schema builds — a definition error no longer fails the import, so this does', async () => {
    const contracts = await import('#src/shared/contracts')
    const schemas = Object.entries(contracts).filter(([name, value]) => name.endsWith('Schema') && typeof value === 'function')
    expect(schemas.length).toBeGreaterThan(100)
    const broken: string[] = []
    for (const [name, schema] of schemas) {
      try {
        const real = (schema as () => unknown)()
        if (typeof real !== 'function' || !('~standard' in real))
          broken.push(`${name}: not a schema`)
      }
      catch (error) {
        broken.push(`${name}: ${(error as Error).message}`)
      }
    }
    expect(broken).toEqual([])
  })
})
