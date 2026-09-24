<script setup lang="ts">
import type { ServerView } from '@shared/contracts'
import { Code2, ExternalLink, MoreHorizontal, Pencil, Play, RotateCw, Square, Trash2 } from 'lucide-vue-next'
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuRoot, DropdownMenuSeparator, DropdownMenuTrigger } from 'reka-ui'
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import LogViewer from '@/components/log/LogViewer.vue'
import ActivityFeed from '@/components/server/ActivityFeed.vue'
import ServerConfigEditor from '@/components/server/ServerConfigEditor.vue'
import ConfirmButton from '@/components/settings/ConfirmButton.vue'
import MetricSpark from '@/components/telemetry/MetricSpark.vue'
import AppButton from '@/components/ui/AppButton.vue'
import CopyButton from '@/components/ui/CopyButton.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import Modal from '@/components/ui/Modal.vue'
import PageHeader from '@/components/ui/PageHeader.vue'
import Panel from '@/components/ui/Panel.vue'
import SegmentedControl from '@/components/ui/SegmentedControl.vue'
import StatusPill from '@/components/ui/StatusPill.vue'
import Tip from '@/components/ui/Tip.vue'
import { useControlPlane, useServerLogs } from '@/composables/useControlPlane'
import * as api from '@/lib/api'
import {
  formatAgo,
  formatBytesShort,
  formatCpuPercent,
  formatDuration,
  formatRatio,
  relativeFrom,
} from '@/lib/format'

const route = useRoute()
const { serverById, now, seriesOf, start, stop, restart, setEnabled, setAutostart, setBind, clearLogs, freePort, remove } = useControlPlane()

const serverId = computed(() => String(route.params.id ?? ''))
const server = computed<ServerView | undefined>(() => serverById(serverId.value))
const config = computed(() => server.value?.config)
const label = computed(() => {
  const value = config.value
  return value?.label && value.label.length > 0 ? value.label : serverId.value
})

const section = ref('output')
const editing = ref(false)
const showRaw = ref(false)
const confirmRemove = ref(false)
const busy = ref(false)

const logs = useServerLogs(() => (server.value ? serverId.value : null))

// `version` changes on every flushed batch (and on clear), which is what tells the
// viewer its in-place line array gained content.
const liveVersion = logs.version
const liveLines = computed(() => {
  void liveVersion.value
  return logs.lines()
})

const series = computed(() => seriesOf(serverId.value))

const cpuValues = computed(() => series.value.cpu)
const rssValues = computed(() => series.value.rss)
const probeValues = computed(() => series.value.probe)

const uptime = computed(() => {
  const value = server.value
  if (!value || value.startedAt === null || value.status !== 'running')
    return '—'
  return formatDuration(now.value - value.startedAt)
})

const isRunning = computed(() => server.value?.status === 'running')

const stats = computed(() => {
  const value = server.value
  if (!value)
    return []
  const rows = [
    { key: 'pid', label: 'PID', value: value.pid === null ? '—' : String(value.pid) },
    { key: 'uptime', label: 'Uptime', value: uptime.value },
    { key: 'status', label: 'Status', value: value.status },
    { key: 'health', label: 'Health', value: value.health },
    { key: 'port', label: 'Port state', value: value.portState },
    { key: 'probe', label: 'Last probe', value: value.responseMs === null ? '—' : `${value.responseMs} ms` },
    { key: 'rss', label: 'RSS', value: formatBytesShort(value.resources?.rssBytes ?? null) },
    { key: 'procs', label: 'Processes', value: value.resources ? String(value.resources.processes) : '—' },
    { key: 'restarts', label: 'Restarts', value: `${value.restarts}/${value.maxRetries}` },
    { key: 'up24', label: '24h uptime', value: formatRatio(value.history.uptimeRatio) },
    { key: 'crashes', label: '24h crashes', value: String(value.history.crashes) },
    { key: 'lastcrash', label: 'Last crash', value: formatAgo(value.history.lastCrashAt, now.value) },
  ]
  if (value.nextRetryAt !== null)
    rows.push({ key: 'retry', label: 'Next attempt', value: relativeFrom(value.nextRetryAt, now.value) })
  if (value.unhealthySince !== null)
    rows.push({ key: 'unhealthy', label: 'Unhealthy for', value: formatDuration(now.value - value.unhealthySince) })
  return rows
})

const rawConfig = computed(() => JSON.stringify(config.value ?? {}, null, 2))
const commandLine = computed(() => (config.value ? `${config.value.command} ${config.value.args.join(' ')}`.trim() : ''))

const bindOptions = computed(() => {
  const current = config.value?.bind ?? 'local'
  const options = [
    { value: 'local', label: '127.0.0.1 — this machine only' },
    { value: 'lan', label: '0.0.0.0 — every interface' },
  ]
  if (current !== 'local' && current !== 'lan')
    options.push({ value: current, label: `${current} — custom` })
  return options
})

async function act(action: 'start' | 'stop' | 'restart'): Promise<void> {
  busy.value = true
  try {
    await { start, stop, restart }[action](serverId.value)
  }
  finally {
    busy.value = false
  }
}

async function removeServer(): Promise<void> {
  confirmRemove.value = false
  await remove(serverId.value)
}

const downloadUrl = computed(() => api.logDownloadUrl(serverId.value, `${serverId.value}.log`))

const SECTIONS = [
  { value: 'output', label: 'Live output' },
  { value: 'config', label: 'Configuration' },
  { value: 'history', label: 'History' },
]
</script>

<template>
  <div v-if="!server" class="mx-auto max-w-3xl p-4 sm:p-5">
    <EmptyState
      title="That server is gone"
      :description="`${serverId} is not in servers.config.json any more. It may have been removed from another tab.`"
    >
      <template #action>
        <RouterLink to="/servers">
          <AppButton variant="primary">
            Back to servers
          </AppButton>
        </RouterLink>
      </template>
    </EmptyState>
  </div>

  <div v-else class="mx-auto max-w-7xl space-y-5 p-4 sm:p-5">
    <PageHeader :title="label" back-to="/servers" back-label="All servers">
      <template #badges>
        <StatusPill :status="server.status" :health="server.health" />
        <span class="font-mono text-xs text-faint">{{ server.id }}</span>
        <a
          v-if="server.url"
          :href="server.url"
          target="_blank"
          rel="noreferrer"
          class="inline-flex items-center gap-1 font-mono text-xs text-accent hover:underline"
        >
          {{ server.url }}
          <ExternalLink class="size-3" />
        </a>
      </template>
      <template #actions>
        <AppButton
          variant="primary"
          :disabled="busy || !config?.enabled || ['running', 'starting'].includes(server.status)"
          @click="act('start')"
        >
          <Play class="size-3.5" />Start
        </AppButton>
        <AppButton :disabled="busy || server.status === 'stopped'" @click="act('stop')">
          <Square class="size-3.5" />Stop
        </AppButton>
        <AppButton :disabled="busy || !config?.enabled" @click="act('restart')">
          <RotateCw class="size-3.5" />Restart
        </AppButton>
        <Tip label="Edit every field of this entry">
          <AppButton :variant="editing ? 'secondary' : 'ghost'" @click="editing = !editing; section = 'config'">
            <Pencil class="size-3.5" />{{ editing ? 'Close editor' : 'Edit' }}
          </AppButton>
        </Tip>
        <DropdownMenuRoot>
          <DropdownMenuTrigger as-child>
            <AppButton variant="ghost" size="icon-sm" :aria-label="`More actions for ${label}`">
              <MoreHorizontal class="size-4" />
            </AppButton>
          </DropdownMenuTrigger>
          <DropdownMenuPortal>
            <DropdownMenuContent
              :side-offset="4"
              align="end"
              class="z-50 min-w-56 rounded-panel border border-line bg-raise p-1 shadow-float data-[state=open]:animate-[hh-fade-in_120ms_ease-out]"
            >
              <DropdownMenuItem
                class="flex cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 text-xs text-muted outline-none data-[highlighted]:bg-hover data-[highlighted]:text-ink"
                @select="setEnabled(server.id, !server.config.enabled)"
              >
                {{ config?.enabled ? 'Disable server' : 'Enable server' }}
              </DropdownMenuItem>
              <DropdownMenuItem
                class="flex cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 text-xs text-muted outline-none data-[highlighted]:bg-hover data-[highlighted]:text-ink"
                @select="setAutostart(server.id, !server.config.autostart)"
              >
                {{ config?.autostart ? 'Remove from autostart' : 'Autostart with the panel' }}
              </DropdownMenuItem>
              <DropdownMenuSeparator class="my-1 h-px bg-line" />
              <div class="px-2 py-1.5">
                <p class="mb-1 text-2xs text-faint">
                  Bind
                </p>
                <div class="flex flex-col gap-0.5">
                  <button
                    v-for="option in bindOptions"
                    :key="option.value"
                    type="button"
                    class="rounded-control px-2 py-1 text-left font-mono text-2xs transition-colors duration-150 hover:bg-hover"
                    :class="option.value === config?.bind ? 'text-accent' : 'text-muted'"
                    @click="setBind(server.id, option.value)"
                  >
                    {{ option.label }}
                  </button>
                </div>
              </div>
              <DropdownMenuSeparator class="my-1 h-px bg-line" />
              <DropdownMenuItem
                class="flex cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 text-xs text-danger outline-none data-[highlighted]:bg-danger-soft"
                @select="confirmRemove = true"
              >
                <Trash2 class="size-3.5" />
                Remove server
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenuPortal>
        </DropdownMenuRoot>
      </template>
    </PageHeader>

    <div class="space-y-2">
      <div
        v-if="server.lastError"
        class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-control border border-danger/25 bg-danger-soft px-3 py-2"
      >
        <p class="min-w-0 flex-1 text-2xs leading-4 text-danger">
          {{ server.lastError }}
        </p>
        <ConfirmButton
          v-if="server.status === 'conflict' && server.config.port !== null"
          :label="`Kill what holds port ${server.config.port}`"
          confirm-label="Yes, kill it"
          size="xs"
          :loading="busy"
          @confirm="freePort(server.id)"
        />
      </div>
      <p
        v-if="server.health === 'unhealthy'"
        class="rounded-control border border-warn/25 bg-warn-soft px-3 py-2 text-2xs leading-4 text-warn"
      >
        The health probe has not passed
        <template v-if="server.unhealthySince !== null">
          for {{ formatDuration(now - server.unhealthySince) }}
        </template>.
      </p>
    </div>

    <Panel class="p-0">
      <dl class="grid grid-cols-2 gap-x-4 gap-y-3 p-4 sm:grid-cols-4 lg:grid-cols-6">
        <div v-for="row in stats" :key="row.key" class="min-w-0">
          <dt class="truncate text-2xs text-faint">
            {{ row.label }}
          </dt>
          <dd class="truncate font-mono text-xs tabular-nums text-ink capitalize">
            {{ row.value }}
          </dd>
        </div>
      </dl>
    </Panel>

    <Panel>
      <template #header>
        <h2 class="text-sm font-semibold text-ink">
          Telemetry
        </h2>
        <p class="text-2xs text-muted">
          Sampled every 5 s while this page is open.
        </p>
      </template>
      <div class="grid gap-4 sm:grid-cols-3">
        <MetricSpark label="CPU" :values="cpuValues" :format="formatCpuPercent" :max="100" color-class="text-cpu" :height="40" />
        <MetricSpark label="Memory (RSS)" :values="rssValues" :format="formatBytesShort" color-class="text-mem" :height="40" />
        <MetricSpark label="Health probe" :values="probeValues" :format="v => (v === null ? '—' : `${v} ms`)" color-class="text-probe" :height="40" />
      </div>
    </Panel>

    <div class="flex items-center justify-between gap-3">
      <SegmentedControl v-model="section" :options="SECTIONS" size="md" />
      <p class="hidden font-mono text-2xs text-faint sm:block" :title="commandLine">
        {{ commandLine }}
      </p>
    </div>

    <LogViewer
      v-if="section === 'output'"
      :lines="liveLines"
      :version="liveVersion"
      live
      clearable
      :download-url="server.config.logBufferLines > 0 ? downloadUrl : undefined"
      :download-name="`${server.id}.log`"
      :empty-hint="isRunning ? 'Waiting for the first line…' : 'This server has not written anything yet.'"
      min-height="22rem"
      @clear="clearLogs(server.id)"
    />

    <div v-else-if="section === 'config'" class="space-y-4">
      <ServerConfigEditor
        v-if="editing"
        :server-id="server.id"
        :config="server.config"
        @saved="editing = false"
        @cancel="editing = false"
      />

      <Panel v-else>
        <template #header>
          <h2 class="text-sm font-semibold text-ink">
            Effective configuration
          </h2>
          <p class="text-2xs text-muted">
            Defaults from Settings are already merged into these values.
          </p>
        </template>
        <template #actions>
          <AppButton size="xs" variant="ghost" @click="showRaw = !showRaw">
            <Code2 class="size-3" />{{ showRaw ? 'Fields' : 'Raw JSON' }}
          </AppButton>
          <CopyButton :value="rawConfig" label="Copy the JSON config" />
          <AppButton size="xs" variant="primary" @click="editing = true">
            <Pencil class="size-3" />Edit
          </AppButton>
        </template>

        <pre
          v-if="showRaw"
          class="max-h-96 overflow-auto rounded-control border border-line bg-page/60 p-3 font-mono text-2xs leading-5 text-muted"
        >{{ rawConfig }}</pre>

        <dl v-else class="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
          <div
            v-for="row in [
              { label: 'command', value: config?.command },
              { label: 'args', value: config?.args.join(' ') || '—' },
              { label: 'cwd', value: config?.cwd },
              { label: 'env', value: Object.keys(config?.env ?? {}).join(', ') || '—' },
              { label: 'data envs', value: Object.entries(config?.dataEnvs ?? {}).map(([k, v]) => `${k}=${v}`).join(', ') || '—' },
              { label: 'env file', value: config?.envFile || '—' },
              { label: 'port · bind', value: `${config?.port ?? 'none'} · ${config?.bind}` },
              { label: 'on port conflict', value: config?.onPortConflict },
              { label: 'log buffer', value: `${config?.logBufferLines} lines` },
              { label: 'rtss limit', value: config?.resources.maxRssBytes ? formatBytesShort(config.resources.maxRssBytes) : 'none' },
              { label: 'health', value: config?.health.enabled ? `${config.health.mode} every ${config.health.intervalMs} ms` : 'off' },
              { label: 'restart', value: config?.restart.enabled ? `${config.restart.maxRetries} retries, ×${config.restart.factor}` : 'off' },
              { label: 'stop', value: config ? `${config.stop.signal} after ${config.stop.graceMs} ms` : '—' },
              { label: 'bootstrap', value: config?.bootstrap ? `${config.bootstrap.command} ${config.bootstrap.args.join(' ')}` : 'none' },
              { label: 'backup paths', value: config?.backupPaths.join(', ') || '—' },
              { label: 'depends on', value: config?.dependsOn.join(', ') || '—' },
            ]" :key="row.label" class="min-w-0 border-b border-line-soft pb-1.5 last:border-0"
          >
            <dt class="text-2xs text-faint">
              {{ row.label }}
            </dt>
            <dd class="truncate font-mono text-xs text-ink" :title="String(row.value)">
              {{ row.value }}
            </dd>
          </div>
        </dl>
      </Panel>
    </div>

    <div v-else class="grid gap-4 lg:grid-cols-3">
      <Panel class="lg:col-span-2">
        <template #header>
          <h2 class="text-sm font-semibold text-ink">
            Event history
          </h2>
          <p class="text-2xs text-muted">
            Kept by the panel for 24 hours.
          </p>
        </template>
        <ActivityFeed :servers="[server]" :now="now" :limit="30" />
      </Panel>

      <Panel>
        <template #header>
          <h2 class="text-sm font-semibold text-ink">
            Dependencies
          </h2>
        </template>
        <div v-if="config && config.dependsOn.length > 0" class="flex flex-wrap gap-1.5">
          <RouterLink
            v-for="id in config.dependsOn"
            :key="id"
            :to="`/servers/${id}`"
            class="rounded-full border border-line px-2 py-0.5 font-mono text-2xs text-muted transition-colors duration-150 hover:border-accent/40 hover:text-accent"
          >
            {{ id }}
          </RouterLink>
        </div>
        <p v-else class="text-xs text-muted">
          Starts on its own. Add ids under <code>dependsOn</code> to order it after other servers.
        </p>
      </Panel>
    </div>

    <Modal
      v-model:open="confirmRemove"
      title="Remove this server?"
      :description="`${label} is removed from servers.config.json. Its process is stopped and its persisted logs stay on disk.`"
      width="w-[min(92vw,26rem)]"
    >
      <p class="text-xs text-muted">
        This cannot be undone from the panel — the entry has to be added back by hand or from a backup.
      </p>
      <template #footer>
        <AppButton variant="ghost" @click="confirmRemove = false">
          Keep it
        </AppButton>
        <AppButton variant="danger" @click="removeServer">
          <Trash2 class="size-3.5" />Remove
        </AppButton>
      </template>
    </Modal>
  </div>
</template>
