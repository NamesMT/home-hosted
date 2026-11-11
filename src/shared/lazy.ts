/**
 * A schema that is built the first time something uses it.
 *
 * Building every ArkType schema in `contracts.ts` took ~1.2 s at import — longer than most CLI
 * commands then ran, paid by every command, every spawned test child and every UI load, for schemas
 * the caller never touched. The wrapper is typed as the schema itself, so nothing that imports it
 * changes.
 *
 * It is a zero-length function on purpose: ArkType resolves a zero-argument function handed to it
 * as a definition by calling it (a thunk), so `type({ a: lazySchema })`, `.or(lazySchema)` and
 * friends receive the real node, never this wrapper. Called with arguments it validates, like the
 * schema it stands for.
 */
let builds = 0

/** How many lazy schemas have been built so far, so a test can prove an import built none. */
export function lazyBuilds(): number {
  return builds
}

/**
 * Every lazy schema declared so far, in declaration order.
 *
 * A definition error in a schema no longer fails the import — that is the point of `lazy` — so
 * something has to actually build them to find one. `test/shared/lazy.test.ts` used to walk the
 * **exports** of `contracts.ts` for that, which meant a schema that stopped being exported also
 * stopped being checked (found the hard way: un-exporting 58 internal-only schemas silently took the
 * guard's coverage from 153 to 95 and the test said so). Registering here instead makes the check
 * cover every schema the module declares, exported or not.
 *
 * Bounded: `lazy()` is called at module scope once per schema, so this holds one thunk per schema
 * for the life of the process.
 */
const declared: Array<() => unknown> = []

export function lazySchemas(): ReadonlyArray<() => unknown> {
  return declared
}

export function lazy<T extends object>(build: () => T): T {
  let built: T | undefined
  const real = (): T => {
    if (built === undefined) {
      built = build()
      builds += 1
    }
    return built
  }
  // Registered once per schema, at module scope, so the build-guard test can reach every one.
  declared.push(real)
  /** Methods bound once to the real schema, so `this` inside ArkType is never the wrapper. */
  const bound = new Map<PropertyKey, unknown>()

  return new Proxy((() => undefined) as unknown as T, {
    apply(_target, thisArg, args: unknown[]) {
      const schema = real()
      return args.length === 0 ? schema : Reflect.apply(schema as (...a: unknown[]) => unknown, thisArg, args)
    },
    get(_target, key) {
      // ArkType's thunk test reads `length`; the real schema's is not 0.
      if (key === 'length')
        return 0
      const schema = real()
      const value: unknown = Reflect.get(schema, key, schema)
      // A schema-valued property (`.in`, `.internal`) is returned as it is; a method is bound.
      if (typeof value !== 'function' || '~standard' in value)
        return value
      let method = bound.get(key)
      if (method === undefined) {
        method = (value as (...a: unknown[]) => unknown).bind(schema)
        bound.set(key, method)
      }
      return method
    },
    has: (_target, key) => Reflect.has(real(), key),
    getPrototypeOf: () => Reflect.getPrototypeOf(real()),
  })
}
