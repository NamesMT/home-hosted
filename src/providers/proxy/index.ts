import type { ProxyEngine } from '#src/providers/proxy/types'
import type { ProxyEngineInfo } from '#src/shared/contracts'
import { caddyEngine } from '#src/providers/proxy/caddy'

/** Registry order is what the page offers; one engine ships today. */
export const PROXY_ENGINES: readonly ProxyEngine[] = [caddyEngine]

const BY_ID = new Map(PROXY_ENGINES.map(engine => [engine.info.id, engine]))

export function proxyEngine(id: string): ProxyEngine | null {
  return BY_ID.get(id as ProxyEngineInfo['id']) ?? null
}

export function proxyEngineInfos(): ProxyEngineInfo[] {
  return PROXY_ENGINES.map(engine => engine.info)
}

export type { ProxyAdminTransport, ProxyEngine, ProxyEngineDownload, ProxyEngineRun, ProxyEngineTarget } from '#src/providers/proxy/types'
