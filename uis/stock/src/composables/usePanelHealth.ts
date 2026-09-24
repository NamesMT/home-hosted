import { ref } from 'vue'

/**
 * The panel reports its own uptime from `/healthz` (outside `/api`, so it
 * answers without a session). One reading is enough: the start instant is
 * derived once and the UI ticks it locally.
 */
const startedAt = ref<number | null>(null)
const status = ref<'ok' | 'degraded' | 'unknown'>('unknown')
let loading: Promise<void> | null = null

async function load(): Promise<void> {
  try {
    const response = await fetch('/healthz', { cache: 'no-store' })
    const payload = await response.json() as { status?: string, uptimeMs?: number }
    if (typeof payload.uptimeMs === 'number')
      startedAt.value = Date.now() - payload.uptimeMs
    status.value = payload.status === 'degraded' ? 'degraded' : 'ok'
  }
  catch {
    status.value = 'unknown'
  }
}

export function usePanelHealth() {
  loading ??= load().finally(() => {
    loading = null
  })

  return {
    startedAt,
    status,
    refresh: load,
  }
}
