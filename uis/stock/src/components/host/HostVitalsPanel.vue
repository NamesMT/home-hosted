<script setup lang="ts">
import type { HostView } from '@shared/contracts'
import { Cpu, HardDrive, MemoryStick, Thermometer } from 'lucide-vue-next'
import { computed } from 'vue'
import Gauge from '@/components/telemetry/Gauge.vue'
import Meter from '@/components/telemetry/Meter.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import { formatAgo, formatBytes } from '@/lib/format'

const props = defineProps<{
  host: HostView | null
  now: number
}>()

const loadPerCpu = computed(() => {
  const host = props.host
  if (!host)
    return null
  return (host.loadAvg[0] ?? 0) / Math.max(1, host.cpus)
})

const loadLoads = computed(() => props.host?.loadAvg.map(value => value.toFixed(2)).join('  ') ?? '—')
</script>

<template>
  <EmptyState
    v-if="!props.host || !props.host.enabled"
    compact
    title="Host sampling is off"
    description="Turn it on in Settings to collect load, memory, disk and temperature."
  />

  <div v-else class="space-y-4">
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Gauge
        :value="loadPerCpu === null ? null : (loadPerCpu / 2) * 100"
        label="Load / cpu"
        :display="loadPerCpu === null ? '—' : loadPerCpu.toFixed(2)"
        :size="72"
        :warn-at="70"
        :danger-at="100"
      />
      <Gauge :value="props.host.memoryUsedPercent" label="Memory" :size="72" />
      <Gauge :value="props.host.swapUsedPercent" label="Swap" :size="72" :warn-at="50" />
      <Gauge
        :value="props.host.tempCelsius === null ? null : (props.host.tempCelsius / 85) * 100"
        label="CPU temp"
        :display="props.host.tempCelsius === null ? 'n/a' : `${Math.round(props.host.tempCelsius)}°C`"
        :size="72"
      />
    </div>

    <dl class="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-line-soft pt-3 sm:grid-cols-4">
      <div>
        <dt class="flex items-center gap-1 text-2xs text-faint">
          <Cpu class="size-3" />CPUs
        </dt>
        <dd class="font-mono text-xs text-ink">
          {{ props.host.cpus }}
        </dd>
      </div>
      <div>
        <dt class="text-2xs text-faint">
          Load 1 / 5 / 15
        </dt>
        <dd class="font-mono text-xs tabular-nums text-ink">
          {{ loadLoads }}
        </dd>
      </div>
      <div>
        <dt class="flex items-center gap-1 text-2xs text-faint">
          <MemoryStick class="size-3" />Memory used
        </dt>
        <dd class="font-mono text-xs text-ink">
          {{ props.host.memoryUsedPercent.toFixed(0) }}%
        </dd>
      </div>
      <div>
        <dt class="flex items-center gap-1 text-2xs text-faint">
          <Thermometer class="size-3" />Sampled
        </dt>
        <dd class="font-mono text-xs text-ink">
          {{ formatAgo(props.host.sampledAt, props.now) }}
        </dd>
      </div>
    </dl>

    <div class="space-y-2 border-t border-line-soft pt-3">
      <p class="flex items-center gap-1.5 text-2xs font-medium text-faint">
        <HardDrive class="size-3" />Filesystems
      </p>
      <div v-for="disk in props.host.disks" :key="disk.path" class="space-y-1">
        <div class="flex items-baseline justify-between gap-2">
          <span class="truncate font-mono text-2xs text-muted" :title="disk.path">{{ disk.path }}</span>
          <span class="shrink-0 font-mono text-2xs tabular-nums text-faint">
            {{ formatBytes(disk.totalBytes - disk.freeBytes) }} / {{ formatBytes(disk.totalBytes) }}
            · {{ disk.usedPercent.toFixed(0) }}%
          </span>
        </div>
        <Meter :value="disk.usedPercent" />
      </div>
    </div>

    <div v-if="props.host.alerts.length > 0" class="space-y-1 rounded-control border border-danger/25 bg-danger-soft px-2.5 py-2">
      <p class="text-2xs font-medium text-danger">
        Thresholds breached
      </p>
      <p v-for="alert in props.host.alerts" :key="alert" class="text-2xs text-danger">
        {{ alert }}
      </p>
    </div>
  </div>
</template>
