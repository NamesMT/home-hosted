<script setup lang="ts">
import type { HostView } from '@shared/contracts'
import type { HostBand } from '@shared/host-readings'
import type { Tone } from '@/lib/status'
import { Cpu, HardDrive, MemoryStick, Thermometer } from '@lucide/vue'
import { hostReadings, tempDialPercent } from '@shared/host-readings'
import { computed } from 'vue'
import Gauge from '@/components/telemetry/Gauge.vue'
import Meter from '@/components/telemetry/Meter.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import { t } from '@/i18n'
import { formatAgo, formatBytes } from '@/lib/format'

const props = defineProps<{
  host: HostView | null
  now: number
}>()

/**
 * A panel that is on but has not sampled yet (or one whose sampler is slow) carries the same
 * all-zero frame as `emptyHostView()`; this decides "no reading" once, for both UIs.
 */
const readings = computed(() => hostReadings(props.host))

/**
 * Load is a **count of runnable tasks**, not a percentage, so it is shown as a number and never
 * as a dial: `1.00` means "one core's worth of work waiting", and on 24 cores that is 4% busy.
 * Rendering it in a dial next to the memory percentage read as "0% CPU" while the machine was
 * actually working — which is the confusion this panel used to cause.
 */
const loadLoads = computed(() => {
  const { load1m, load5m, load15m } = readings.value
  if (load1m === null || load5m === null || load15m === null)
    return '—'
  return [load1m, load5m, load15m].map(value => value.toFixed(2)).join('  ')
})

/** The real percentage: share of the machine's total CPU capacity used since the last sample. */
const cpuUsed = computed(() => readings.value.cpuUsedPercent)

/**
 * Every dial's colour is the panel's own verdict, never a literal pair.
 *
 * `Gauge` defaults to `75`/`90`, and this panel used to hand it its own `:warn-at="50"` for swap
 * and scale the temperature dial by `85`. Those are `hostSchema`'s *defaults*, so the copy is
 * invisible on a fresh config and wrong on any other: with `host.tempCelsius` at 95 a 90 °C box
 * stayed `danger`, and 92% memory against a threshold raised to 95 was painted `danger` for a
 * notification that could never arrive. `hostReadings` decides the band against the threshold the
 * frame carries, so the dial reads it.
 */
function toneClass(band: HostBand): Tone {
  // An absent reading is dim, not green: `0%` on an unsampled frame is not a healthy zero.
  return band ?? 'neutral'
}

/**
 * The temperature dial's fill: a share of the threshold the panel notifies on.
 *
 * It used to be `(tempCelsius / 85) * 100` in the template — `hostSchema`'s *default*, so the copy
 * was invisible on a fresh config and wrong on any other. The neighbouring `InstrumentCluster`
 * scaled by `tempCelsiusAlert`, so with the threshold raised to 95 the two surfaces drew one
 * 60 °C reading at different arc lengths. `tempDialPercent` decides it once, for both.
 */
const tempDial = computed(() => tempDialPercent(readings.value.tempCelsius, props.host?.tempCelsiusAlert))

const memoryTone = computed(() => toneClass(readings.value.memoryBand))
const swapTone = computed(() => toneClass(readings.value.swapBand))
const tempTone = computed(() => toneClass(readings.value.tempBand))
</script>

<template>
  <EmptyState
    v-if="!props.host || !props.host.enabled"
    compact
    :title="t('host.samplingOff')"
    :description="t('host.samplingOffDescription')"
  />

  <div v-else class="space-y-4">
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Gauge
        :value="cpuUsed"
        :label="t('host.cpuUsage')"
        :size="72"
        :warn-at="80"
        :danger-at="95"
      />
      <Gauge :value="readings.memoryUsedPercent" :label="t('common.memory')" :size="72" :tone="memoryTone" />
      <Gauge :value="readings.swapUsedPercent" :label="t('host.swap')" :size="72" :tone="swapTone" />
      <Gauge
        :value="tempDial"
        :label="t('host.cpuTemp')"
        :display="readings.tempCelsius === null ? t('common.notAvailable') : `${Math.round(readings.tempCelsius)}°C`"
        :size="72"
        :tone="tempTone"
      />
    </div>

    <dl class="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-line-soft pt-3 sm:grid-cols-4">
      <div>
        <dt class="flex items-center gap-1 text-2xs text-faint">
          <Cpu class="size-3" />{{ t('host.cpus') }}
        </dt>
        <dd class="font-mono text-xs text-ink">
          {{ props.host.cpus }}
        </dd>
      </div>
      <div>
        <dt class="text-2xs text-faint" :title="t('host.loadHint')">
          {{ t('host.loadAverage') }}
        </dt>
        <dd class="font-mono text-xs tabular-nums text-ink">
          {{ loadLoads }}
        </dd>
        <dd class="font-mono text-2xs tabular-nums text-faint">
          {{ readings.loadPerCpu === null ? '—' : `${readings.loadPerCpu.toFixed(2)} ${t('host.perCpu')}` }}
        </dd>
      </div>
      <div>
        <dt class="flex items-center gap-1 text-2xs text-faint">
          <MemoryStick class="size-3" />{{ t('host.memoryUsed') }}
        </dt>
        <dd class="font-mono text-xs text-ink">
          {{ readings.memoryUsedPercent === null ? '—' : `${readings.memoryUsedPercent.toFixed(0)}%` }}
        </dd>
      </div>
      <div>
        <dt class="flex items-center gap-1 text-2xs text-faint">
          <Thermometer class="size-3" />{{ t('host.sampled') }}
        </dt>
        <dd class="font-mono text-xs text-ink">
          {{ formatAgo(props.host.sampledAt, props.now) }}
        </dd>
      </div>
    </dl>

    <div class="space-y-2 border-t border-line-soft pt-3">
      <p class="flex items-center gap-1.5 text-2xs font-medium text-faint">
        <HardDrive class="size-3" />{{ t('host.filesystems') }}
      </p>
      <div v-for="disk in readings.disks" :key="disk.path" class="space-y-1">
        <div class="flex items-baseline justify-between gap-2">
          <span class="truncate font-mono text-2xs text-muted" :title="disk.path">{{ disk.path }}</span>
          <span class="shrink-0 font-mono text-2xs tabular-nums text-faint">
            {{ formatBytes(disk.totalBytes - disk.freeBytes) }} / {{ formatBytes(disk.totalBytes) }}
            · {{ disk.usedPercent.toFixed(0) }}%
          </span>
        </div>
        <Meter :value="disk.usedPercent" :tone="disk.band ?? 'neutral'" />
      </div>
    </div>

    <div v-if="props.host.alerts.length > 0" class="space-y-1 rounded-control border border-danger/25 bg-danger-soft px-2.5 py-2">
      <p class="text-2xs font-medium text-danger">
        {{ t('host.thresholdsBreached') }}
      </p>
      <p v-for="alert in props.host.alerts" :key="alert" class="text-2xs text-danger">
        {{ alert }}
      </p>
    </div>
  </div>
</template>
