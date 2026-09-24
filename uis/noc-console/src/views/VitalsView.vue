<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import MeterBar from '@/components/MeterBar.vue'
import Sparkline from '@/components/Sparkline.vue'
import { useControlPlane } from '@/composables/useControlPlane'
import { formatAgo, formatBytes, formatDuration, loadPerCpu } from '@/lib/format'

const control = useControlPlane()

const host = computed(() => control.host.value)
const disks = computed(() => host.value?.disks ?? [])
const alerts = computed(() => host.value?.alerts ?? [])
const load = computed(() => (host.value ? loadPerCpu(host.value.loadAvg, host.value.cpus) : null))

const SERIES = 60
const loadSeries = ref<number[]>([])
const memSeries = ref<number[]>([])

watch(() => host.value?.sampledAt, () => {
  const view = host.value
  if (!view)
    return
  const next = view.loadAvg[0]
  if (next !== undefined) {
    loadSeries.value.push(next)
    if (loadSeries.value.length > SERIES)
      loadSeries.value.shift()
  }
  memSeries.value.push(view.memoryUsedPercent)
  if (memSeries.value.length > SERIES)
    memSeries.value.shift()
}, { immediate: true })

function diskTone(percent: number): 'ok' | 'warn' | 'danger' {
  if (percent >= 90)
    return 'danger'
  if (percent >= 75)
    return 'warn'
  return 'ok'
}

const loadTone = computed<'accent' | 'warn' | 'danger'>(() => {
  const value = load.value ?? 0
  if (value >= 1)
    return 'danger'
  if (value >= 0.7)
    return 'warn'
  return 'accent'
})
</script>

<template>
  <div class="view">
    <div class="view__head">
      <span class="view__title">host vitals</span>
      <span class="view__count">
        {{ host?.enabled ? `${host.cpus} cpus` : 'sampling off' }}
      </span>
      <span v-if="host?.sampledAt" class="view__count">sampled {{ formatAgo(host.sampledAt, control.now.value) }}</span>
      <span class="view__spacer" />
      <RouterLink to="/settings" class="btn btn--sm btn--ghost">
        thresholds →
      </RouterLink>
    </div>

    <p v-if="alerts.length > 0" class="banner banner--error">
      <span class="led led--unhealthy" />
      <span>{{ alerts.join(' · ') }}</span>
    </p>
    <p v-else-if="host?.enabled" class="banner" style="color: var(--dim)">
      no active alerts
    </p>

    <div class="metrics">
      <div class="metric">
        <div class="metric__k">
          load 1m
        </div>
        <div class="metric__v">
          {{ (host?.loadAvg[0] ?? 0).toFixed(2) }}
        </div>
        <Sparkline :values="loadSeries" color="var(--accent)" :width="120" :height="20" />
      </div>
      <div class="metric">
        <div class="metric__k">
          load 5m
        </div>
        <div class="metric__v">
          {{ (host?.loadAvg[1] ?? 0).toFixed(2) }}
        </div>
      </div>
      <div class="metric">
        <div class="metric__k">
          load 15m
        </div>
        <div class="metric__v">
          {{ (host?.loadAvg[2] ?? 0).toFixed(2) }}
        </div>
      </div>
      <div class="metric">
        <div class="metric__k">
          per cpu
        </div>
        <div class="metric__v" :class="loadTone === 'danger' ? 'metric__v--danger' : loadTone === 'warn' ? 'metric__v--warn' : ''">
          {{ (load ?? 0).toFixed(2) }}
        </div>
      </div>
      <div class="metric">
        <div class="metric__k">
          memory
        </div>
        <div class="metric__v">
          {{ (host?.memoryUsedPercent ?? 0).toFixed(1) }}%
        </div>
        <Sparkline :values="memSeries" color="var(--ok)" :width="120" :height="20" :max="100" />
      </div>
      <div class="metric">
        <div class="metric__k">
          swap
        </div>
        <div class="metric__v">
          {{ (host?.swapUsedPercent ?? 0).toFixed(1) }}%
        </div>
        <MeterBar :value="host?.swapUsedPercent ?? 0" :tone="(host?.swapUsedPercent ?? 0) >= 80 ? 'danger' : (host?.swapUsedPercent ?? 0) >= 50 ? 'warn' : 'ok'" />
      </div>
      <div class="metric">
        <div class="metric__k">
          cpu temp
        </div>
        <div class="metric__v">
          {{ host?.tempCelsius === null || host?.tempCelsius === undefined ? '—' : `${host.tempCelsius.toFixed(0)}°C` }}
        </div>
      </div>
      <div class="metric">
        <div class="metric__k">
          host uptime
        </div>
        <div class="metric__v">
          {{ formatDuration(host?.uptimeMs ?? 0) }}
        </div>
      </div>
      <div class="metric">
        <div class="metric__k">
          cpus
        </div>
        <div class="metric__v metric__v--dim">
          {{ host?.cpus ?? '—' }}
        </div>
      </div>
    </div>

    <div class="pane">
      <div class="pane__head">
        <span class="pane__title">filesystems</span>
        <span class="faint mono">{{ disks.length }} configured path(s)</span>
      </div>
      <div class="pane__body">
        <table class="tbl">
          <thead>
            <tr>
              <th>path</th>
              <th class="num">
                total
              </th>
              <th class="num">
                free
              </th>
              <th class="num">
                used
              </th>
              <th>usage</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="disk in disks" :key="disk.path">
              <td class="id">
                {{ disk.path }}
              </td>
              <td class="num">
                {{ formatBytes(disk.totalBytes) }}
              </td>
              <td class="num">
                {{ formatBytes(disk.freeBytes) }}
              </td>
              <td class="num" :class="diskTone(disk.usedPercent) === 'danger' ? 'danger' : diskTone(disk.usedPercent) === 'warn' ? 'warn' : ''">
                {{ disk.usedPercent.toFixed(1) }}%
              </td>
              <td style="width: 34%">
                <MeterBar :value="disk.usedPercent" :tone="diskTone(disk.usedPercent)" :digits="1" />
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="disks.length === 0" class="empty">
          no disk paths configured — add them under host vitals thresholds in settings
        </p>
      </div>
    </div>

    <div v-if="alerts.length > 0" class="pane">
      <div class="pane__head">
        <span class="pane__title">active alerts</span>
      </div>
      <div class="pane__body" style="padding: 0.5rem 0.75rem">
        <ul class="stack" style="list-style: none; padding: 0">
          <li v-for="alert in alerts" :key="alert" class="row">
            <span class="led led--unhealthy" />
            <span class="mono">{{ alert }}</span>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>
