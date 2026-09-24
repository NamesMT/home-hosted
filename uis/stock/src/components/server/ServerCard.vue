<script setup lang="ts">
import type { ServerView } from '@shared/contracts'
import type { ServerSeries } from '@/lib/telemetry'
import {
  CircleAlert,
  CircleCheck,
  ExternalLink,
  MoreHorizontal,
  Play,
  Power,
  RotateCw,
  ScrollText,
  Square,
  Trash2,
  TriangleAlert,
} from 'lucide-vue-next'
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuRoot, DropdownMenuSeparator, DropdownMenuTrigger } from 'reka-ui'
import { computed, ref } from 'vue'
import KillPortButton from '@/components/server/KillPortButton.vue'
import MetricSpark from '@/components/telemetry/MetricSpark.vue'
import AppButton from '@/components/ui/AppButton.vue'
import Modal from '@/components/ui/Modal.vue'
import StatusPill from '@/components/ui/StatusPill.vue'
import Tip from '@/components/ui/Tip.vue'
import { useControlPlane } from '@/composables/useControlPlane'
import { cn } from '@/lib/cn'
import { formatAgo, formatBytesShort, formatCpuPercent, formatDuration, formatRatio, relativeFrom } from '@/lib/format'
import { HISTORY_TYPE_LABEL, HISTORY_TYPE_TONE, serverTone, TONE_TEXT } from '@/lib/status'

const props = withDefaults(defineProps<{
  server: ServerView
  series: ServerSeries | undefined
  now: number
  /** `compact` drops the trend charts — used where space is tight. */
  variant?: 'default' | 'compact'
}>(), {
  variant: 'default',
})

const EVENT_ICONS = {
  'start': Play,
  'exit': Square,
  'crash': CircleAlert,
  'forced-restart': RotateCw,
  'unhealthy': TriangleAlert,
  'recovered': CircleCheck,
} as const

const control = useControlPlane()
const busy = ref(false)
const confirmRemove = ref(false)

const config = computed(() => props.server.config)
const label = computed(() => (config.value.label && config.value.label.length > 0 ? config.value.label : props.server.id))
const commandLine = computed(() => `${config.value.command} ${config.value.args.join(' ')}`.trim())
const tone = computed(() => serverTone(props.server.status, props.server.health))

const isRunning = computed(() => props.server.status === 'running')
const canStart = computed(() => config.value.enabled && ['stopped', 'crashed', 'conflict'].includes(props.server.status))
const canStop = computed(() => ['running', 'starting', 'backoff'].includes(props.server.status))

const uptime = computed(() => (props.server.startedAt === null || !isRunning.value
  ? '—'
  : formatDuration(props.now - props.server.startedAt)))

const retryIn = computed(() => (props.server.nextRetryAt === null ? null : relativeFrom(props.server.nextRetryAt, props.now)))

const unhealthyFor = computed(() => (props.server.unhealthySince === null
  ? null
  : formatDuration(props.now - props.server.unhealthySince)))

const cpuValues = computed(() => props.series?.cpu ?? [])
const rssValues = computed(() => props.series?.rss ?? [])
const probeValues = computed(() => props.series?.probe ?? [])

/** The three most recent events, newest first. */
const recentEvents = computed(() => [...props.server.history.events].slice(-3).reverse())

const meta = computed(() => {
  const server = props.server
  const rows: Array<{ key: string, label: string, value: string, title?: string }> = [
    { key: 'pid', label: 'PID', value: server.pid === null ? '—' : String(server.pid) },
    { key: 'uptime', label: 'Uptime', value: uptime.value },
    { key: 'restarts', label: 'Restarts', value: `${server.restarts}/${server.maxRetries}` },
    { key: 'port', label: 'Port', value: server.portState },
    { key: 'uptime24', label: '24h up', value: formatRatio(server.history.uptimeRatio) },
    { key: 'probe', label: 'Probe', value: server.responseMs === null ? '—' : `${server.responseMs} ms` },
    { key: 'rss', label: 'RSS', value: formatBytesShort(server.resources?.rssBytes ?? null) },
    { key: 'procs', label: 'Procs', value: server.resources ? String(server.resources.processes) : '—' },
  ]
  if (server.history.crashes > 0)
    rows.splice(5, 0, { key: 'crashes', label: '24h crashes', value: String(server.history.crashes) })
  if (server.history.lastCrashAt !== null)
    rows.push({ key: 'lastcrash', label: 'Last crash', value: formatAgo(server.history.lastCrashAt, props.now) })
  return rows
})

async function act(action: 'start' | 'stop' | 'restart'): Promise<void> {
  busy.value = true
  try {
    await control[action](props.server.id)
  }
  finally {
    busy.value = false
  }
}

/** Frees the port this entry is blocked on; the button names the exact port. */
async function killPortHolder(): Promise<void> {
  busy.value = true
  try {
    await control.freePort(props.server.id)
  }
  finally {
    busy.value = false
  }
}

async function toggle(flag: 'enabled' | 'autostart'): Promise<void> {
  const next = !(flag === 'enabled' ? config.value.enabled : config.value.autostart)
  if (flag === 'enabled')
    await control.setEnabled(props.server.id, next)
  else
    await control.setAutostart(props.server.id, next)
}

async function remove(): Promise<void> {
  confirmRemove.value = false
  await control.remove(props.server.id)
}
</script>

<template>
  <article
    :class="cn(
      'group relative flex flex-col rounded-panel border bg-panel shadow-card transition-colors duration-150',
      'hover:border-line/90',
      props.server.status === 'crashed' || props.server.status === 'conflict' ? 'border-danger/30' : 'border-line',
      !config.enabled && 'opacity-70',
    )"
  >
    <span
      :class="cn('absolute inset-y-3 left-0 w-0.5 rounded-full', {
        'bg-ok': tone === 'ok',
        'bg-warn': tone === 'warn',
        'bg-danger': tone === 'danger',
        'bg-faint/50': tone === 'neutral',
        'bg-accent': tone === 'accent' || tone === 'info',
      })"
    />

    <header class="flex items-start justify-between gap-3 px-4 pb-2.5 pt-3.5">
      <div class="min-w-0">
        <div class="flex items-center gap-2">
          <RouterLink
            :to="`/servers/${server.id}`"
            class="truncate text-sm font-semibold tracking-tight text-ink hover:text-accent"
          >
            {{ label }}
          </RouterLink>
          <a
            v-if="server.url"
            :href="server.url"
            target="_blank"
            rel="noreferrer"
            class="shrink-0 text-faint transition-colors duration-150 hover:text-accent"
            :title="server.url"
            :aria-label="`Open ${server.url}`"
          >
            <ExternalLink class="size-3.5" />
          </a>
        </div>
        <p class="mt-0.5 flex items-center gap-1.5 truncate font-mono text-2xs text-faint">
          <span>{{ server.id }}</span>
          <template v-if="config.port !== null">
            <span aria-hidden="true">·</span>
            <span class="text-muted">:{{ config.port }}</span>
          </template>
          <span aria-hidden="true">·</span>
          <span>{{ server.bindHost }}</span>
          <span v-if="!config.enabled" class="rounded bg-hover px-1 py-px text-muted">disabled</span>
          <span v-if="config.autostart" class="rounded bg-accent-soft px-1 py-px text-accent">autostart</span>
        </p>
      </div>
      <StatusPill :status="server.status" :health="server.health" />
      <Tip
        v-if="server.adopted"
        label="This process replaced itself: the panel adopted the successor instead of starting a second copy. Stop still works, its output stays where the successor sent it."
      >
        <span class="rounded-full border border-line px-2 py-0.5 text-2xs text-muted">detached</span>
      </Tip>
    </header>

    <p class="truncate px-4 pb-3 font-mono text-2xs text-muted" :title="commandLine">
      {{ commandLine }}
    </p>

    <div v-if="props.variant !== 'compact'" class="space-y-2.5 border-y border-line-soft px-4 py-3">
      <div class="grid grid-cols-2 gap-x-4 gap-y-2">
        <MetricSpark
          label="CPU"
          :values="cpuValues"
          :format="formatCpuPercent"
          :max="100"
          color-class="text-cpu"
        />
        <MetricSpark
          label="Memory"
          :values="rssValues"
          :format="formatBytesShort"
          color-class="text-mem"
        />
      </div>
      <MetricSpark
        label="Health probe"
        :values="probeValues"
        :format="value => (value === null ? '—' : `${value} ms`)"
        :height="22"
        color-class="text-probe"
        empty-hint="not probed"
      />
    </div>

    <div v-if="recentEvents.length > 0" class="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-2.5">
      <span v-for="event in recentEvents" :key="`${event.ts}`" class="inline-flex items-center gap-1 text-2xs">
        <component
          :is="EVENT_ICONS[event.type]"
          :class="cn('size-3', TONE_TEXT[HISTORY_TYPE_TONE[event.type]])"
        />
        <span class="text-muted">{{ HISTORY_TYPE_LABEL[event.type] }}</span>
        <span class="text-faint">{{ formatAgo(event.ts, props.now) }}</span>
      </span>
    </div>

    <div
      v-if="server.lastError || unhealthyFor || retryIn"
      class="flex flex-col gap-1 px-4 pt-2.5"
    >
      <p v-if="server.lastError" class="flex items-start gap-1.5 text-2xs leading-4 text-danger">
        <CircleAlert class="mt-0.5 size-3 shrink-0" />
        <span class="min-w-0 break-words">{{ server.lastError }}</span>
      </p>
      <KillPortButton
        v-if="server.status === 'conflict' && config.port !== null"
        :port="config.port"
        :busy="busy"
        class="self-start"
        @confirm="killPortHolder"
      />
      <p v-if="unhealthyFor" class="text-2xs leading-4 text-warn">
        Unhealthy for {{ unhealthyFor }}
      </p>
      <p v-if="retryIn" class="text-2xs leading-4 text-warn">
        Next attempt {{ retryIn }}
      </p>
    </div>

    <dl class="grid grid-cols-2 gap-x-4 gap-y-1 px-4 py-3 sm:grid-cols-4">
      <div v-for="row in meta" :key="row.key" class="min-w-0">
        <dt class="truncate text-2xs text-faint">
          {{ row.label }}
        </dt>
        <dd class="truncate font-mono text-xs tabular-nums text-ink capitalize">
          {{ row.value }}
        </dd>
      </div>
    </dl>

    <div class="mt-auto flex items-center gap-1.5 border-t border-line-soft px-4 py-2.5">
      <AppButton
        variant="primary"
        size="xs"
        :disabled="busy || !canStart"
        @click="act('start')"
      >
        <Play class="size-3" />Start
      </AppButton>
      <AppButton size="xs" :disabled="busy || !canStop" @click="act('stop')">
        <Square class="size-3" />Stop
      </AppButton>
      <AppButton size="xs" :disabled="busy || !config.enabled" @click="act('restart')">
        <RotateCw class="size-3" />Restart
      </AppButton>

      <Tip label="Live logs and full telemetry">
        <RouterLink :to="`/servers/${server.id}`">
          <AppButton size="xs" variant="ghost">
            <ScrollText class="size-3" />Details
          </AppButton>
        </RouterLink>
      </Tip>

      <DropdownMenuRoot>
        <DropdownMenuTrigger as-child>
          <AppButton size="icon-sm" variant="ghost" class="ml-auto" :aria-label="`More actions for ${label}`">
            <MoreHorizontal class="size-4" />
          </AppButton>
        </DropdownMenuTrigger>
        <DropdownMenuPortal>
          <DropdownMenuContent
            :side-offset="4"
            align="end"
            class="z-50 min-w-52 rounded-panel border border-line bg-raise p-1 shadow-float data-[state=open]:animate-[hh-fade-in_120ms_ease-out]"
          >
            <DropdownMenuItem
              class="flex cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 text-xs text-muted outline-none data-[highlighted]:bg-hover data-[highlighted]:text-ink"
              @select="toggle('enabled')"
            >
              <Power class="size-3.5" />
              {{ config.enabled ? 'Disable server' : 'Enable server' }}
            </DropdownMenuItem>
            <DropdownMenuItem
              class="flex cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 text-xs text-muted outline-none data-[highlighted]:bg-hover data-[highlighted]:text-ink"
              @select="toggle('autostart')"
            >
              <Play class="size-3.5" />
              {{ config.autostart ? 'Remove from autostart' : 'Autostart with the panel' }}
            </DropdownMenuItem>
            <DropdownMenuItem
              class="flex cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 text-xs text-muted outline-none data-[highlighted]:bg-hover data-[highlighted]:text-ink"
              @select="control.clearLogs(server.id)"
            >
              <ScrollText class="size-3.5" />
              Clear log buffer
            </DropdownMenuItem>
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
    </div>

    <Modal
      v-model:open="confirmRemove"
      title="Remove this server?"
      :description="`${label} is removed from servers.config.json. Its process is stopped and its persisted logs stay on disk.`"
      width="w-[min(92vw,26rem)]"
    >
      <dl class="grid grid-cols-2 gap-2 text-xs">
        <div>
          <dt class="text-faint">
            id
          </dt>
          <dd class="font-mono text-ink">
            {{ server.id }}
          </dd>
        </div>
        <div>
          <dt class="text-faint">
            status
          </dt>
          <dd class="text-ink capitalize">
            {{ server.status }}
          </dd>
        </div>
      </dl>
      <template #footer>
        <AppButton variant="ghost" @click="confirmRemove = false">
          Keep it
        </AppButton>
        <AppButton variant="danger" @click="remove">
          <Trash2 class="size-3.5" />Remove
        </AppButton>
      </template>
    </Modal>
  </article>
</template>
