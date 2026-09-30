import type { ProxyEngineInfo } from '#src/shared/contracts'

/**
 * How the panel reaches a running engine's admin endpoint. A unix socket is the
 * default where there is one — the engine's admin API is unauthenticated, so file
 * permissions are the only real control. Windows gets loopback TCP plus the
 * engine's own origin check, which the client must then satisfy.
 */
export type ProxyAdminTransport
  = | { kind: 'unix', path: string }
    | { kind: 'tcp', host: string, port: number, origin: string }

export interface ProxyEngineTarget {
  platform: NodeJS.Platform
  arch: string
  /** The release to install; empty asks for the engine's pinned one. */
  version: string
}

export interface ProxyEngineDownload {
  url: string
  /** What the URL installs, recorded so an unplanned change is visible. */
  version: string
}

export interface ProxyEngineRun {
  /** The generated configuration the engine boots from. */
  configPath: string
  /** The directory the engine may write inside; nothing else is its. */
  engineDir: string
  admin: ProxyAdminTransport
}

/**
 * One reverse-proxy engine. Deliberately thin: the route model is the panel's,
 * so an engine only has to say where it comes from and how to start it.
 */
export interface ProxyEngine {
  readonly info: ProxyEngineInfo
  /** The release installed when nothing else is asked for. */
  readonly pinnedVersion: string
  /** The platform's executable name for this engine. */
  binaryName: (platform: NodeJS.Platform) => string
  /** Where to fetch it; `null` when this platform is not supported. */
  download: (target: ProxyEngineTarget) => ProxyEngineDownload | null
  /** The argument vector that runs it against the generated config. */
  runArgs: (run: ProxyEngineRun) => string[]
  /** Environment keeping its data inside `engineDir` on this platform. */
  env: (run: ProxyEngineRun) => Record<string, string>
  /** Reads a version out of the engine's own `version` output. */
  parseVersion: (output: string) => string | null
}
