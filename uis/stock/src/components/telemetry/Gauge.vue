<script setup lang="ts">
import type { Tone } from '@/lib/status'
import { computed } from 'vue'
import { cn } from '@/lib/cn'

const props = withDefaults(defineProps<{
  /** 0–100. */
  value: number | null
  label: string
  display?: string
  size?: number
  /**
   * The fill's colour, which every caller supplies.
   *
   * There used to be a `warnAt`/`dangerAt` pair here as a fallback, and it went unreachable the
   * moment each host surface was moved onto its own band — a default nobody could hit, reading like
   * the authority on where a dial changes colour. It is also how the disk bar drifted: the alert was
   * 80 while this default said 75/90. A verdict belongs to the surface that has the reading.
   */
  tone: Tone
}>(), {
  display: undefined,
  size: 74,
})

const R = 34
const CIRC = 2 * Math.PI * R
/** 270° sweep, open at the bottom — the classic instrument dial. */
const SWEEP = 0.75

const fraction = computed(() => {
  if (props.value === null || !Number.isFinite(props.value))
    return 0
  return Math.min(1, Math.max(0, props.value / 100)) * SWEEP
})

const STROKE: Record<Tone, string> = {
  ok: 'stroke-ok',
  warn: 'stroke-warn',
  danger: 'stroke-danger',
  info: 'stroke-info',
  neutral: 'stroke-faint',
  accent: 'stroke-accent',
}
</script>

<template>
  <div :class="cn('flex flex-col items-center gap-1')">
    <div class="relative" :style="{ width: `${props.size}px`, height: `${props.size}px` }">
      <svg viewBox="0 0 80 80" class="size-full -rotate-0">
        <circle
          cx="40"
          cy="40"
          :r="R"
          fill="none"
          class="stroke-line-soft"
          :stroke-width="6"
          :stroke-dasharray="`${SWEEP * CIRC} ${CIRC}`"
          transform="rotate(135 40 40)"
          stroke-linecap="round"
        />
        <circle
          cx="40"
          cy="40"
          :r="R"
          fill="none"
          :class="STROKE[props.tone]"
          :stroke-width="6"
          :stroke-dasharray="`${fraction * CIRC} ${CIRC}`"
          transform="rotate(135 40 40)"
          stroke-linecap="round"
          class="transition-[stroke-dasharray] duration-300 ease-out"
        />
      </svg>
      <div class="absolute inset-0 grid place-items-center">
        <span class="font-mono text-sm font-semibold tabular-nums text-ink">{{ props.display ?? (props.value === null ? '—' : `${Math.round(props.value)}%`) }}</span>
      </div>
    </div>
    <span class="text-2xs font-medium text-faint">{{ props.label }}</span>
  </div>
</template>
