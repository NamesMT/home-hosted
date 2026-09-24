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
  tone?: Tone
  warnAt?: number
  dangerAt?: number
}>(), {
  display: undefined,
  size: 74,
  tone: undefined,
  warnAt: 75,
  dangerAt: 90,
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

const autoTone = computed<Tone>(() => {
  if (props.tone)
    return props.tone
  if (props.value === null || !Number.isFinite(props.value))
    return 'neutral'
  if (props.value >= props.dangerAt)
    return 'danger'
  if (props.value >= props.warnAt)
    return 'warn'
  return 'ok'
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
          :class="STROKE[autoTone]"
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
