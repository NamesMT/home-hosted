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
} from '@lucide/vue'
import { liveReadings } from '@shared/server-readings'
import { browserServerUrl, pageHostname } from '@shared/server-url'
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuRoot, DropdownMenuSeparator, DropdownMenuTrigger } from 'reka-ui'
import { computed, ref } from 'vue'
import KillPortButton from '@/components/server/KillPortButton.vue'
import MetricSpark from '@/components/telemetry/MetricSpark.vue'
import AppButton from '@/components/ui/AppButton.vue'
import Modal from '@/components/ui/Modal.vue'
import StatusPill from '@/components/ui/StatusPill.vue'
import Tip from '@/components/ui/Tip.vue'
import { useControlPlane } from '@/composables/useControlPlane'
import { useWorkspaces } from '@/composables/useWorkspaces'
import { t } from '@/i18n'
import { cn } from '@/lib/cn'
import { formatAgo, formatBytesShort, formatCpuPercent, formatDuration, formatRatio, relativeFrom } from '@/lib/format'
import { HISTORY_TYPE_LABEL_KEY, HISTORY_TYPE_TONE, serverTone, TONE_TEXT } from '@/lib/status'
import { workspacePath } from '@/router'

const props = withDefaults(defineProps<{
  server: ServerView
  /** The workspace that owns this entry; every action is scoped to it. */
  workspaceId: string
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
const workspace = useWorkspaces()
const busy = ref(false)
const confirmRemove = ref(false)

const config = computed(() => props.server.config)
const label = computed(() => (config.value.label && config.value.label.length > 0 ? config.value.label : props.server.id))
const commandLine = computed(() => `${config.value.command} ${config.value.args.join(' ')}`.trim())
const tone = computed(() => serverTone(props.server.status, props.server.health))

/**
 * The link follows the hostname this page was reached at when the entry binds every interface: its
 * LAN address is unroutable for a viewer arriving over a public name or a tunnel. See `@shared/server-url`.
 */
const serverUrl = computed(() => browserServerUrl(props.server, pageHostname()))

const isRunning = computed(() => props.server.status === 'running')
const canStart = computed(() => config.value.enabled && ['stopped', 'crashed', 'conflict'].includes(props.server.status))
const canStop = computed(() => ['running', 'starting', 'backoff'].includes(props.server.status))

const uptime = computed(() => (props.server.startedAt === null || !isRunning.value
  ? '—'
  : formatDuration(props.now - props.server.startedAt)))

const retryIn = computed(() => (props.server.nextRetryAt === null ? null : relativeFrom(props.server.nextRetryAt, props.now)))

/**
 * The duration only means something while the probe is failing.
 *
 * A newer UI is served against an older panel (the upgrade rule), and a panel before this release
 * left the timestamp behind when a process exited — so the card would print "Unhealthy for 3m 17s"
 * beside its own `Health probe not probed`. The verdict is the gate; the timestamp is the duration.
 */
const unhealthyFor = computed(() => (props.server.health !== 'unhealthy' || props.server.unhealthySince === null
  ? null
  : formatDuration(props.now - props.server.unhealthySince)))

const cpuValues = computed(() => props.series?.cpu ?? [])
const rssValues = computed(() => props.series?.rss ?? [])
const probeValues = computed(() => props.series?.probe ?? [])

/**
 * The chart's ceiling: the whole machine, not one core.
 *
 * `cpuPercent` sums the entry's process tree, so four busy cores is `400` — a real reading, not an
 * error. With a fixed `100` those points were clipped to the top edge and every multi-core server
 * looked pinned at 100%. Scaling to `cpus * 100` also answers the question a person actually has:
 * how much of *this box* is that one server using.
 */
const cpuCeiling = computed(() => Math.max(100, (control.host.value?.cpus ?? 1) * 100))

/** The three most recent events, newest first. */
const recentEvents = computed(() => [...props.server.history.events].slice(-3).reverse())

/** The port enum renders as a word; `unknown` is the Lead's shared one, the rest are this card's. */
const PORT_STATE_LABEL_KEY: Record<string, string> = {
  'unknown': 'common.unknown',
  'free': 'serverCard.portFree',
  'in-use': 'serverCard.portInUse',
}

const meta = computed(() => {
  const server = props.server
  // The probe latency and the CPU/RSS sample are one process's numbers. They are read through the
  // shared predicate because a newer UI is served against an older panel, and a panel before this
  // release kept them across an adopted entry's stop — so the card would print `Probe 2 Ms`,
  // `RSS 64.2 MB`, `Procs 1` beside its own `Stopped` pill.
  const live = liveReadings(server)
  const rows: Array<{ key: string, label: string, value: string, title?: string }> = [
    { key: 'pid', label: t('serverCard.pid'), value: server.pid === null ? '—' : String(server.pid) },
    { key: 'uptime', label: t('common.uptime'), value: uptime.value },
    { key: 'restarts', label: t('serverCard.restarts'), value: `${server.restarts}/${server.maxRetries}` },
    { key: 'port', label: t('common.port'), value: t(PORT_STATE_LABEL_KEY[server.portState] ?? 'common.unknown') },
    { key: 'uptime24', label: t('serverCard.uptime24h'), value: formatRatio(server.history.uptimeRatio) },
    { key: 'probe', label: t('serverCard.probe'), value: live.responseMs === null ? '—' : `${live.responseMs} ms` },
    { key: 'rss', label: t('serverCard.rss'), value: formatBytesShort(live.rssBytes) },
    { key: 'procs', label: t('serverCard.procs'), value: live.processes === null ? '—' : String(live.processes) },
  ]
  if (server.history.crashes > 0)
    rows.splice(5, 0, { key: 'crashes', label: t('serverCard.crashes24h'), value: String(server.history.crashes) })
  if (server.history.lastCrashAt !== null)
    rows.push({ key: 'lastcrash', label: t('serverCard.lastCrash'), value: formatAgo(server.history.lastCrashAt, props.now) })
  return rows
})

async function act(action: 'start' | 'stop' | 'restart'): Promise<void> {
  busy.value = true
  try {
    await control[action](props.workspaceId, props.server.id)
  }
  finally {
    busy.value = false
  }
}

/** Frees the port this entry is blocked on; the button names the exact port. */
async function killPortHolder(): Promise<void> {
  busy.value = true
  try {
    await control.freePort(props.workspaceId, props.server.id)
  }
  finally {
    busy.value = false
  }
}

async function toggle(flag: 'enabled' | 'autostart'): Promise<void> {
  const next = !(flag === 'enabled' ? config.value.enabled : config.value.autostart)
  if (flag === 'enabled')
    await control.setEnabled(props.workspaceId, props.server.id, next)
  else
    await control.setAutostart(props.workspaceId, props.server.id, next)
}

async function remove(): Promise<void> {
  confirmRemove.value = false
  await control.remove(props.workspaceId, props.server.id)
}

/**
 * A detail page is workspace-scoped, so this is the only shape the route matches.
 *
 * These links used to be the pre-workspace `/servers/<id>`, which no route has had since the
 * routes moved under `/w/:workspaceId` — so clicking a card fell through to the catch-all and the
 * guard rewrote it to the global overview. The click handler selecting the workspace first did not
 * help: the `to` was still a path nothing matched.
 */
const detailPath = computed(() => workspacePath(props.workspaceId, 'servers', props.server.id))

function openDetail(): void {
  workspace.select(props.workspaceId)
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
            :to="detailPath"
            class="truncate text-sm font-semibold tracking-tight text-ink hover:text-accent"
            @click="openDetail"
          >
            {{ label }}
          </RouterLink>
          <!--
            A 14 px glyph is a 14 px target, and it sits 8 px from the title link that
            opens the detail page: on a phone the two are one thumb-width apart, so the
            tap that misses "open the page" lands on "leave the panel". The icon keeps
            its size; the box around it grows to the 24 px the other icon controls use.
          -->
          <a
            v-if="serverUrl"
            :href="serverUrl"
            target="_blank"
            rel="noreferrer"
            class="-my-1 grid size-6 shrink-0 place-items-center rounded-control text-faint transition-colors duration-150 hover:bg-hover hover:text-accent"
            :title="serverUrl"
            :aria-label="t('serverCard.open', { url: serverUrl })"
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
          <span v-if="!config.enabled" class="rounded bg-hover px-1 py-px text-muted">{{ t('serverCard.disabled') }}</span>
          <span v-if="config.autostart" class="rounded bg-accent-soft px-1 py-px text-accent">{{ t('serverCard.autostart') }}</span>
        </p>
      </div>
      <StatusPill :status="server.status" :health="server.health" />
      <Tip
        v-if="server.adopted"
        :label="t('serverCard.adoptedHint')"
      >
        <span class="rounded-full border border-line px-2 py-0.5 text-2xs text-muted">{{ t('serverCard.detached') }}</span>
      </Tip>
      <Tip
        v-if="config.persistent"
        :label="t('serverCard.persistentHint')"
      >
        <span class="rounded-full border border-line px-2 py-0.5 text-2xs text-muted">{{ t('serverCard.persistent') }}</span>
      </Tip>
    </header>

    <p class="truncate px-4 pb-3 font-mono text-2xs text-muted" :title="commandLine">
      {{ commandLine }}
    </p>

    <div v-if="props.variant !== 'compact'" class="space-y-2.5 border-y border-line-soft px-4 py-3">
      <div class="grid grid-cols-2 gap-x-4 gap-y-2">
        <!--
          "collecting…" is a promise that data is on its way. On a stopped entry nothing is
          coming, so the label read as a spinner that never finished; say the honest thing.
        -->
        <MetricSpark
          :label="t('common.cpu')"
          :values="cpuValues"
          :format="formatCpuPercent"
          :max="cpuCeiling"
          :empty-hint="isRunning ? undefined : t('metric.notRunning')"
          color-class="text-cpu"
        />
        <MetricSpark
          :label="t('common.memory')"
          :values="rssValues"
          :format="formatBytesShort"
          :empty-hint="isRunning ? undefined : t('metric.notRunning')"
          color-class="text-mem"
        />
      </div>
      <MetricSpark
        :label="t('serverCard.healthProbe')"
        :values="probeValues"
        :format="value => (value === null ? '—' : `${value} ms`)"
        :height="22"
        color-class="text-probe"
        :empty-hint="t('serverCard.notProbed')"
      />
    </div>

    <div v-if="recentEvents.length > 0" class="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-2.5">
      <span v-for="event in recentEvents" :key="`${event.ts}`" class="inline-flex items-center gap-1 text-2xs">
        <component
          :is="EVENT_ICONS[event.type]"
          :class="cn('size-3', TONE_TEXT[HISTORY_TYPE_TONE[event.type]])"
        />
        <span class="text-muted">{{ t(HISTORY_TYPE_LABEL_KEY[event.type]) }}</span>
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
        {{ t('serverCard.unhealthyFor', { duration: unhealthyFor }) }}
      </p>
      <p v-if="retryIn" class="text-2xs leading-4 text-warn">
        {{ t('serverCard.nextAttempt', { when: retryIn }) }}
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

    <!-- Four labelled buttons plus the overflow menu do not fit a 320 px phone on one
         row: unwrapped they held the card open wider than the screen and pushed the `…`
         menu off the right edge. Wrapping keeps every action reachable. -->
    <div class="mt-auto flex flex-wrap items-center gap-1.5 border-t border-line-soft px-4 py-2.5">
      <AppButton
        variant="primary"
        size="xs"
        :disabled="busy || !canStart"
        @click="act('start')"
      >
        <Play class="size-3" />{{ t('serverCard.start') }}
      </AppButton>
      <AppButton size="xs" :disabled="busy || !canStop" @click="act('stop')">
        <Square class="size-3" />{{ t('serverCard.stop') }}
      </AppButton>
      <AppButton size="xs" :disabled="busy || !config.enabled" @click="act('restart')">
        <RotateCw class="size-3" />{{ t('serverCard.restart') }}
      </AppButton>

      <Tip :label="t('serverCard.detailsHint')">
        <RouterLink :to="detailPath" @click="openDetail">
          <AppButton size="xs" variant="ghost">
            <ScrollText class="size-3" />{{ t('common.details') }}
          </AppButton>
        </RouterLink>
      </Tip>

      <DropdownMenuRoot>
        <DropdownMenuTrigger as-child>
          <AppButton size="icon-sm" variant="ghost" class="ml-auto" :aria-label="t('serverCard.moreActions', { label })">
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
              {{ config.enabled ? t('serverCard.disable') : t('serverCard.enable') }}
            </DropdownMenuItem>
            <DropdownMenuItem
              class="flex cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 text-xs text-muted outline-none data-[highlighted]:bg-hover data-[highlighted]:text-ink"
              @select="toggle('autostart')"
            >
              <Play class="size-3.5" />
              {{ config.autostart ? t('serverCard.removeFromAutostart') : t('serverCard.autostartWithPanel') }}
            </DropdownMenuItem>
            <DropdownMenuItem
              class="flex cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 text-xs text-muted outline-none data-[highlighted]:bg-hover data-[highlighted]:text-ink"
              @select="control.clearLogs(workspaceId, server.id)"
            >
              <ScrollText class="size-3.5" />
              {{ t('serverCard.clearLogBuffer') }}
            </DropdownMenuItem>
            <DropdownMenuSeparator class="my-1 h-px bg-line" />
            <DropdownMenuItem
              class="flex cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 text-xs text-danger outline-none data-[highlighted]:bg-danger-soft"
              @select="confirmRemove = true"
            >
              <Trash2 class="size-3.5" />
              {{ t('serverCard.removeServer') }}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenuPortal>
      </DropdownMenuRoot>
    </div>

    <Modal
      v-model:open="confirmRemove"
      :title="t('serverCard.removeTitle')"
      :description="t('serverCard.removeDescription', { label })"
      width="w-[min(92vw,26rem)]"
    >
      <dl class="grid grid-cols-2 gap-2 text-xs">
        <div>
          <dt class="text-faint">
            {{ t('serverCard.idField') }}
          </dt>
          <dd class="font-mono text-ink">
            {{ server.id }}
          </dd>
        </div>
        <div>
          <dt class="text-faint">
            {{ t('serverCard.statusField') }}
          </dt>
          <dd class="text-ink capitalize">
            {{ server.status }}
          </dd>
        </div>
      </dl>
      <template #footer>
        <AppButton variant="ghost" @click="confirmRemove = false">
          {{ t('common.keepIt') }}
        </AppButton>
        <AppButton variant="danger" @click="remove">
          <Trash2 class="size-3.5" />{{ t('common.remove') }}
        </AppButton>
      </template>
    </Modal>
  </article>
</template>
