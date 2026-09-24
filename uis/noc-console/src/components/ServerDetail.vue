<script setup lang="ts">
import type { Bind, LogLine, ServerStatus, ServerView } from '@shared/contracts'
import { parseBind } from '@shared/contracts'
import { computed, onScopeDispose, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import ConfirmButton from '@/components/ConfirmButton.vue'
import HealthChip from '@/components/HealthChip.vue'
import HistoryList from '@/components/HistoryList.vue'
import LogPane from '@/components/LogPane.vue'
import Sparkline from '@/components/Sparkline.vue'
import StatusChip from '@/components/StatusChip.vue'
import { unwatchLogs, useControlPlane, watchLogs } from '@/composables/useControlPlane'
import { flash, useUi } from '@/composables/useUi'
import {
  briefBytes,
  formatAgo,
  formatDuration,
  formatMs,
  formatRatio,
  formatUptime,
  relativeFrom,
} from '@/lib/format'

const props = defineProps<{ server: ServerView, now: number }>()

const control = useControlPlane()
const router = useRouter()
const { drawerOpen } = useUi()

const config = computed(() => props.server.config)
const label = computed(() => (config.value.label && config.value.label.length > 0 ? config.value.label : props.server.id))
const series = computed(() => control.seriesOf(props.server.id))
const lines = ref<LogLine[]>([])
const busy = ref(false)

watch(() => props.server.id, (id, previous) => {
  if (previous !== undefined)
    unwatchLogs(previous)
  lines.value = watchLogs(id)
}, { immediate: true })

onScopeDispose(() => unwatchLogs(props.server.id))

const commandLine = computed(() => `${config.value.command} ${config.value.args.join(' ')}`.trim())

const uptime = computed(() => (props.server.startedAt === null || props.server.status !== 'running'
  ? '—'
  : formatUptime(props.now - props.server.startedAt)))

const retryIn = computed(() => (props.server.nextRetryAt === null ? null : relativeFrom(props.server.nextRetryAt, props.now)))

const history = computed(() => [...props.server.history.events].reverse().slice(0, 24))

const bindOptions = computed(() => {
  const options = [
    { value: 'local', label: 'local · 127.0.0.1' },
    { value: 'lan', label: 'lan · 0.0.0.0' },
  ]
  const current = config.value.bind
  if (current !== 'local' && current !== 'lan')
    options.push({ value: current, label: current })
  return options
})

const cpuPercent = computed(() => props.server.resources?.cpuPercent ?? null)
const rssBytes = computed(() => props.server.resources?.rssBytes ?? null)

function cpuColor(): string {
  const value = cpuPercent.value ?? 0
  if (value >= 80)
    return 'var(--danger)'
  if (value >= 40)
    return 'var(--warn)'
  return 'var(--accent)'
}

function probeColor(): string {
  const value = props.server.responseMs ?? 0
  if (value >= 1000)
    return 'var(--danger)'
  if (value >= 300)
    return 'var(--warn)'
  return 'var(--ok)'
}

function toneClass(value: number | null, warn: number, danger: number): string {
  if (value === null)
    return 'metric__v--dim'
  if (value >= danger)
    return 'metric__v--danger'
  if (value >= warn)
    return 'metric__v--warn'
  return ''
}

async function act(action: 'start' | 'stop' | 'restart'): Promise<void> {
  busy.value = true
  try {
    await control.act(props.server.id, action)
  }
  finally {
    busy.value = false
  }
}

async function toggleEnabled(event: Event): Promise<void> {
  await control.setEnabled(props.server.id, (event.target as HTMLInputElement).checked)
}

async function toggleAutostart(event: Event): Promise<void> {
  await control.setAutostart(props.server.id, (event.target as HTMLInputElement).checked)
}

async function changeBind(event: Event): Promise<void> {
  const bind: Bind | null = parseBind((event.target as HTMLSelectElement).value)
  if (bind === null)
    return
  await control.setBind(props.server.id, bind)
}

async function remove(): Promise<void> {
  const id = props.server.id
  await control.remove(id)
  if (control.lastError.value === null)
    flash(`removed ${id}`)
}

function edit(): void {
  void router.push({ name: 'server-config', params: { id: props.server.id } })
}

async function clearBuffer(): Promise<void> {
  const id = props.server.id
  await control.clearLogs(id)
  flash(`${id}: buffered logs cleared`)
}

function ledClass(status: ServerStatus): string {
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
</script>

<template>
  <div class="split__half--detail">
    <div class="detailbox">
      <div class="row">
        <span class="led" :class="ledClass(server.status)" />
        <span class="mono" style="color: var(--text-hi); font-size: 14px">{{ label }}</span>
        <span class="faint mono">{{ server.id }}</span>
        <StatusChip :status="server.status" />
        <HealthChip :health="server.health" />
        <span class="view__spacer" />
        <a v-if="server.url" class="chip chip--accent" :href="server.url" target="_blank" rel="noreferrer">{{ server.url }}</a>
      </div>

      <div class="row actions--start">
        <button type="button" class="btn btn--sm btn--primary" :disabled="busy || !config.enabled" @click="act('start')">
          start <kbd class="kbd">s</kbd>
        </button>
        <button type="button" class="btn btn--sm" :disabled="busy" @click="act('stop')">
          stop <kbd class="kbd">x</kbd>
        </button>
        <button type="button" class="btn btn--sm" :disabled="busy || !config.enabled" @click="act('restart')">
          restart <kbd class="kbd">r</kbd>
        </button>
        <span class="faint">|</span>
        <button type="button" class="btn btn--sm" @click="edit">
          edit config <kbd class="kbd">e</kbd>
        </button>
        <button
          type="button"
          class="btn btn--sm"
          :class="{ 'btn--on': drawerOpen }"
          title="live log drawer (l)"
          @click="drawerOpen = !drawerOpen"
        >
          logs
        </button>
        <span class="view__spacer" />
        <button type="button" class="btn btn--sm btn--ghost" title="clear the in-memory buffer (c)" @click="clearBuffer">
          clear buffer
        </button>
        <ConfirmButton label="remove" confirm-label="confirm remove" tone="danger" :disabled="busy" @confirm="remove" />
      </div>

      <div class="row">
        <label class="row" style="gap: 0.3rem">
          <input type="checkbox" :checked="config.autostart" :disabled="busy" @change="toggleAutostart">
          <span class="faint">autostart</span>
        </label>
        <label class="row" style="gap: 0.3rem">
          <input type="checkbox" :checked="config.enabled" :disabled="busy" @change="toggleEnabled">
          <span class="faint">enabled</span>
        </label>
        <label class="row" style="gap: 0.3rem">
          <span class="faint">bind</span>
          <select :value="config.bind" :disabled="busy" @change="changeBind">
            <option v-for="option in bindOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
        </label>
      </div>

      <p v-if="server.lastError" class="note note--error">
        {{ server.lastError }}
      </p>
      <p v-if="server.health === 'unhealthy'" class="note note--warn">
        health probe not answering
        <template v-if="server.unhealthySince !== null">
          for {{ formatDuration(now - server.unhealthySince) }}
        </template>
        ·
        <template v-if="retryIn">
          next try {{ retryIn }}
        </template>
        <template v-else>
          waiting for the next probe
        </template>
      </p>
      <p v-if="!config.enabled" class="note">
        disabled — start/restart are refused until it is enabled again
      </p>
    </div>

    <div class="metrics">
      <div class="metric">
        <div class="metric__k">
          pid
        </div>
        <div class="metric__v">
          {{ server.pid ?? '—' }}
        </div>
      </div>
      <div class="metric">
        <div class="metric__k">
          uptime
        </div>
        <div class="metric__v">
          {{ uptime }}
        </div>
      </div>
      <div class="metric">
        <div class="metric__k">
          restarts
        </div>
        <div class="metric__v">
          {{ server.restarts }}<span class="metric__sub">/{{ server.maxRetries }}</span>
        </div>
      </div>
      <div class="metric">
        <div class="metric__k">
          port
        </div>
        <div class="metric__v metric__v--dim">
          {{ config.port ?? '—' }} <span class="metric__sub">{{ server.portState }}</span>
        </div>
      </div>
      <div class="metric">
        <div class="metric__k">
          probe
        </div>
        <div class="metric__v" :class="toneClass(server.responseMs, 300, 1000)">
          {{ formatMs(server.responseMs) }}
        </div>
        <Sparkline :values="series.probe" :color="probeColor()" :width="92" :height="16" />
      </div>
      <div class="metric">
        <div class="metric__k">
          cpu
        </div>
        <div class="metric__v" :class="toneClass(cpuPercent, 40, 80)">
          {{ cpuPercent === null ? '—' : `${cpuPercent.toFixed(0)}%` }}
        </div>
        <Sparkline :values="series.cpu" :color="cpuColor()" :width="92" :height="16" />
      </div>
      <div class="metric">
        <div class="metric__k">
          rss
        </div>
        <div class="metric__v">
          {{ briefBytes(rssBytes) }}
        </div>
        <Sparkline :values="series.rss" color="var(--accent)" :width="92" :height="16" />
      </div>
      <div class="metric">
        <div class="metric__k">
          procs
        </div>
        <div class="metric__v metric__v--dim">
          {{ server.resources?.processes ?? '—' }}
        </div>
      </div>
      <div class="metric">
        <div class="metric__k">
          buffered
        </div>
        <div class="metric__v metric__v--dim">
          {{ server.bufferedLines }}<span class="metric__sub"> ln</span>
        </div>
      </div>
      <div class="metric">
        <div class="metric__k">
          24h up
        </div>
        <div class="metric__v">
          {{ formatRatio(server.history.uptimeRatio) }}
        </div>
      </div>
      <div class="metric">
        <div class="metric__k">
          24h crashes
        </div>
        <div class="metric__v" :class="server.history.crashes > 0 ? 'metric__v--danger' : ''">
          {{ server.history.crashes }}
        </div>
      </div>
      <div class="metric">
        <div class="metric__k">
          forced
        </div>
        <div class="metric__v metric__v--dim">
          {{ server.history.forcedRestarts }}
        </div>
      </div>
      <div class="metric">
        <div class="metric__k">
          last crash
        </div>
        <div class="metric__v metric__v--dim">
          {{ formatAgo(server.history.lastCrashAt, now) }}
        </div>
      </div>
      <div class="metric">
        <div class="metric__k">
          last exit
        </div>
        <div class="metric__v metric__v--dim">
          {{ formatAgo(server.history.lastExitAt, now) }}
        </div>
      </div>
      <div class="metric">
        <div class="metric__k">
          last runtime
        </div>
        <div class="metric__v metric__v--dim">
          {{ server.history.lastRuntimeMs === null ? '—' : formatDuration(server.history.lastRuntimeMs) }}
        </div>
      </div>
      <div class="metric">
        <div class="metric__k">
          exit
        </div>
        <div class="metric__v metric__v--dim">
          {{ server.exitCode ?? server.exitSignal ?? '—' }}
        </div>
      </div>
    </div>

    <div class="detailbox">
      <div class="detailbox__row">
        <span class="detailbox__k">command</span>
        <span class="detailbox__v"><code class="cmdline">{{ commandLine }}</code></span>
      </div>
      <div class="detailbox__row">
        <span class="detailbox__k">cwd</span>
        <span class="detailbox__v">{{ config.cwd }}</span>
      </div>
      <div class="detailbox__row">
        <span class="detailbox__k">env</span>
        <span class="detailbox__v">
          <template v-if="Object.keys(config.env).length === 0">none</template>
          <template v-else>{{ Object.keys(config.env).join(' · ') }}</template>
        </span>
      </div>
      <div class="detailbox__row">
        <span class="detailbox__k">data envs</span>
        <span class="detailbox__v">
          <template v-if="Object.keys(config.dataEnvs).length === 0">none</template>
          <template v-else>{{ Object.entries(config.dataEnvs).map(([key, value]) => `${key}=${value}`).join(' · ') }}</template>
        </span>
      </div>
      <div v-if="config.envFile.length > 0" class="detailbox__row">
        <span class="detailbox__k">env file</span>
        <span class="detailbox__v">{{ config.envFile }}</span>
      </div>
      <div v-if="config.dependsOn.length > 0" class="detailbox__row">
        <span class="detailbox__k">starts after</span>
        <span class="detailbox__v deps">
          <span v-for="id in config.dependsOn" :key="id" class="chip chip--neutral">{{ id }}</span>
        </span>
      </div>
      <div class="detailbox__row">
        <span class="detailbox__k">health</span>
        <span class="detailbox__v">
          <template v-if="!config.health.enabled">off</template>
          <template v-else>
            {{ config.health.mode }} · every {{ formatMs(config.health.intervalMs) }} · timeout {{ formatMs(config.health.timeoutMs) }}
            · {{ config.health.unhealthyThreshold }} fails
            <template v-if="config.health.forceRestartAfterMs > 0"> · force restart after {{ formatDuration(config.health.forceRestartAfterMs) }}</template>
            <template v-if="config.health.mode === 'http'">
              · {{ config.health.http.method }} {{ config.health.http.path }}
              · expect {{ config.health.http.expectStatus ?? `below ${config.health.http.expectStatusBelow}` }}
              <template v-if="config.health.http.expectBody.length > 0"> · body contains "{{ config.health.http.expectBody }}"</template>
            </template>
            · start window {{ formatDuration(config.health.startTimeoutMs) }}
          </template>
        </span>
      </div>
      <div class="detailbox__row">
        <span class="detailbox__k">restart</span>
        <span class="detailbox__v">
          <template v-if="!config.restart.enabled">off</template>
          <template v-else>
            {{ config.restart.maxRetries }} retries · base {{ formatMs(config.restart.baseDelayMs) }} · x{{ config.restart.factor }}
            · max {{ formatMs(config.restart.maxDelayMs) }} · reset after {{ formatDuration(config.restart.resetAfterMs) }}
          </template>
        </span>
      </div>
      <div class="detailbox__row">
        <span class="detailbox__k">stop</span>
        <span class="detailbox__v">
          {{ config.stop.signal }} · grace {{ formatMs(config.stop.graceMs) }}
          <template v-if="config.stop.killGroup"> · process group</template>
          <template v-if="config.stop.killPortHolders"> · kill port holders</template>
        </span>
      </div>
      <div class="detailbox__row">
        <span class="detailbox__k">resources</span>
        <span class="detailbox__v">
          <template v-if="config.resources.maxRssBytes > 0">restart over {{ briefBytes(config.resources.maxRssBytes) }} RSS</template>
          <template v-else>no rss guard</template>
        </span>
      </div>
      <div class="detailbox__row">
        <span class="detailbox__k">bootstrap</span>
        <span class="detailbox__v">
          <template v-if="config.bootstrap">{{ config.bootstrap.command }} {{ config.bootstrap.args.join(' ') }}
            <span class="faint">· {{ formatDuration(config.bootstrap.timeoutMs) }}<template v-if="config.bootstrap.runOnce"> · once</template></span>
          </template>
          <template v-else>none</template>
        </span>
      </div>
      <div v-if="config.backupPaths.length > 0" class="detailbox__row">
        <span class="detailbox__k">backups</span>
        <span class="detailbox__v">{{ config.backupPaths.join(' · ') }}</span>
      </div>
      <div class="detailbox__row">
        <span class="detailbox__k">log buffer</span>
        <span class="detailbox__v">{{ config.logBufferLines }} lines · on conflict: {{ config.onPortConflict }}</span>
      </div>
    </div>

    <div class="pane">
      <div class="pane__head">
        <span class="pane__title">history</span>
        <span class="faint mono">24h · up {{ formatRatio(server.history.uptimeRatio) }} · {{ server.history.crashes }} crashes</span>
      </div>
      <div class="pane__body">
        <HistoryList :events="history" :now="now" />
      </div>
    </div>

    <div class="pane" style="flex: 1; min-height: 150px">
      <div class="pane__head">
        <span class="pane__title">live output</span>
        <span class="faint mono">{{ server.status === 'running' ? 'streaming' : 'buffered' }}</span>
      </div>
      <LogPane :lines="lines" live :empty="server.status === 'running' ? 'waiting for output…' : 'no buffered output'" />
    </div>
  </div>
</template>
