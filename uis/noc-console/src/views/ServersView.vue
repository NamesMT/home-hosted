<script setup lang="ts">
import type { ServerView } from '@shared/contracts'
import { Pane, Splitpanes } from 'splitpanes'
import { computed, reactive, watch } from 'vue'
import { useRouter } from 'vue-router'
import ServerDetail from '@/components/ServerDetail.vue'
import ServerList from '@/components/ServerList.vue'
import { useControlPlane } from '@/composables/useControlPlane'
import { useKeyHandler } from '@/composables/useKeymap'
import { useMediaQuery } from '@/composables/useMediaQuery'
import { addOpen, flash, helpOpen, useUi } from '@/composables/useUi'

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

/** The split is wrong on a phone; the same content stacks and the page scrolls instead. */
const isNarrow = useMediaQuery('(width <= 860px)')

const PANES_KEY = 'noc.panes.servers'
const DEFAULT_SIZES = { list: 46, detail: 54 }

function clampSize(value: number): number {
  return Math.min(88, Math.max(12, value))
}

function storedSizes(): { list: number, detail: number } {
  try {
    const raw = window.localStorage.getItem(PANES_KEY)
    if (raw === null)
      return { ...DEFAULT_SIZES }
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.length !== 2)
      return { ...DEFAULT_SIZES }
    const [list, detail] = parsed as unknown[]
    if (typeof list !== 'number' || typeof detail !== 'number' || !Number.isFinite(list) || !Number.isFinite(detail))
      return { ...DEFAULT_SIZES }
    return { list: clampSize(list), detail: clampSize(detail) }
  }
  catch {
    return { ...DEFAULT_SIZES }
  }
}

const sizes = reactive(storedSizes())

interface ResizePayload {
  panes: { size: number }[]
}

function onResized(payload: ResizePayload): void {
  const [first, second] = payload.panes
  if (first === undefined || second === undefined)
    return
  sizes.list = first.size
  sizes.detail = second.size
  try {
    window.localStorage.setItem(PANES_KEY, JSON.stringify([sizes.list, sizes.detail]))
  }
  catch {
    // A full or unavailable storage is never worth interrupting the layout for.
  }
}

function move(delta: number): void {
  const list = visible.value
  if (list.length === 0)
    return
  const index = list.findIndex(server => server.id === selectedId.value)
  const next = index === -1 ? 0 : (index + delta + list.length) % list.length
  selectedId.value = list[next]?.id ?? selectedId.value
}

function editTo(id: string): void {
  void router.push({ name: 'server-config', params: { id } })
}

function edit(): void {
  const server = selected.value
  if (server)
    editTo(server.id)
}

function actOn(id: string, action: 'start' | 'stop' | 'restart'): void {
  void control.act(id, action)
}

function act(action: 'start' | 'stop' | 'restart'): void {
  const server = selected.value
  if (server)
    actOn(server.id, action)
}

async function clearServer(id: string): Promise<void> {
  await control.clearLogs(id)
  flash(`${id}: buffered logs cleared`)
}

async function clearSelected(): Promise<void> {
  const server = selected.value
  if (server)
    await clearServer(server.id)
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

    <Splitpanes
      v-if="!isNarrow"
      class="split-panes split-panes--servers"
      horizontal
      @resized="onResized"
    >
      <Pane :size="sizes.list" :min-size="15" :max-size="85">
        <ServerList
          :servers="visible"
          :total="servers.length"
          :config-path="control.appState.value?.configPath ?? null"
          @select="selectedId = $event"
          @edit="editTo"
          @act="actOn"
          @clear="clearServer"
        />
      </Pane>
      <Pane :size="sizes.detail" :min-size="15" :max-size="85">
        <ServerDetail v-if="selected" :server="selected" :now="control.now.value" />
        <p v-else class="empty">
          select a server to see its detail
        </p>
      </Pane>
    </Splitpanes>

    <div v-else class="split split--stacked">
      <ServerList
        :servers="visible"
        :total="servers.length"
        :config-path="control.appState.value?.configPath ?? null"
        @select="selectedId = $event"
        @edit="editTo"
        @act="actOn"
        @clear="clearServer"
      />
      <ServerDetail v-if="selected" :server="selected" :now="control.now.value" />
      <p v-else class="empty">
        select a server to see its detail
      </p>
    </div>
  </div>
</template>
