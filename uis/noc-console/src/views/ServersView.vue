<script setup lang="ts">
import type { HealthState, ServerStatus, ServerView } from '@shared/contracts'
import { computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import ServerDetail from '@/components/ServerDetail.vue'
import Sparkline from '@/components/Sparkline.vue'
import StatusChip from '@/components/StatusChip.vue'
import { useControlPlane } from '@/composables/useControlPlane'
import { useKeyHandler } from '@/composables/useKeymap'
import { addOpen, flash, helpOpen, useUi } from '@/composables/useUi'
import { briefBytes, formatRatio, formatUptime } from '@/lib/format'

const control = useControlPlane()
const router = useRouter()
const { selectedId, filter, drawerOpen } = useUi()

const servers = computed<ServerView[]>(() => control.servers.value)

const visible = computed<ServerView[]>(() => {
  const needle = filter.value.trim().toLowerCase()
  if (needle.length === 0)
    return servers.value
  return servers.value.filter(server =>
    server.id.toLowerCase().includes(needle)
    || (server.config.label ?? '').toLowerCase().includes(needle),
  )
})

const selected = computed(() => control.serverById(selectedId.value))

watch(visible, (list) => {
  if (list.length === 0)
    return
  if (selectedId.value === null || !list.some(server => server.id === selectedId.value))
    selectedId.value = list[0]?.id ?? null
}, { immediate: true })

function move(delta: number): void {
  const list = visible.value
  if (list.length === 0)
    return
  const index = list.findIndex(server => server.id === selectedId.value)
  const next = index === -1 ? 0 : (index + delta + list.length) % list.length
  selectedId.value = list[next]?.id ?? selectedId.value
}

function edit(): void {
  const server = selected.value
  if (server)
    void router.push({ name: 'server-config', params: { id: server.id } })
}

function act(action: 'start' | 'stop' | 'restart'): void {
  const server = selected.value
  if (server)
    void control.act(server.id, action)
}

async function clearSelected(): Promise<void> {
  const server = selected.value
  if (!server)
    return
  await control.clearLogs(server.id)
  flash(`${server.id}: buffered logs cleared`)
}

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

useKeyHandler((key) => {
  switch (key) {
    case 'j':
      move(1)
      return true
    case 'k':
      move(-1)
      return true
    case 'Home': {
      const first = visible.value[0]
      if (first)
        selectedId.value = first.id
      return true
    }
    case 'G': {
      const last = visible.value[visible.value.length - 1]
      if (last)
        selectedId.value = last.id
      return true
    }
    case 's':
      act('start')
      return true
    case 'x':
      act('stop')
      return true
    case 'r':
      act('restart')
      return true
    case 'e':
    case 'Enter':
      edit()
      return true
    case 'l':
      if (selected.value)
        drawerOpen.value = !drawerOpen.value
      return true
    case 'c':
      void clearSelected()
      return true
    default:
      return false
  }
})

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
  <div class="view">
    <div class="view__head">
      <span class="view__title">servers</span>
      <span class="view__count">{{ control.runningCount.value }}/{{ servers.length }} running</span>

      <label class="search">
        <span class="search__icon">/</span>
        <input v-model="filter" data-filter type="search" placeholder="filter by id or label">
      </label>
      <span v-if="filter.trim().length > 0" class="view__count">{{ visible.length }} shown</span>

      <span class="view__spacer" />

      <button type="button" class="btn btn--sm" title="keyboard shortcuts" @click="helpOpen = true">
        keys <kbd class="kbd">?</kbd>
      </button>
      <button type="button" class="btn btn--sm" @click="control.startAll()">
        start all
      </button>
      <button type="button" class="btn btn--sm" @click="control.stopAll()">
        stop all
      </button>
      <button type="button" class="btn btn--sm btn--primary" @click="addOpen = true">
        add <kbd class="kbd">a</kbd>
      </button>
    </div>

    <p v-if="control.configError.value" class="banner banner--warn">
      <strong>config problem</strong>
      <span>{{ control.configError.value }}</span>
      <code>{{ control.appState.value?.configPath }}</code>
    </p>

    <div class="split">
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
                v-for="server in visible"
                :key="server.id"
                :class="{ 'is-selected': server.id === selectedId, 'is-dim': !server.config.enabled }"
                @click="selectedId = server.id"
                @dblclick="selectedId = server.id; edit()"
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
                    <button type="button" class="btn btn--xs btn--icon" title="start (s)" @click.stop="control.act(server.id, 'start')">s</button>
                    <button type="button" class="btn btn--xs btn--icon" title="stop (x)" @click.stop="control.act(server.id, 'stop')">x</button>
                    <button type="button" class="btn btn--xs btn--icon" title="restart (r)" @click.stop="control.act(server.id, 'restart')">r</button>
                    <button type="button" class="btn btn--xs btn--icon" title="edit config (e)" @click.stop="selectedId = server.id; edit()">e</button>
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
          <p v-if="servers.length === 0" class="empty">
            no servers configured — press <kbd class="kbd">a</kbd> to add one, or edit
            <code>{{ control.appState.value?.configPath }}</code>
          </p>
          <p v-else-if="visible.length === 0" class="empty">
            nothing matches “{{ filter }}”
          </p>
        </div>
      </div>

      <ServerDetail v-if="selected" :server="selected" :now="control.now.value" />
      <p v-else class="empty">
        select a server to see its detail
      </p>
    </div>
  </div>
</template>
