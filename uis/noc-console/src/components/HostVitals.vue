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
/** The real percentage. Load is a count of runnable tasks, so it is never shown as one. */
const cpuUsed = computed(() => host.value?.cpuUsedPercent ?? null)

const SERIES = 60
const cpuSeries = ref<number[]>([])
const loadSeries = ref<number[]>([])
const memSeries = ref<number[]>([])

/** One entry per host sample, so a chart's x-axis is the sampling interval, not the render rate. */
function pushCapped(series: number[], value: number | null | undefined): void {
  if (value === null || value === undefined || !Number.isFinite(value))
    return
  series.push(value)
  if (series.length > SERIES)
    series.shift()
}

watch(() => host.value?.sampledAt, () => {
  const view = host.value
  if (!view)
    return
  pushCapped(cpuSeries.value, view.cpuUsedPercent)
  pushCapped(loadSeries.value, view.loadAvg[0])
  pushCapped(memSeries.value, view.memoryUsedPercent)
}, { immediate: true })

function diskTone(percent: number): 'ok' | 'warn' | 'danger' {
  if (percent >= 90)
    return 'danger'
  if (percent >= 75)
    return 'warn'
  return 'ok'
}

/**
 * Load is a *count* of runnable tasks, not a share: `1.00` is one core's worth, and on a 24-core
 * host that is nothing. The old bands painted that red. The bands now follow the configured alert
 * threshold (default 2/cpu), which is the number the panel itself notifies on.
 */
const loadTone = computed<'accent' | 'warn' | 'danger'>(() => {
  const value = load.value ?? 0
  if (value >= 2)
    return 'danger'
  if (value >= 1.4)
    return 'warn'
  return 'accent'
})
</script>

<template>
  <section class="pane">
    <div class="pane__head">
      <span class="pane__title">host vitals</span>
      <span class="faint">{{ host?.enabled ? `${host.cpus} cpus` : 'sampling off' }}</span>
      <span v-if="host?.sampledAt" class="faint">sampled {{ formatAgo(host.sampledAt, control.now.value) }}</span>
      <span class="view__spacer" />
      <span v-if="alerts.length > 0" class="chip chip--danger">{{ alerts.length }} alert{{ alerts.length === 1 ? '' : 's' }}</span>
      <span v-else class="chip chip--ok">quiet</span>
      <RouterLink to="/global/settings" class="btn btn--xs btn--ghost">
        thresholds →
      </RouterLink>
    </div>

    <p v-if="alerts.length > 0" class="banner banner--error">
      <span class="led led--unhealthy" />
      <span>{{ alerts.join(' · ') }}</span>
    </p>

    <div class="metrics">
      <div class="metric">
        <div class="metric__k">
          cpu
        </div>
        <div class="metric__v">
          {{ cpuUsed === null ? '—' : `${cpuUsed.toFixed(0)}%` }}
        </div>
        <Sparkline :values="cpuSeries" color="var(--accent)" :width="120" :height="20" :max="100" />
      </div>
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

    <div class="hostvitals__disks">
      <div class="group__head">
        <span class="group__title">filesystems</span>
        <span class="faint mono">{{ disks.length }} configured path(s)</span>
      </div>
      <div class="tblwrap">
        <table class="tbl">
          <thead>
            <tr>
              <th class="tbl__keep">
                path
              </th>
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
              <td class="id tbl__keep">
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
          no disk paths configured — add them under global settings → host vitals
        </p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.hostvitals__disks {
  padding: 0.5rem 0.75rem 0.75rem;
}
</style>
