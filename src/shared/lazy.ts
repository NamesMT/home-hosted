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

export function lazy<T extends object>(build: () => T): T {
  let built: T | undefined
  const real = (): T => {
    if (built === undefined) {
      built = build()
      builds += 1
    }
    return built
  }
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
