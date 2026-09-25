<script setup lang="ts">
import type { HealthState, ServerStatus, ServerView } from '@shared/contracts'
import Sparkline from '@/components/Sparkline.vue'
import StatusChip from '@/components/StatusChip.vue'
import { useControlPlane } from '@/composables/useControlPlane'
import { useUi } from '@/composables/useUi'
import { briefBytes, formatRatio, formatUptime } from '@/lib/format'

const props = defineProps<{
  servers: ServerView[]
  total: number
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

function cpuText(server: ServerView): string {
  const value = server.resources?.cpuPercent
  return value === null || value === undefined ? '—' : `${value.toFixed(0)}%`
}

function probeText(server: ServerView): string {
  return server.responseMs === null ? '—' : `${server.responseMs}ms`
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

function cpuColor(server: ServerView): string {
  const value = server.resources?.cpuPercent ?? 0
  if (value >= 80)
    return 'var(--danger)'
  if (value >= 40)
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
                <Sparkline :values="control.seriesOf(server.id).cpu" :color="cpuColor(server)" :width="54" :height="13" />
                <span class="num mono">{{ cpuText(server) }}</span>
              </span>
            </td>
            <td>
              <span class="row" style="gap: 0.35rem">
                <Sparkline :values="control.seriesOf(server.id).rss" color="var(--accent)" :width="54" :height="13" />
                <span class="num mono">{{ briefBytes(server.resources?.rssBytes ?? null) }}</span>
              </span>
            </td>
            <td class="num" :class="{ warn: (server.responseMs ?? 0) >= 1000 }">
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
