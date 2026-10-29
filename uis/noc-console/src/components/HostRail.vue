<script setup lang="ts">
import { hostReadings } from '@shared/host-readings'
import { computed } from 'vue'
import { useControlPlane } from '@/composables/useControlPlane'
import { clamp, pct } from '@/lib/format'

const control = useControlPlane()

const view = computed(() => control.host.value)
const enabled = computed(() => view.value?.enabled === true)
const alerts = computed(() => view.value?.alerts ?? [])
/**
 * The rail is on every page, so it is the first place a person meets an unsampled host: the same
 * rule as the vitals page, from the same module. It printed `mem 0% swap 0%` on a panel that had
 * measured nothing — the frame `/api/metrics` already refuses to publish.
 */
const readings = computed(() => hostReadings(view.value))
const disks = computed(() => readings.value.disks)
const controlUrl = computed(() => control.control.value?.url ?? '')
const exposed = computed(() => control.control.value?.auth.exposed === true)

function barClass(tone: 'ok' | 'warn' | 'danger'): string {
  return tone === 'ok' ? '' : `rail__bar--${tone}`
}

const loadRatio = computed(() => readings.value.loadPerCpu)
/**
 * Load is a count of runnable tasks, not a percentage: `1.00` is one core's worth. The rail used to
 * turn red at `1`, which on a 24-core box is 4% and completely normal — and then at a hardcoded `2`
 * whatever the configured threshold was, which painted a box a person had raised to 4 bright red
 * for an alert that could not fire. It reads the shared band, the same verdict as the vitals page.
 */
const loadTone = computed(() => readings.value.loadBand ?? 'ok')
/** The CPU bar shows the real utilisation, so the rail's numbers share one unit. */
const cpuUsed = computed(() => readings.value.cpuUsedPercent)
const cpuTone = computed(() => {
  const value = cpuUsed.value
  if (value === null)
    return 'ok'
  return value >= 90 ? 'danger' : value >= 70 ? 'warn' : 'ok'
})
/**
 * The three percentage bars read the shared band, measured against the threshold the panel
 * **notifies** on — the same rule the load bar follows. They used to carry literals, and the
 * literals disagreed with the alerts: swap fired at 50 while this bar called that `warn`, and a
 * `tempCelsius` raised to 95 left a normal 90 °C box painted `danger`.
 */
const memTone = computed(() => readings.value.memoryBand ?? 'ok')
const swapTone = computed(() => readings.value.swapBand ?? 'ok')
const tempTone = computed(() => readings.value.tempBand ?? 'ok')

function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}
</script>

<template>
  <header class="rail">
    <template v-if="enabled">
      <div class="rail__cell" title="share of this machine's cpu in use over the last interval">
        <span class="rail__label">cpu</span>
        <span class="rail__value" :class="cpuUsed === null ? 'rail__value--dim' : ''">{{ pct(cpuUsed) }}</span>
        <span class="rail__bar" :class="barClass(cpuTone)">
          <i :style="{ width: `${clamp(cpuUsed ?? 0, 0, 100)}%` }" />
        </span>
      </div>

      <div class="rail__cell" title="1-minute load average per cpu — a count, not a percentage">
        <span class="rail__label">load <span class="faint">/{{ view?.cpus }}c</span></span>
        <span class="rail__value" :class="loadRatio === null ? 'rail__value--dim' : ''">{{ loadRatio === null ? '—' : loadRatio.toFixed(2) }}</span>
        <span class="rail__bar" :class="barClass(loadTone)">
          <i :style="{ width: `${clamp((loadRatio ?? 0) * 50, 0, 100)}%` }" />
        </span>
      </div>

      <div class="rail__cell" title="memory used">
        <span class="rail__label">mem</span>
        <span class="rail__value" :class="readings.memoryUsedPercent === null ? 'rail__value--dim' : ''">{{ pct(readings.memoryUsedPercent) }}</span>
        <span class="rail__bar" :class="barClass(memTone)">
          <i :style="{ width: `${clamp(readings.memoryUsedPercent ?? 0, 0, 100)}%` }" />
        </span>
      </div>

      <div class="rail__cell" title="swap used">
        <span class="rail__label">swap</span>
        <span class="rail__value" :class="readings.swapUsedPercent === null ? 'rail__value--dim' : ''">{{ pct(readings.swapUsedPercent) }}</span>
        <span class="rail__bar" :class="barClass(swapTone)">
          <i :style="{ width: `${clamp(readings.swapUsedPercent ?? 0, 0, 100)}%` }" />
        </span>
      </div>

      <div v-for="disk in disks" :key="disk.path" class="rail__cell" :title="disk.path">
        <span class="rail__label truncate">disk <span class="faint">{{ shortPath(disk.path) }}</span></span>
        <span class="rail__value">{{ disk.usedPercent.toFixed(0) }}%</span>
        <span class="rail__bar" :class="barClass(disk.band ?? 'ok')">
          <i :style="{ width: `${clamp(disk.usedPercent, 0, 100)}%` }" />
        </span>
      </div>

      <div v-if="readings.tempCelsius !== null" class="rail__cell" title="cpu temperature">
        <span class="rail__label">temp</span>
        <span class="rail__value">{{ readings.tempCelsius.toFixed(0) }}°C</span>
        <span class="rail__bar" :class="barClass(tempTone)">
          <i :style="{ width: `${clamp(readings.tempCelsius, 0, 100)}%` }" />
        </span>
      </div>
    </template>

    <div v-else class="rail__cell">
      <span class="rail__label">host</span>
      <span class="rail__value rail__value--dim">sampling off</span>
    </div>

    <div v-if="alerts.length > 0" class="rail__alerts" :title="alerts.join(' · ')">
      <span class="led led--unhealthy" />
      {{ alerts.join(' · ') }}
    </div>

    <span class="rail__spacer" />

    <span v-if="exposed" class="rail__cell">
      <span class="rail__label">exposure</span>
      <span class="rail__value rail__value--warn">beyond loopback</span>
    </span>

    <a v-if="controlUrl" class="rail__link" :href="controlUrl" target="_blank" rel="noreferrer">
      <span class="led led--open" />
      {{ controlUrl }}
    </a>
  </header>
</template>
