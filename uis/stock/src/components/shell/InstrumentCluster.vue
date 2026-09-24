<script setup lang="ts">
import type { HostView } from '@shared/contracts'
import { computed } from 'vue'
import Gauge from '@/components/telemetry/Gauge.vue'

const props = defineProps<{ host: HostView | null }>()

/** Full-scale for the dials: the alert thresholds the settings page defaults to. */
const LOAD_FULL = 2
const TEMP_FULL = 85

const loadPerCpu = computed(() => {
  const host = props.host
  if (!host)
    return null
  return (host.loadAvg[0] ?? 0) / Math.max(1, host.cpus)
})

const loadDial = computed(() => (loadPerCpu.value === null ? null : (loadPerCpu.value / LOAD_FULL) * 100))
const loadDisplay = computed(() => (loadPerCpu.value === null ? '—' : loadPerCpu.value.toFixed(2)))

const diskUsed = computed(() => {
  const disks = props.host?.disks ?? []
  if (disks.length === 0)
    return null
  return Math.max(...disks.map(disk => disk.usedPercent))
})

const tempDial = computed(() => {
  const temp = props.host?.tempCelsius ?? null
  return temp === null ? null : (temp / TEMP_FULL) * 100
})

const tempDisplay = computed(() => {
  const temp = props.host?.tempCelsius ?? null
  return temp === null ? 'n/a' : `${Math.round(temp)}°`
})
</script>

<template>
  <div class="rounded-panel border border-line bg-panel-2/70 p-3">
    <div class="mb-2 flex items-center justify-between">
      <span class="text-2xs font-medium text-faint">Host vitals</span>
      <span v-if="props.host?.enabled === false" class="text-2xs text-faint">off</span>
    </div>

    <div v-if="props.host?.enabled" class="grid grid-cols-2 gap-x-1 gap-y-2">
      <Gauge :value="loadDial" label="Load / cpu" :display="loadDisplay" :size="58" :warn-at="70" :danger-at="100" />
      <Gauge :value="props.host?.memoryUsedPercent ?? null" label="Memory" :size="58" />
      <Gauge :value="diskUsed" label="Disk" :size="58" />
      <Gauge :value="tempDial" label="CPU temp" :display="tempDisplay" :size="58" />
    </div>

    <p v-else class="py-3 text-center text-2xs text-faint">
      Sampling is disabled in Settings.
    </p>

    <div v-if="props.host && props.host.alerts.length > 0" class="mt-2 flex items-start gap-1.5 rounded-control bg-danger-soft px-2 py-1.5">
      <span class="mt-1 size-1.5 shrink-0 rounded-full bg-danger" />
      <span class="text-2xs leading-4 text-danger">{{ props.host.alerts.join(' · ') }}</span>
    </div>
  </div>
</template>
