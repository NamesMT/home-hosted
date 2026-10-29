<script setup lang="ts">
import type { Tone } from '@/lib/status'
import { computed } from 'vue'
import { cn } from '@/lib/cn'

const props = withDefaults(defineProps<{
  value: number | null
  /**
   * The fill's colour, which every caller supplies.
   *
   * A host reading is banded against the threshold the panel notifies on, and that decision belongs
   * to `hostReadings`. The `warnAt`/`dangerAt` pair that used to sit here as a fallback was how the
   * disk bar drifted from its alert — and once every surface read the predicate it was a default
   * nothing could reach, reading like the authority on a band.
   */
  tone: Tone
  height?: string
  class?: string
}>(), {
  height: 'h-1.5',
  class: undefined,
})

const clamped = computed(() => (props.value === null || !Number.isFinite(props.value) ? 0 : Math.min(100, Math.max(0, props.value))))

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
      :class="cn('h-full rounded-full transition-[width] duration-300 ease-out', FILL[props.tone])"
      :style="{ width: `${clamped}%` }"
    />
  </div>
</template>
