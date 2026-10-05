import type { AppDeps } from '#src/app'
import type { ServerView } from '#src/shared/contracts'
import { describeRoute } from 'hono-openapi'
import { appFactory } from '#src/helpers/factory'

/**
 * Escapes a value for the quoted form of a Prometheus label, per the exposition
 * format: only `\\`, `"` and a newline are special, and each needs a backslash.
 *
 * A raw Windows path is the reachable case — `diskPaths` is user config and
 * `C:\Users\me` emits `\U`, which is not a valid escape, so the scraper rejects the
 * whole sample. The ids are charset-constrained by their schemas, but the paths are not.
 */
function labelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

/** A server id repeats across workspaces, so every sample names both. */
function labels(server: ServerView): string {
  return `server="${labelValue(server.id)}",workspace="${labelValue(server.workspaceId ?? '')}"`
}

/**
 * Prometheus text for whatever wants to scrape the panel (Beszel, Grafana,
 * `curl`). Lives under `/api`, so it needs a session like every other route.
 *
 * It aggregates every workspace: each per-server sample carries its
 * `workspace` label so a same-named server in another unit is still distinct.
 */
export function createMetricsRoute(deps: AppDeps) {
  return appFactory.createApp()
    .get('/metrics', describeRoute({
      tags: ['panel'],
      summary: 'Prometheus text for whatever scrapes the panel',
      responses: { 200: { description: 'text/plain; version=0.0.4' } },
    }), (c) => {
      const servers = deps.panel.serverViews()
      const host = deps.panel.getState().host
      const lines: string[] = []

      const metric = (name: string, help: string, samples: string[]): void => {
        if (samples.length === 0)
          return
        lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, ...samples)
      }

      metric('hh_control_up', 'Control plane is serving', ['hh_control_up 1'])
      metric('hh_servers_total', 'Configured servers', [`hh_servers_total ${servers.length}`])

      const up = servers.map(server => `hh_server_up{${labels(server)}} ${server.status === 'running' ? 1 : 0}`)
      metric('hh_server_up', 'Server process is running', up)

      const restarts = servers.map(server => `hh_server_restarts_total{${labels(server)}} ${server.restarts}`)
      metric('hh_server_restarts_total', 'Restarts since the control plane started', restarts)

      const crashes = servers.map(server => `hh_server_crashes_24h{${labels(server)}} ${server.history.crashes}`)
      metric('hh_server_crashes_24h', 'Crashes in the last 24 hours', crashes)

      const uptime = servers
        .filter(server => server.history.uptimeRatio !== null)
        .map(server => `hh_server_uptime_ratio_24h{${labels(server)}} ${server.history.uptimeRatio!.toFixed(4)}`)
      metric('hh_server_uptime_ratio_24h', 'Share of the last 24 hours the server was up', uptime)

      const response = servers
        .filter(server => server.responseMs !== null)
        .map(server => `hh_server_response_ms{${labels(server)}} ${server.responseMs}`)
      metric('hh_server_response_ms', 'Last health probe latency in milliseconds', response)

      const rss = servers
        .filter(server => server.resources?.rssBytes != null)
        .map(server => `hh_server_rss_bytes{${labels(server)}} ${server.resources!.rssBytes}`)
      metric('hh_server_rss_bytes', 'RSS of the server process tree', rss)

      const cpu = servers
        .filter(server => server.resources?.cpuPercent != null)
        .map(server => `hh_server_cpu_percent{${labels(server)}} ${server.resources!.cpuPercent}`)
      metric('hh_server_cpu_percent', 'CPU percent of the server process tree', cpu)

      const disks = host.disks.map(disk => `hh_host_disk_used_percent{mount="${labelValue(disk.path)}"} ${disk.usedPercent.toFixed(2)}`)
      metric('hh_host_disk_used_percent', 'Disk usage percent per configured path', disks)

      metric('hh_host_memory_used_percent', 'Memory usage percent', [`hh_host_memory_used_percent ${host.memoryUsedPercent.toFixed(2)}`])
      metric('hh_host_swap_used_percent', 'Swap usage percent', [`hh_host_swap_used_percent ${host.swapUsedPercent.toFixed(2)}`])
      metric('hh_host_load1_per_cpu', '1 minute load average per cpu', [
        `hh_host_load1_per_cpu ${((host.loadAvg[0] ?? 0) / Math.max(1, host.cpus)).toFixed(3)}`,
      ])

      return c.text(`${lines.join('\n')}\n`, 200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' })
    })
}
