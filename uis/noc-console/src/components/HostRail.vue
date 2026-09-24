<script setup lang="ts">
import { computed } from 'vue'
import { useControlPlane } from '@/composables/useControlPlane'
import { clamp, loadPerCpu } from '@/lib/format'

const control = useControlPlane()

const view = computed(() => control.host.value)
const enabled = computed(() => view.value?.enabled === true)
const alerts = computed(() => view.value?.alerts ?? [])
const disks = computed(() => view.value?.disks ?? [])
const controlUrl = computed(() => control.control.value?.url ?? '')
const exposed = computed(() => control.control.value?.auth.exposed === true)

function band(value: number, warn: number, danger: number): 'ok' | 'warn' | 'danger' {
  if (value >= danger)
    return 'danger'
  if (value >= warn)
    return 'warn'
  return 'ok'
}

function barClass(tone: 'ok' | 'warn' | 'danger'): string {
  return tone === 'ok' ? '' : `rail__bar--${tone}`
}

const loadRatio = computed(() => loadPerCpu(view.value?.loadAvg ?? [], view.value?.cpus ?? 1))
const loadTone = computed(() => (loadRatio.value >= 1 ? 'danger' : loadRatio.value >= 0.7 ? 'warn' : 'ok'))
const memTone = computed(() => band(view.value?.memoryUsedPercent ?? 0, 70, 90))
const swapTone = computed(() => band(view.value?.swapUsedPercent ?? 0, 50, 80))
const tempTone = computed(() => band(view.value?.tempCelsius ?? 0, 70, 85))

function diskTone(percent: number): 'ok' | 'warn' | 'danger' {
  return band(percent, 75, 90)
}

function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}
</script>

<template>
  <header class="rail">
    <template v-if="enabled">
      <div class="rail__cell" title="1-minute load average per cpu">
        <span class="rail__label">load <span class="faint">/{{ view?.cpus }}c</span></span>
        <span class="rail__value">{{ loadRatio.toFixed(2) }}</span>
        <span class="rail__bar" :class="barClass(loadTone)">
          <i :style="{ width: `${clamp(loadRatio * 100, 0, 100)}%` }" />
        </span>
      </div>

      <div class="rail__cell" title="memory used">
        <span class="rail__label">mem</span>
        <span class="rail__value">{{ (view?.memoryUsedPercent ?? 0).toFixed(0) }}%</span>
        <span class="rail__bar" :class="barClass(memTone)">
          <i :style="{ width: `${clamp(view?.memoryUsedPercent ?? 0, 0, 100)}%` }" />
        </span>
      </div>

      <div class="rail__cell" title="swap used">
        <span class="rail__label">swap</span>
        <span class="rail__value">{{ (view?.swapUsedPercent ?? 0).toFixed(0) }}%</span>
        <span class="rail__bar" :class="barClass(swapTone)">
          <i :style="{ width: `${clamp(view?.swapUsedPercent ?? 0, 0, 100)}%` }" />
        </span>
      </div>

      <div v-for="disk in disks" :key="disk.path" class="rail__cell" :title="disk.path">
        <span class="rail__label truncate">disk <span class="faint">{{ shortPath(disk.path) }}</span></span>
        <span class="rail__value">{{ disk.usedPercent.toFixed(0) }}%</span>
        <span class="rail__bar" :class="barClass(diskTone(disk.usedPercent))">
          <i :style="{ width: `${clamp(disk.usedPercent, 0, 100)}%` }" />
        </span>
      </div>

      <div v-if="view?.tempCelsius !== null && view?.tempCelsius !== undefined" class="rail__cell" title="cpu temperature">
        <span class="rail__label">temp</span>
        <span class="rail__value">{{ view.tempCelsius.toFixed(0) }}°C</span>
        <span class="rail__bar" :class="barClass(tempTone)">
          <i :style="{ width: `${clamp(view.tempCelsius, 0, 100)}%` }" />
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
