import os from 'node:os'

export function lanAddress(): string | null {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal)
        return entry.address
    }
  }
  return null
}

export function bindHost(bind: string): string {
  if (bind === 'local')
    return '127.0.0.1'
  if (bind === 'lan')
    return '0.0.0.0'
  return bind
}

/** Address a human should open, which is never `0.0.0.0`. */
export function displayHost(bind: string): string {
  if (bind === 'local')
    return '127.0.0.1'
  if (bind === 'lan')
    return lanAddress() ?? '127.0.0.1'
  return bind
}

/** True when the bind value makes the port reachable from outside this machine. */
export function isExposed(bind: string): boolean {
  return bindHost(bind) !== '127.0.0.1'
}
