<script setup lang="ts">
import type { HealthState, ServerStatus, ServerView } from '@shared/contracts'
import { liveReadings } from '@shared/server-readings'
import Sparkline from '@/components/Sparkline.vue'
import StatusChip from '@/components/StatusChip.vue'
import { useControlPlane } from '@/composables/useControlPlane'
import { useUi } from '@/composables/useUi'
import { briefBytes, formatRatio, formatUptime } from '@/lib/format'

const props = defineProps<{
  servers: ServerView[]
  total: number
  workspaceId: string
  configPath: string | null
}>()

const emit = defineEmits<{
  select: [id: string]
  edit: [id: string]
  act: [id: string, action: 'start' | 'stop' | 'restart']
  clear: [id: string]
}>()

const control = useControlPlane()
const { selectedId, filter } = useUi()

// The probe latency and the CPU/RSS sample are one process's numbers, so a stopped entry has none
// — not a stale one from the process that just ended. Read through the shared predicate: a newer
// UI can meet an older panel that kept them across an adopted entry's stop.
function cpuText(server: ServerView): string {
  const value = liveReadings(server).cpuPercent
  return value === null ? '—' : `${value.toFixed(0)}%`
}

function probeText(server: ServerView): string {
  const value = liveReadings(server).responseMs
  return value === null ? '—' : `${value}ms`
}

function uptimeText(server: ServerView): string {
  if (server.startedAt === null || server.status !== 'running')
    return '—'
  return formatUptime(control.now.value - server.startedAt)
}

function ledFor(status: ServerStatus): string {
  return {
    running: 'led--running',
    starting: 'led--starting',
    stopping: 'led--stopped',
    stopped: 'led--stopped',
    backoff: 'led--starting',
    crashed: 'led--crashed',
    conflict: 'led--crashed',
  }[status]
}

function healthLed(health: HealthState): string {
  return {
    disabled: 'led--stopped',
    unknown: 'led--stopped',
    healthy: 'led--healthy',
    unhealthy: 'led--unhealthy',
  }[health]
}

/**
 * CPU is summed over the entry's process tree, so it counts *cores*: 400% is four cores busy, not
 * an error. These bands are a share of this machine, so they scale with its core count — at a
 * fixed 80/40 a busy worker on a 24-core host was painted red for using a sixth of the box.
 */
function cpuColor(server: ServerView): string {
  const value = liveReadings(server).cpuPercent ?? 0
  const capacity = Math.max(100, (control.host.value?.cpus ?? 1) * 100)
  if (value >= capacity * 0.8)
    return 'var(--danger)'
  if (value >= capacity * 0.4)
    return 'var(--warn)'
  return 'var(--accent)'
}
</script>

<template>
  <div class="split__half--list">
    <div class="tblwrap">
      <table class="tbl">
        <thead>
          <tr>
            <th class="tbl__gutter" />
            <th>id</th>
            <th>state</th>
            <th class="num">
              pid
            </th>
            <th class="num">
              port
            </th>
            <th>bind</th>
            <th class="num">
              uptime
            </th>
            <th class="num">
              rst
            </th>
            <th>cpu</th>
            <th>rss</th>
            <th class="num">
              probe
            </th>
            <th class="num">
              24h up
            </th>
            <th class="tbl__actions">
              act
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="server in props.servers"
            :key="server.id"
            :class="{ 'is-selected': server.id === selectedId, 'is-dim': !server.config.enabled }"
            @click="emit('select', server.id)"
            @dblclick="emit('select', server.id); emit('edit', server.id)"
          >
            <td class="tbl__gutter">
              <span class="led" :class="ledFor(server.status)" />
            </td>
            <td>
              <span class="id">{{ server.id }}</span>
              <span v-if="server.config.label" class="dim"> {{ server.config.label }}</span>
            </td>
            <td>
              <StatusChip :status="server.status" />
              <span
                class="led"
                :class="healthLed(server.health)"
                :title="`health: ${server.health}`"
                style="margin-left: 5px"
              />
            </td>
            <td class="num">
              {{ server.pid ?? '—' }}
            </td>
            <td class="num" :class="{ accent: server.portState === 'in-use' }">
              {{ server.config.port ?? '—' }}
            </td>
            <td class="dim" :title="server.bindHost">
              {{ server.bindHost }}
            </td>
            <td class="num">
              {{ uptimeText(server) }}
            </td>
            <td class="num">
              {{ server.restarts }}<span class="faint">/{{ server.maxRetries }}</span>
            </td>
            <td>
              <span class="row" style="gap: 0.35rem">
                <Sparkline :values="control.seriesOf(workspaceId, server.id).cpu" :color="cpuColor(server)" :width="54" :height="13" />
                <span class="num mono">{{ cpuText(server) }}</span>
              </span>
            </td>
            <td>
              <span class="row" style="gap: 0.35rem">
                <Sparkline :values="control.seriesOf(workspaceId, server.id).rss" color="var(--accent)" :width="54" :height="13" />
                <span class="num mono">{{ briefBytes(liveReadings(server).rssBytes) }}</span>
              </span>
            </td>
            <td class="num" :class="{ warn: (liveReadings(server).responseMs ?? 0) >= 1000 }">
              {{ probeText(server) }}
            </td>
            <td class="num">
              {{ formatRatio(server.history.uptimeRatio) }}
            </td>
            <td class="tbl__actions">
              <span class="rowbtns">
                <button type="button" class="btn btn--xs btn--icon" title="start (s)" @click.stop="emit('act', server.id, 'start')">s</button>
                <button type="button" class="btn btn--xs btn--icon" title="stop (x)" @click.stop="emit('act', server.id, 'stop')">x</button>
                <button type="button" class="btn btn--xs btn--icon" title="restart (r)" @click.stop="emit('act', server.id, 'restart')">r</button>
                <button type="button" class="btn btn--xs btn--icon" title="edit config (e)" @click.stop="emit('select', server.id); emit('edit', server.id)">e</button>
              </span>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="total === 0" class="empty">
        no servers configured — press <kbd class="kbd">a</kbd> to add one, or edit
        <code>{{ configPath ?? '—' }}</code>
      </p>
      <p v-else-if="props.servers.length === 0" class="empty">
        nothing matches “{{ filter }}”
      </p>
    </div>
  </div>
</template>
