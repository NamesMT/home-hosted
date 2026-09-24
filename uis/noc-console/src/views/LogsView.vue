<script setup lang="ts">
import type { LogLine } from '@shared/contracts'
import type { LogServerInfo } from '@/lib/api'
import { computed, onMounted, onScopeDispose, ref, watch } from 'vue'
import ConfirmButton from '@/components/ConfirmButton.vue'
import LogPane from '@/components/LogPane.vue'
import StatusChip from '@/components/StatusChip.vue'
import { resetLogs, unwatchLogs, watchLogs } from '@/composables/useControlPlane'
import { useKeyHandler } from '@/composables/useKeymap'
import { flash, useUi } from '@/composables/useUi'
import * as api from '@/lib/api'
import { formatBytes } from '@/lib/format'

const { selectedId } = useUi()

const servers = ref<LogServerInfo[]>([])
const mode = ref<'disk' | 'live'>('disk')
const tail = ref(500)
const search = ref('')
const stream = ref('')
const diskLines = ref<LogLine[]>([])
const liveLines = ref<LogLine[]>([])
const searched = ref<number | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

let liveId: string | null = null
let searchTimer: ReturnType<typeof setTimeout> | null = null

const current = computed(() => servers.value.find(server => server.serverId === selectedId.value) ?? null)

function message(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught)
}

async function loadServers(): Promise<void> {
  try {
    servers.value = await api.fetchLogServers()
    if (selectedId.value === null || !servers.value.some(server => server.serverId === selectedId.value))
      selectedId.value = servers.value[0]?.serverId ?? null
  }
  catch (caught) {
    error.value = message(caught)
  }
}

async function loadTail(): Promise<void> {
  const id = selectedId.value
  if (id === null)
    return
  loading.value = true
  error.value = null
  try {
    const history = await api.fetchLogHistory(id, {
      tail: tail.value,
      search: search.value,
      ...(stream.value.length > 0 ? { stream: stream.value } : {}),
    })
    diskLines.value = history.lines
    searched.value = history.searched
  }
  catch (caught) {
    error.value = message(caught)
  }
  finally {
    loading.value = false
  }
}

async function refresh(): Promise<void> {
  await loadServers()
  if (mode.value === 'disk')
    await loadTail()
  flash('logs refreshed')
}

async function clearFile(): Promise<void> {
  const id = selectedId.value
  if (id === null)
    return
  try {
    await api.clearLogHistory(id)
    diskLines.value = []
    resetLogs(id)
    await loadServers()
    flash(`${id}: stored logs cleared`)
  }
  catch (caught) {
    error.value = message(caught)
  }
}

function togglemode(): void {
  mode.value = mode.value === 'disk' ? 'live' : 'disk'
}

watch([selectedId, tail, stream], () => {
  if (mode.value === 'disk')
    void loadTail()
})

watch(search, () => {
  if (searchTimer)
    clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    if (mode.value === 'disk')
      void loadTail()
  }, 300)
})

watch(mode, (next) => {
  if (next === 'disk')
    void loadTail()
})

watch([selectedId, mode], ([id, next]) => {
  const previous = liveId
  if (previous !== null && (next !== 'live' || previous !== id)) {
    unwatchLogs(previous)
    liveId = null
  }
  if (next === 'live' && id !== null && liveId !== id) {
    liveLines.value = watchLogs(id)
    liveId = id
  }
}, { immediate: true })

useKeyHandler((key) => {
  switch (key) {
    case 'j':
    case 'k': {
      const list = servers.value
      if (list.length === 0)
        return true
      const index = list.findIndex(server => server.serverId === selectedId.value)
      const delta = key === 'j' ? 1 : -1
      const next = index === -1 ? 0 : (index + delta + list.length) % list.length
      selectedId.value = list[next]?.serverId ?? selectedId.value
      return true
    }
    case 'v':
    case 'Enter':
      togglemode()
      return true
    case 'R':
      void refresh()
      return true
    default:
      return false
  }
})

onMounted(async () => {
  await loadServers()
  await loadTail()
})

onScopeDispose(() => {
  if (liveId !== null)
    unwatchLogs(liveId)
  if (searchTimer)
    clearTimeout(searchTimer)
})
</script>

<template>
  <div class="view">
    <div class="view__head">
      <span class="view__title">logs</span>
      <span class="view__count">{{ servers.length }} server(s)</span>

      <select v-model="mode" title="source">
        <option value="disk">
          tail from disk
        </option>
        <option value="live">
          live stream
        </option>
      </select>
      <select v-model.number="tail" :disabled="mode === 'live'" title="lines">
        <option :value="200">
          200 lines
        </option>
        <option :value="500">
          500 lines
        </option>
        <option :value="2000">
          2000 lines
        </option>
      </select>
      <select v-model="stream" :disabled="mode === 'live'" title="stream">
        <option value="">
          all streams
        </option>
        <option value="stdout">
          stdout
        </option>
        <option value="stderr">
          stderr
        </option>
        <option value="system">
          system
        </option>
      </select>

      <label class="search">
        <span class="search__icon">/</span>
        <input v-model="search" data-filter type="search" :disabled="mode === 'live'" placeholder="search the tail window">
      </label>

      <span class="view__spacer" />

      <button type="button" class="btn btn--sm" :disabled="loading" @click="refresh">
        refresh <kbd class="kbd">R</kbd>
      </button>
      <ConfirmButton label="clear" confirm-label="confirm clear" tone="danger" :disabled="selectedId === null" @confirm="clearFile" />
    </div>

    <div class="logpage">
      <aside class="logpage__side">
        <div class="logsrv">
          <button
            v-for="server in servers"
            :key="server.serverId"
            type="button"
            class="logsrv__item"
            :class="{ 'logsrv__item--active': server.serverId === selectedId }"
            @click="selectedId = server.serverId"
          >
            <span class="row" style="gap: 0.35rem">
              <span class="led" :class="server.status === 'running' ? 'led--running' : 'led--stopped'" />
              <span class="mono">{{ server.label }}</span>
              <StatusChip :status="server.status" />
            </span>
            <span class="logsrv__meta">
              <span>{{ server.enabled ? formatBytes(server.sizeBytes) : 'not persisted' }}</span>
              <span v-if="server.files.length > 0">· {{ server.files.length }} file(s)</span>
            </span>
          </button>
          <p v-if="servers.length === 0" class="empty">
            no servers configured yet
          </p>
        </div>
      </aside>

      <div class="logpage__main">
        <div class="log__bar">
          <template v-if="current">
            <span class="accent mono">{{ current.serverId }}</span>
            <span v-if="current.enabled">{{ formatBytes(current.sizeBytes) }} on disk</span>
            <span v-else>persistence off — the live stream is all there is</span>
            <span v-if="searched !== null">· searched {{ searched }} lines</span>
            <span v-if="loading">· loading…</span>
          </template>
          <span class="view__spacer" />
          <a v-if="current?.enabled" :href="api.logDownloadUrl(current.serverId, `${current.serverId}.log`)">download {{ current.serverId }}.log</a>
        </div>

        <div v-if="current && current.files.length > 0" class="filelist">
          <div v-for="file in current.files" :key="file.name" class="filelist__row">
            <a :href="api.logDownloadUrl(current.serverId, file.name)">{{ file.name }}</a>
            <span class="size">{{ formatBytes(file.sizeBytes) }}</span>
          </div>
        </div>

        <p v-if="error" class="note note--error" style="margin: 0.4rem 0.6rem">
          {{ error }}
        </p>

        <LogPane
          :lines="mode === 'live' ? liveLines : diskLines"
          :live="mode === 'live'"
          :search="search"
          :empty="mode === 'live' ? 'waiting for output…' : (loading ? 'loading…' : 'nothing logged yet')"
        />
      </div>
    </div>
  </div>
</template>
