<script setup lang="ts">
import { computed, ref } from 'vue'
import Sparkline from '@/components/telemetry/Sparkline.vue'
import { cn } from '@/lib/cn'
import { seriesLast } from '@/lib/telemetry'

const props = withDefaults(defineProps<{
  label: string
  values: (number | null)[]
  format: (value: number | null) => string
  max?: number | null
  /** Tailwind text colour class; the sparkline inherits `currentColor`. */
  colorClass?: string
  height?: number
  /** Seconds between samples, used for the hover time offset. */
  sampleMs?: number
  emptyHint?: string
}>(), {
  max: null,
  colorClass: 'text-accent',
  height: 30,
  sampleMs: 5000,
  emptyHint: 'collecting…',
})

const hoverIndex = ref<number | null>(null)

const latest = computed(() => seriesLast(props.values))
const hasData = computed(() => props.values.some(value => value !== null))

const shown = computed(() => {
  const index = hoverIndex.value
  if (index !== null && props.values[index] !== undefined)
    return props.values[index] ?? null
  return latest.value
})

const offset = computed(() => {
  const index = hoverIndex.value
  if (index === null)
    return null
  const fromEnd = props.values.length - 1 - index
  if (fromEnd <= 0)
    return null
  const seconds = Math.round((fromEnd * props.sampleMs) / 1000)
  return seconds < 60 ? `−${seconds}s` : `−${Math.round(seconds / 60)}m`
})
</script>

<template>
  <div class="min-w-0">
    <div class="flex items-baseline justify-between gap-2">
      <span class="truncate text-2xs font-medium text-faint">{{ props.label }}</span>
      <span class="flex shrink-0 items-baseline gap-1.5">
        <span v-if="offset" class="font-mono text-2xs text-faint">{{ offset }}</span>
        <span :class="cn('font-mono text-xs font-medium tabular-nums', hasData ? 'text-ink' : 'text-faint')">
          {{ hasData ? props.format(shown) : props.emptyHint }}
        </span>
      </span>
    </div>
    <Sparkline
      v-model:hover-index="hoverIndex"
      :values="props.values"
      :height="props.height"
      :max="props.max"
      interactive
      :class="cn('mt-1', props.colorClass)"
    />
  </div>
</template>
