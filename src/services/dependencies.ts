import type { ServerConfig } from '#src/shared/contracts'

/**
 * Orders servers so every dependency comes before its dependents.
 *
 * Cycles and unknown ids are ignored here — the config store reports them as
 * config errors — so this can never throw and stall supervision.
 */
export function orderByDependencies(servers: ServerConfig[]): ServerConfig[] {
  const byId = new Map(servers.map(server => [server.id, server]))
  const ordered: ServerConfig[] = []
  const visited = new Set<string>()

  const visit = (server: ServerConfig): void => {
    if (visited.has(server.id))
      return
    visited.add(server.id)
    for (const dependency of server.dependsOn) {
      const target = byId.get(dependency)
      if (target && target.id !== server.id)
        visit(target)
    }
    ordered.push(server)
  }

  for (const server of servers) visit(server)
  return ordered
}

/** The transitive dependencies of a server, nearest first. */
export function dependenciesOf(server: ServerConfig, servers: ServerConfig[]): ServerConfig[] {
  const byId = new Map(servers.map(entry => [entry.id, entry]))
  const found: ServerConfig[] = []
  const seen = new Set<string>()

  const walk = (current: ServerConfig): void => {
    for (const dependency of current.dependsOn) {
      if (seen.has(dependency))
        continue
      seen.add(dependency)
      const target = byId.get(dependency)
      if (!target)
        continue
      found.push(target)
      walk(target)
    }
  }

  walk(server)
  return found
}

/** Dependents that must stop before this server does. */
export function dependentsOf(server: ServerConfig, servers: ServerConfig[]): ServerConfig[] {
  return servers.filter(entry => entry.id !== server.id && dependenciesOf(entry, servers).some(d => d.id === server.id))
}
