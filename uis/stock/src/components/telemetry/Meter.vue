<script setup lang="ts">
import type { Tone } from '@/lib/status'
import { computed } from 'vue'
import { cn } from '@/lib/cn'

const props = withDefaults(defineProps<{
  value: number | null
  /** Where the fill changes colour, in percent. */
  warnAt?: number
  dangerAt?: number
  height?: string
  class?: string
}>(), {
  warnAt: 75,
  dangerAt: 90,
  height: 'h-1.5',
  class: undefined,
})

const clamped = computed(() => (props.value === null || !Number.isFinite(props.value) ? 0 : Math.min(100, Math.max(0, props.value))))

const tone = computed<Tone>(() => {
  if (props.value === null)
    return 'neutral'
  if (props.value >= props.dangerAt)
    return 'danger'
  if (props.value >= props.warnAt)
    return 'warn'
  return 'ok'
})

const FILL: Record<Tone, string> = {
  ok: 'bg-ok/80',
  warn: 'bg-warn/85',
  danger: 'bg-danger/85',
  info: 'bg-info/80',
  neutral: 'bg-faint/60',
  accent: 'bg-accent/80',
}
</script>

<template>
  <div :class="cn('w-full overflow-hidden rounded-full bg-line-soft', props.height, props.class)">
    <div
      :class="cn('h-full rounded-full transition-[width] duration-300 ease-out', FILL[tone])"
      :style="{ width: `${clamped}%` }"
    />
  </div>
</template>
