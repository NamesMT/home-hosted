<script setup lang="ts">
import type { LogLine } from '@shared/contracts'
import { ArrowDownToLine, CircleAlert, FileText, RefreshCw, ScrollText, Trash2 } from 'lucide-vue-next'
import { computed, onMounted, onScopeDispose, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import LogViewer from '@/components/log/LogViewer.vue'
import AppButton from '@/components/ui/AppButton.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import Modal from '@/components/ui/Modal.vue'
import SegmentedControl from '@/components/ui/SegmentedControl.vue'
import SelectField from '@/components/ui/SelectField.vue'
import Skeleton from '@/components/ui/Skeleton.vue'
import { useServerLogs } from '@/composables/useControlPlane'
import * as api from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatBytes } from '@/lib/format'
import { STATUS_META, TONE_DOT } from '@/lib/status'

const route = useRoute()
const router = useRouter()

const servers = ref<api.LogServerInfo[]>([])
const selected = ref<string | null>(null)
const mode = ref<'disk' | 'live'>('disk')
const tail = ref('2000')
const loading = ref(false)
const error = ref<string | null>(null)
const diskLines = ref<LogLine[]>([])
const diskVersion = ref(0)
const confirmClear = ref(false)
const listLoading = ref(true)

const current = computed(() => servers.value.find(server => server.serverId === selected.value) ?? null)

const logs = useServerLogs(() => (mode.value === 'live' ? selected.value : null))
const liveVersions = ref(0)
const liveLines = computed(() => {
  void liveVersions.value
  return logs.lines()
})

let lastLiveCount = -1
const liveClock = setInterval(() => {
  const count = logs.count.value
  if (count !== lastLiveCount) {
    lastLiveCount = count
    liveVersions.value += 1
  }
}, 250)

onScopeDispose(() => clearInterval(liveClock))

const lines = computed<LogLine[]>(() => (mode.value === 'live' ? liveLines.value : diskLines.value))
const version = computed(() => (mode.value === 'live' ? liveVersions.value : diskVersion.value))

const tailOptions = [
  { value: '200', label: '200 lines' },
  { value: '500', label: '500 lines' },
  { value: '2000', label: '2000 lines' },
  { value: '5000', label: '5000 lines' },
]

const totalPersisted = computed(() => servers.value.reduce((sum, server) => sum + server.sizeBytes, 0))
const persistedCount = computed(() => servers.value.filter(server => server.files.length > 0).length)

async function loadServers(): Promise<void> {
  listLoading.value = true
  try {
    servers.value = await api.fetchLogServers()
    const fromQuery = typeof route.query.server === 'string' ? route.query.server : null
    const candidate = fromQuery && servers.value.some(server => server.serverId === fromQuery)
      ? fromQuery
      : selected.value && servers.value.some(server => server.serverId === selected.value)
        ? selected.value
        : servers.value[0]?.serverId ?? null
    selected.value = candidate
  }
  catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  }
  finally {
    listLoading.value = false
  }
}

async function loadTail(): Promise<void> {
  const id = selected.value
  if (id === null || mode.value === 'live')
    return
  loading.value = true
  error.value = null
  try {
    const history = await api.fetchLogHistory(id, { tail: Number(tail.value) })
    diskLines.value = history.lines
    diskVersion.value += 1
  }
  catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  }
  finally {
    loading.value = false
  }
}

async function clearFile(): Promise<void> {
  const id = selected.value
  if (id === null)
    return
  confirmClear.value = false
  try {
    await api.clearLogHistory(id)
    diskLines.value = []
    diskVersion.value += 1
    await loadServers()
  }
  catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  }
}

function select(id: string): void {
  selected.value = id
  if (mode.value === 'live')
    diskLines.value = []
  void router.replace({ query: { ...route.query, server: id } })
}

watch([selected, tail, mode], () => {
  if (mode.value === 'disk')
    void loadTail()
}, { immediate: false })

onMounted(async () => {
  await loadServers()
  if (mode.value === 'disk')
    await loadTail()
})
</script>

<template>
  <div class="flex h-full min-h-0">
    <aside class="hidden w-64 shrink-0 flex-col border-r border-line bg-panel/40 md:flex">
      <div class="border-b border-line px-3 py-2.5">
        <p class="text-xs font-semibold text-ink">
          Persisted logs
        </p>
        <p class="mt-0.5 text-2xs text-faint">
          {{ persistedCount }} of {{ servers.length }} servers on disk · {{ formatBytes(totalPersisted) }}
        </p>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto p-1.5">
        <div v-if="listLoading" class="space-y-1.5 p-1.5">
          <Skeleton v-for="index in 5" :key="index" class="h-10 w-full" rounded="rounded-control" />
        </div>

        <template v-else>
          <button
            v-for="server in servers"
            :key="server.serverId"
            type="button"
            :class="cn(
              'flex w-full items-center gap-2.5 rounded-control px-2 py-2 text-left transition-colors duration-150',
              server.serverId === selected ? 'bg-accent-soft' : 'hover:bg-hover',
            )"
            @click="select(server.serverId)"
          >
            <span :class="cn('size-1.5 shrink-0 rounded-full', TONE_DOT[STATUS_META[server.status].tone])" />
            <span class="min-w-0 flex-1">
              <span :class="cn('block truncate text-xs', server.serverId === selected ? 'font-medium text-accent' : 'text-ink')">
                {{ server.label }}
              </span>
              <span class="block truncate font-mono text-2xs text-faint">
                {{ server.files.length > 0 ? `${server.files.length} file${server.files.length === 1 ? '' : 's'} · ${formatBytes(server.sizeBytes)}` : 'nothing persisted' }}
              </span>
            </span>
          </button>
        </template>

        <EmptyState
          v-if="!listLoading && servers.length === 0"
          compact
          title="No servers"
          description="Add one and its output will be persisted here."
        />
      </div>

      <div class="border-t border-line p-2.5">
        <p class="text-2xs leading-4 text-faint">
          Rotation and retention are set under Settings → Log storage.
        </p>
      </div>
    </aside>

    <div class="flex min-w-0 flex-1 flex-col">
      <header class="flex flex-wrap items-center gap-2 border-b border-line bg-panel/40 px-3 py-2.5">
        <div class="min-w-0">
          <h1 class="truncate text-sm font-semibold text-ink">
            {{ current?.label ?? 'Logs' }}
            <span v-if="current" class="ml-1.5 font-mono text-2xs font-normal text-faint">{{ current.serverId }}</span>
          </h1>
        </div>

        <SegmentedControl
          v-model="mode"
          class="ml-auto"
          :options="[
            { value: 'disk', label: 'Persisted' },
            { value: 'live', label: 'Live stream' },
          ]"
        />

        <SelectField
          v-if="mode === 'disk'"
          v-model="tail"
          :options="tailOptions"
          class="w-32"
          aria-label="Tail size"
        />

        <AppButton v-if="mode === 'disk'" size="sm" :loading="loading" @click="loadTail">
          <RefreshCw class="size-3.5" />Reload
        </AppButton>

        <AppButton
          v-if="mode === 'disk'"
          size="sm"
          variant="ghost"
          :disabled="!current || current.files.length === 0"
          @click="confirmClear = true"
        >
          <Trash2 class="size-3.5" />Clear file
        </AppButton>
      </header>

      <div v-if="current" class="flex flex-wrap items-center gap-1.5 border-b border-line-soft bg-panel-2/40 px-3 py-2">
        <FileText class="size-3.5 shrink-0 text-faint" />
        <template v-if="current.files.length > 0">
          <a
            v-for="file in current.files"
            :key="file.name"
            :href="api.logDownloadUrl(current.serverId, file.name)"
            :download="file.name"
            class="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 font-mono text-2xs text-muted transition-colors duration-150 hover:border-accent/40 hover:text-accent"
          >
            {{ file.name }}
            <span class="text-faint">{{ formatBytes(file.sizeBytes) }}</span>
            <ArrowDownToLine class="size-3" />
          </a>
        </template>
        <span v-else class="text-2xs text-faint">
          Nothing on disk for this server — persistence is off, or it has not written anything yet.
        </span>
        <span v-if="mode === 'disk' && diskLines.length > 0" class="ml-auto font-mono text-2xs text-faint">
          loaded {{ diskLines.length }} lines
        </span>
      </div>

      <p v-if="error" class="flex items-center gap-1.5 border-b border-danger/25 bg-danger-soft px-3 py-2 text-2xs text-danger">
        <CircleAlert class="size-3.5" />
        {{ error }}
      </p>

      <div class="min-h-0 flex-1 p-3">
        <EmptyState
          v-if="!current"
          title="Pick a server"
          description="Persisted output and live streams are per server. Choose one from the list."
        >
          <template #icon>
            <ScrollText class="size-4" />
          </template>
        </EmptyState>

        <Skeleton v-else-if="loading && lines.length === 0" class="h-full w-full" rounded="rounded-panel" />

        <LogViewer
          v-else
          :lines="lines"
          :version="version"
          :live="mode === 'live'"
          class="h-full"
          :empty-hint="mode === 'live' ? 'Connected — waiting for output.' : 'The persisted file is empty.'"
          min-height="100%"
        />
      </div>
    </div>

    <Modal
      v-model:open="confirmClear"
      title="Clear the persisted log file?"
      :description="`${current?.serverId ?? ''} — the file on disk is truncated. The process keeps running and new lines are written from here on.`"
      width="w-[min(92vw,26rem)]"
    >
      <p class="text-xs text-muted">
        Download it first if the output is still needed — this cannot be undone from the panel.
      </p>
      <template #footer>
        <AppButton variant="ghost" @click="confirmClear = false">
          Keep it
        </AppButton>
        <AppButton variant="danger" @click="clearFile">
          <Trash2 class="size-3.5" />Clear
        </AppButton>
      </template>
    </Modal>
  </div>
</template>
