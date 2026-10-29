<script setup lang="ts">
import type { HostView } from '@shared/contracts'
import type { Tone } from '@/lib/status'
import { hostReadings, tempDialPercent } from '@shared/host-readings'
import { computed } from 'vue'
import Gauge from '@/components/telemetry/Gauge.vue'
import { t } from '@/i18n'

const props = defineProps<{ host: HostView | null }>()

/**
 * A dial only tells the truth for a share of something. Load is a *count* of runnable tasks —
 * `1.00` means "one core's worth" — so it stays a number, and the dial is the real CPU percentage
 * instead. The old load dial sat near empty on a busy 24-core box, which read as "the panel says
 * 0% while my server says 400%".
 */
/** The cluster is on the sidebar of every page, so the absence rule is the same one both UIs use. */
const readings = computed(() => hostReadings(props.host))
const cpuUsed = computed(() => readings.value.cpuUsedPercent)

const loadDisplay = computed(() => (readings.value.loadPerCpu === null ? '—' : readings.value.loadPerCpu.toFixed(2)))

const diskUsed = computed(() => {
  const disks = readings.value.disks
  if (disks.length === 0)
    return null
  return Math.max(...disks.map(disk => disk.usedPercent))
})

/**
 * The worst band among the configured filesystems.
 *
 * The dial shows the fullest disk, so its colour is the band of that same disk — not a `75`/`90`
 * pair restated here. `Gauge`'s defaults were the schema's *default*, so a person who lowered
 * `host.diskUsedPercent` to 80 got a notification at 82% beside a dial still painted `warn`.
 */
const diskTone = computed<Tone>(() => {
  const bands = readings.value.disks.map(disk => disk.band)
  if (bands.includes('danger'))
    return 'danger'
  if (bands.includes('warn'))
    return 'warn'
  return bands.includes('ok') ? 'ok' : 'neutral'
})

const memoryTone = computed<Tone>(() => readings.value.memoryBand ?? 'neutral')
const tempTone = computed<Tone>(() => readings.value.tempBand ?? 'neutral')

/**
 * The temperature dial's fill: a share of the threshold the panel notifies on.
 *
 * `tempDialPercent` decides the scale for both stock surfaces — this one used to carry its own
 * `TEMP_FULL = 85`, which `HostVitalsPanel` restated as `(tempCelsius / 85) * 100`, so the two
 * disagreed the moment a person changed the alert.
 */
const tempDial = computed(() => tempDialPercent(readings.value.tempCelsius, props.host?.tempCelsiusAlert))

const tempDisplay = computed(() => {
  const temp = readings.value.tempCelsius
  return temp === null ? t('common.notAvailable') : `${Math.round(temp)}°`
})
</script>

<template>
  <div class="rounded-panel border border-line bg-panel-2/70 p-3">
    <div class="mb-2 flex items-center justify-between">
      <span class="text-2xs font-medium text-faint">{{ t('nav.hostVitals') }}</span>
      <span v-if="props.host?.enabled === false" class="text-2xs text-faint">{{ t('host.statusOff') }}</span>
    </div>

    <div v-if="props.host?.enabled" class="grid grid-cols-2 gap-x-1 gap-y-2">
      <Gauge :value="cpuUsed" :label="t('host.cpuUsage')" :size="58" :warn-at="80" :danger-at="95" />
      <Gauge :value="readings.memoryUsedPercent" :label="t('common.memory')" :size="58" :tone="memoryTone" />
      <Gauge :value="diskUsed" :label="t('common.disk')" :size="58" :tone="diskTone" />
      <Gauge :value="tempDial" :label="t('host.cpuTemp')" :display="tempDisplay" :size="58" :tone="tempTone" />
    </div>

    <!-- Load is a count, so it is a number: `1.00` is one core's worth of runnable work. -->
    <p v-if="props.host?.enabled" class="mt-2 flex items-baseline justify-between border-t border-line-soft pt-2 text-2xs">
      <span class="text-faint" :title="t('host.loadHint')">{{ t('host.loadPerCpu') }}</span>
      <span class="font-mono tabular-nums text-ink">{{ loadDisplay }}</span>
    </p>

    <p v-else class="py-3 text-center text-2xs text-faint">
      {{ t('host.samplingOffCompact') }}
    </p>

    <div v-if="props.host && props.host.alerts.length > 0" class="mt-2 flex items-start gap-1.5 rounded-control bg-danger-soft px-2 py-1.5">
      <span class="mt-1 size-1.5 shrink-0 rounded-full bg-danger" />
      <span class="text-2xs leading-4 text-danger">{{ props.host.alerts.join(' · ') }}</span>
    </div>
  </div>
</template>
