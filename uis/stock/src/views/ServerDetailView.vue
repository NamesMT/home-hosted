<script setup lang="ts">
import type { ServerView } from '@shared/contracts'
import { Code2, ExternalLink, MoreHorizontal, Pencil, Play, RotateCw, Square, Trash2 } from '@lucide/vue'
import { browserServerUrl, pageHostname } from '@shared/server-url'
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuRoot, DropdownMenuSeparator, DropdownMenuTrigger } from 'reka-ui'
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import LogViewer from '@/components/log/LogViewer.vue'
import ActivityFeed from '@/components/server/ActivityFeed.vue'
import KillPortButton from '@/components/server/KillPortButton.vue'
import ServerConfigEditor from '@/components/server/ServerConfigEditor.vue'
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
import TransText from '@/components/ui/TransText.vue'
import { useControlPlane, useServerLogs } from '@/composables/useControlPlane'
import { useWorkspaces } from '@/composables/useWorkspaces'
import { t, tc } from '@/i18n'
import * as api from '@/lib/api'
import {
  formatAgo,
  formatBytesShort,
  formatCpuPercent,
  formatDuration,
  formatRatio,
  relativeFrom,
} from '@/lib/format'
import { HEALTH_META, STATUS_META } from '@/lib/status'
import { workspacePath } from '@/router'

const route = useRoute()
const control = useControlPlane()
const workspace = useWorkspaces()

const serverId = computed(() => String(route.params.id ?? ''))

/** Ids repeat across workspaces, so a deep link into another scope follows it. */
watch([serverId, () => control.appState.value], () => {
  const id = serverId.value
  if (id.length === 0 || workspace.serverById(id) !== undefined)
    return
  const owners = control.workspaces.value.filter(entry => entry.servers.some(server => server.id === id))
  if (owners.length === 1)
    workspace.select(owners[0]!.id)
}, { immediate: true })

const server = computed<ServerView | undefined>(() => workspace.serverById(serverId.value))
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

const logs = useServerLogs(workspace.activeId, () => (server.value ? serverId.value : null))

// `version` changes on every flushed batch (and on clear), which is what tells the
// viewer its in-place line array gained content.
const liveVersion = logs.version
const liveLines = computed(() => {
  void liveVersion.value
  return logs.lines()
})

const series = computed(() => workspace.seriesOf(serverId.value))
const now = control.now

/**
 * The link follows the hostname this page was reached at when the entry binds every interface: its
 * LAN address is unroutable for a viewer arriving over a public name or a tunnel. See `@shared/server-url`.
 */
const serverUrl = computed(() => (server.value ? browserServerUrl(server.value, pageHostname()) : null))

const cpuValues = computed(() => series.value.cpu)
const rssValues = computed(() => series.value.rss)
const probeValues = computed(() => series.value.probe)

/** As in `ServerCard`: CPU sums the tree across cores, so the ceiling is the whole machine. */
const cpuCeiling = computed(() => Math.max(100, (control.host.value?.cpus ?? 1) * 100))

const uptime = computed(() => {
  const value = server.value
  if (!value || value.startedAt === null || value.status !== 'running')
    return '—'
  return formatDuration(now.value - value.startedAt)
})

const isRunning = computed(() => server.value?.status === 'running')

/** The enum renders as a word; `unknown` is the Lead's shared one, the rest are this view's. */
const PORT_STATE_LABEL_KEY: Record<string, string> = {
  'unknown': 'common.unknown',
  'free': 'views.serverDetail.portFree',
  'in-use': 'views.serverDetail.portInUse',
}

const stats = computed(() => {
  const value = server.value
  if (!value)
    return []
  const rows = [
    { key: 'pid', label: t('views.serverDetail.pid'), value: value.pid === null ? '—' : String(value.pid) },
    { key: 'uptime', label: t('common.uptime'), value: uptime.value },
    { key: 'status', label: t('common.status'), value: t(STATUS_META[value.status].labelKey) },
    { key: 'health', label: t('views.serverDetail.health'), value: t(HEALTH_META[value.health].labelKey) },
    { key: 'port', label: t('views.serverDetail.portState'), value: t(PORT_STATE_LABEL_KEY[value.portState] ?? 'common.unknown') },
    { key: 'probe', label: t('views.serverDetail.lastProbe'), value: value.responseMs === null ? '—' : `${value.responseMs} ms` },
    { key: 'rss', label: 'RSS', value: formatBytesShort(value.resources?.rssBytes ?? null) },
    { key: 'procs', label: t('views.serverDetail.processes'), value: value.resources ? String(value.resources.processes) : '—' },
    { key: 'restarts', label: t('views.serverDetail.restarts'), value: `${value.restarts}/${value.maxRetries}` },
    { key: 'up24', label: t('views.serverDetail.uptime24'), value: formatRatio(value.history.uptimeRatio) },
    { key: 'crashes', label: t('views.serverDetail.crashes24'), value: String(value.history.crashes) },
    { key: 'lastcrash', label: t('views.serverDetail.lastCrash'), value: formatAgo(value.history.lastCrashAt, now.value) },
  ]
  if (value.nextRetryAt !== null)
    rows.push({ key: 'retry', label: t('views.serverDetail.nextAttempt'), value: relativeFrom(value.nextRetryAt, now.value) })
  if (value.unhealthySince !== null)
    rows.push({ key: 'unhealthy', label: t('views.serverDetail.unhealthyFor'), value: formatDuration(now.value - value.unhealthySince) })
  return rows
})

const rawConfig = computed(() => JSON.stringify(config.value ?? {}, null, 2))
const commandLine = computed(() => (config.value ? `${config.value.command} ${config.value.args.join(' ')}`.trim() : ''))

const bindOptions = computed(() => {
  const current = config.value?.bind ?? 'local'
  const options = [
    { value: 'local', label: t('views.serverDetail.bindLocal') },
    { value: 'lan', label: t('views.serverDetail.bindLan') },
  ]
  if (current !== 'local' && current !== 'lan')
    options.push({ value: current, label: t('views.serverDetail.bindCustom', { bind: current }) })
  return options
})

async function act(action: 'start' | 'stop' | 'restart'): Promise<void> {
  busy.value = true
  try {
    await control[action](workspace.activeId.value, serverId.value)
  }
  finally {
    busy.value = false
  }
}

async function removeServer(): Promise<void> {
  confirmRemove.value = false
  await workspace.removeServer(serverId.value)
}

/**
 * Frees the port this entry is blocked on. There is no confirmation step on
 * purpose: the button names the exact port, and only exists in a conflict state.
 */
async function killPortHolder(): Promise<void> {
  const value = server.value
  if (!value)
    return
  busy.value = true
  try {
    await workspace.freePort(value.id)
  }
  finally {
    busy.value = false
  }
}

const downloadUrl = computed(() => api.logDownloadUrl(workspace.activeId.value, serverId.value, `${serverId.value}.log`))

const SECTIONS = [
  { value: 'output', labelKey: 'views.serverDetail.sectionOutput' },
  { value: 'config', labelKey: 'views.serverDetail.sectionConfig' },
  { value: 'history', labelKey: 'views.serverDetail.sectionHistory' },
].map(entry => ({ value: entry.value, label: t(entry.labelKey) }))
</script>

<template>
  <div v-if="!server" class="mx-auto max-w-3xl p-4 sm:p-5">
    <EmptyState
      :title="t('views.serverDetail.goneTitle')"
      :description="t('views.serverDetail.goneDescription', { id: serverId })"
    >
      <template #action>
        <RouterLink :to="workspacePath(workspace.activeId.value, 'servers')">
          <AppButton variant="primary">
            {{ t('views.serverDetail.backToServers') }}
          </AppButton>
        </RouterLink>
      </template>
    </EmptyState>
  </div>

  <div v-else class="mx-auto max-w-7xl space-y-5 p-4 sm:p-5">
    <PageHeader :title="label" :back-to="workspacePath(workspace.activeId.value, 'servers')" :back-label="t('views.serverDetail.allServers')">
      <template #badges>
        <StatusPill :status="server.status" :health="server.health" />
        <Tip
          v-if="server.adopted"
          :label="t('views.serverDetail.detachedHint')"
        >
          <span class="rounded-full border border-line px-2 py-0.5 text-2xs text-muted">{{ t('views.serverDetail.detached') }}</span>
        </Tip>
        <Tip
          v-if="server.config.persistent"
          :label="t('views.serverDetail.persistentHint')"
        >
          <span class="rounded-full border border-line px-2 py-0.5 text-2xs text-muted">{{ t('views.serverDetail.persistent') }}</span>
        </Tip>
        <span class="font-mono text-xs text-faint">{{ server.id }}</span>
        <a
          v-if="serverUrl"
          :href="serverUrl"
          target="_blank"
          rel="noreferrer"
          class="inline-flex items-center gap-1 font-mono text-xs text-accent hover:underline"
        >
          {{ serverUrl }}
          <ExternalLink class="size-3" />
        </a>
      </template>
      <template #actions>
        <AppButton
          variant="primary"
          :disabled="busy || !config?.enabled || ['running', 'starting'].includes(server.status)"
          @click="act('start')"
        >
          <Play class="size-3.5" />{{ t('views.serverDetail.start') }}
        </AppButton>
        <AppButton :disabled="busy || server.status === 'stopped'" @click="act('stop')">
          <Square class="size-3.5" />{{ t('views.serverDetail.stop') }}
        </AppButton>
        <AppButton :disabled="busy || !config?.enabled" @click="act('restart')">
          <RotateCw class="size-3.5" />{{ t('views.serverDetail.restart') }}
        </AppButton>
        <Tip :label="t('views.serverDetail.editHint')">
          <AppButton :variant="editing ? 'secondary' : 'ghost'" @click="editing = !editing; section = 'config'">
            <Pencil class="size-3.5" />{{ editing ? t('views.serverDetail.closeEditor') : t('common.edit') }}
          </AppButton>
        </Tip>
        <DropdownMenuRoot>
          <DropdownMenuTrigger as-child>
            <AppButton variant="ghost" size="icon-sm" :aria-label="t('views.serverDetail.moreActions', { label })">
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
                @select="workspace.setEnabled(server.id, !server.config.enabled)"
              >
                {{ config?.enabled ? t('views.serverDetail.disableServer') : t('views.serverDetail.enableServer') }}
              </DropdownMenuItem>
              <DropdownMenuItem
                class="flex cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 text-xs text-muted outline-none data-[highlighted]:bg-hover data-[highlighted]:text-ink"
                @select="workspace.setAutostart(server.id, !server.config.autostart)"
              >
                {{ config?.autostart ? t('views.serverDetail.removeAutostart') : t('views.serverDetail.autostart') }}
              </DropdownMenuItem>
              <DropdownMenuSeparator class="my-1 h-px bg-line" />
              <div class="px-2 py-1.5">
                <p class="mb-1 text-2xs text-faint">
                  {{ t('views.serverDetail.bind') }}
                </p>
                <div class="flex flex-col gap-0.5">
                  <button
                    v-for="option in bindOptions"
                    :key="option.value"
                    type="button"
                    class="rounded-control px-2 py-1 text-left font-mono text-2xs transition-colors duration-150 hover:bg-hover"
                    :class="option.value === config?.bind ? 'text-accent' : 'text-muted'"
                    @click="workspace.setBind(server.id, option.value)"
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
                {{ t('views.serverDetail.removeServer') }}
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
        <KillPortButton
          v-if="server.status === 'conflict' && server.config.port !== null"
          :port="server.config.port"
          :busy="busy"
          @confirm="killPortHolder"
        />
      </div>
      <p
        v-if="server.health === 'unhealthy'"
        class="rounded-control border border-warn/25 bg-warn-soft px-3 py-2 text-2xs leading-4 text-warn"
      >
        <template v-if="server.unhealthySince !== null">
          {{ t('views.serverDetail.probeFailedFor', { duration: formatDuration(now - server.unhealthySince) }) }}
        </template>
        <template v-else>
          {{ t('views.serverDetail.probeFailed') }}
        </template>
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
          {{ t('views.serverDetail.telemetry') }}
        </h2>
        <p class="text-2xs text-muted">
          {{ t('views.serverDetail.telemetryNote') }}
        </p>
      </template>
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <MetricSpark :label="t('common.cpu')" :values="cpuValues" :format="formatCpuPercent" :max="cpuCeiling" color-class="text-cpu" :height="40" />
        <MetricSpark :label="t('views.serverDetail.memoryRss')" :values="rssValues" :format="formatBytesShort" color-class="text-mem" :height="40" />
        <MetricSpark :label="t('views.serverDetail.healthProbe')" :values="probeValues" :format="v => (v === null ? '—' : `${v} ms`)" color-class="text-probe" :height="40" />
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
      :empty-hint="isRunning ? t('views.serverDetail.waitingFirstLine') : t('views.serverDetail.neverWritten')"
      min-height="22rem"
      @clear="workspace.clearLogs(server.id)"
    />

    <div v-else-if="section === 'config'" class="space-y-4">
      <ServerConfigEditor
        v-if="editing"
        :server-id="server.id"
        :workspace-id="workspace.activeId.value"
        :config="server.config"
        @saved="editing = false"
        @cancel="editing = false"
      />

      <Panel v-else>
        <template #header>
          <h2 class="text-sm font-semibold text-ink">
            {{ t('views.serverDetail.effectiveConfig') }}
          </h2>
          <p class="text-2xs text-muted">
            {{ t('views.serverDetail.effectiveConfigNote') }}
          </p>
        </template>
        <template #actions>
          <AppButton size="xs" variant="ghost" @click="showRaw = !showRaw">
            <Code2 class="size-3" />{{ showRaw ? t('views.serverDetail.fields') : t('views.serverDetail.rawJson') }}
          </AppButton>
          <CopyButton :value="rawConfig" :label="t('views.serverDetail.copyJson')" />
          <AppButton size="xs" variant="primary" @click="editing = true">
            <Pencil class="size-3" />{{ t('common.edit') }}
          </AppButton>
        </template>

        <pre
          v-if="showRaw"
          class="max-h-96 overflow-auto rounded-control border border-line bg-page/60 p-3 font-mono text-2xs leading-5 text-muted"
        >{{ rawConfig }}</pre>

        <dl v-else class="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
          <div
            v-for="row in [
              { label: t('views.serverDetail.fieldCommand'), value: config?.command },
              { label: t('views.serverDetail.fieldArgs'), value: config?.args.join(' ') || '—' },
              { label: t('views.serverDetail.fieldCwd'), value: config?.cwd },
              { label: t('views.serverDetail.fieldEnv'), value: Object.keys(config?.env ?? {}).join(', ') || '—' },
              { label: t('views.serverDetail.fieldDataEnvs'), value: Object.entries(config?.dataEnvs ?? {}).map(([k, v]) => `${k}=${v}`).join(', ') || '—' },
              { label: t('views.serverDetail.fieldEnvFile'), value: config?.envFile || '—' },
              { label: t('views.serverDetail.fieldPortBind'), value: `${config?.port ?? t('common.none')} · ${config?.bind}` },
              { label: t('views.serverDetail.fieldOnPortConflict'), value: config?.onPortConflict },
              { label: t('views.serverDetail.fieldLogBuffer'), value: tc('logs.lines', config?.logBufferLines ?? 0) },
              { label: t('views.serverDetail.fieldRssLimit'), value: config?.resources.maxRssBytes ? formatBytesShort(config.resources.maxRssBytes) : t('common.none') },
              { label: t('views.serverDetail.fieldHealth'), value: config?.health.enabled ? `${config.health.mode} every ${config.health.intervalMs} ms` : t('common.disabled') },
              { label: t('views.serverDetail.fieldRestart'), value: config?.restart.enabled ? `${config.restart.maxRetries} retries, ×${config.restart.factor}` : t('common.disabled') },
              { label: t('views.serverDetail.fieldStop'), value: config ? `${config.stop.signal} after ${config.stop.graceMs} ms` : '—' },
              { label: t('views.serverDetail.fieldBootstrap'), value: config?.bootstrap ? `${config.bootstrap.command} ${config.bootstrap.args.join(' ')}` : t('common.none') },
              { label: t('views.serverDetail.fieldBackupPaths'), value: config?.backupPaths.join(', ') || '—' },
              { label: t('views.serverDetail.fieldDependsOn'), value: config?.dependsOn.join(', ') || '—' },
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

    <div v-else class="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <Panel class="lg:col-span-2">
        <template #header>
          <h2 class="text-sm font-semibold text-ink">
            {{ t('views.serverDetail.eventHistory') }}
          </h2>
          <p class="text-2xs text-muted">
            {{ t('views.serverDetail.eventHistoryNote') }}
          </p>
        </template>
        <ActivityFeed :servers="[server]" :now="now" :limit="30" />
      </Panel>

      <Panel>
        <template #header>
          <h2 class="text-sm font-semibold text-ink">
            {{ t('views.serverDetail.dependencies') }}
          </h2>
        </template>
        <div v-if="config && config.dependsOn.length > 0" class="flex flex-wrap gap-1.5">
          <RouterLink
            v-for="id in config.dependsOn"
            :key="id"
            :to="workspacePath(workspace.activeId.value, 'servers', id)"
            class="rounded-full border border-line px-2 py-0.5 font-mono text-2xs text-muted transition-colors duration-150 hover:border-accent/40 hover:text-accent"
          >
            {{ id }}
          </RouterLink>
        </div>
        <p v-else class="text-xs text-muted">
          <TransText k="views.serverDetail.startsOnItsOwn">
            <template #code>
              <code>dependsOn</code>
            </template>
          </TransText>
        </p>
      </Panel>
    </div>

    <Modal
      v-model:open="confirmRemove"
      :title="t('views.serverDetail.removeTitle')"
      :description="t('views.serverDetail.removeDescription', { label })"
      width="w-[min(92vw,26rem)]"
    >
      <p class="text-xs text-muted">
        {{ t('views.serverDetail.removeNote') }}
      </p>
      <template #footer>
        <AppButton variant="ghost" @click="confirmRemove = false">
          {{ t('common.keepIt') }}
        </AppButton>
        <AppButton variant="danger" @click="removeServer">
          <Trash2 class="size-3.5" />{{ t('common.remove') }}
        </AppButton>
      </template>
    </Modal>
  </div>
</template>
