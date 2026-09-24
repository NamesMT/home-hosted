import type { AppDeps } from '#src/app'
import { describeRoute } from 'hono-openapi'
import { appFactory } from '#src/helpers/factory'

/**
 * Prometheus text for whatever wants to scrape the panel (Beszel, Grafana,
 * `curl`). Lives under `/api`, so it needs a session like every other route.
 */
export function createMetricsRoute(deps: AppDeps) {
  return appFactory.createApp()
    .get('/metrics', describeRoute({
      tags: ['panel'],
      summary: 'Prometheus text for whatever scrapes the panel',
      responses: { 200: { description: 'text/plain; version=0.0.4' } },
    }), (c) => {
      const state = deps.supervisor.getState()
      const lines: string[] = []

      const metric = (name: string, help: string, samples: string[]): void => {
        if (samples.length === 0)
          return
        lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, ...samples)
      }

      metric('hh2_control_up', 'Control plane is serving', ['hh2_control_up 1'])
      metric('hh2_servers_total', 'Configured servers', [`hh2_servers_total ${state.servers.length}`])

      const up = state.servers.map(server => `hh2_server_up{server="${server.id}"} ${server.status === 'running' ? 1 : 0}`)
      metric('hh2_server_up', 'Server process is running', up)

      const restarts = state.servers.map(server => `hh2_server_restarts_total{server="${server.id}"} ${server.restarts}`)
      metric('hh2_server_restarts_total', 'Restarts since the control plane started', restarts)

      const crashes = state.servers.map(server => `hh2_server_crashes_24h{server="${server.id}"} ${server.history.crashes}`)
      metric('hh2_server_crashes_24h', 'Crashes in the last 24 hours', crashes)

      const uptime = state.servers
        .filter(server => server.history.uptimeRatio !== null)
        .map(server => `hh2_server_uptime_ratio_24h{server="${server.id}"} ${server.history.uptimeRatio!.toFixed(4)}`)
      metric('hh2_server_uptime_ratio_24h', 'Share of the last 24 hours the server was up', uptime)

      const response = state.servers
        .filter(server => server.responseMs !== null)
        .map(server => `hh2_server_response_ms{server="${server.id}"} ${server.responseMs}`)
      metric('hh2_server_response_ms', 'Last health probe latency in milliseconds', response)

      const rss = state.servers
        .filter(server => server.resources?.rssBytes != null)
        .map(server => `hh2_server_rss_bytes{server="${server.id}"} ${server.resources!.rssBytes}`)
      metric('hh2_server_rss_bytes', 'RSS of the server process tree', rss)

      const cpu = state.servers
        .filter(server => server.resources?.cpuPercent != null)
        .map(server => `hh2_server_cpu_percent{server="${server.id}"} ${server.resources!.cpuPercent}`)
      metric('hh2_server_cpu_percent', 'CPU percent of the server process tree', cpu)

      const disks = state.host.disks.map(disk => `hh2_host_disk_used_percent{mount="${disk.path}"} ${disk.usedPercent.toFixed(2)}`)
      metric('hh2_host_disk_used_percent', 'Disk usage percent per configured path', disks)

      metric('hh2_host_memory_used_percent', 'Memory usage percent', [`hh2_host_memory_used_percent ${state.host.memoryUsedPercent.toFixed(2)}`])
      metric('hh2_host_swap_used_percent', 'Swap usage percent', [`hh2_host_swap_used_percent ${state.host.swapUsedPercent.toFixed(2)}`])
      metric('hh2_host_load1_per_cpu', '1 minute load average per cpu', [
        `hh2_host_load1_per_cpu ${((state.host.loadAvg[0] ?? 0) / Math.max(1, state.host.cpus)).toFixed(3)}`,
      ])

      return c.text(`${lines.join('\n')}\n`, 200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' })
    })
}
