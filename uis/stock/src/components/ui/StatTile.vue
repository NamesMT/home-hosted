<script setup lang="ts">
import type { Tone } from '@/lib/status'
import { cn } from '@/lib/cn'
import { TONE_TEXT } from '@/lib/status'

withDefaults(defineProps<{
  label: string
  value: string
  hint?: string
  tone?: Tone
  mono?: boolean
}>(), {
  hint: undefined,
  tone: 'neutral',
  mono: true,
})
</script>

<template>
  <div class="min-w-0">
    <p class="truncate text-2xs font-medium text-faint">
      {{ $props.label }}
    </p>
    <p :class="cn('mt-0.5 truncate text-xl font-semibold tracking-tight', $props.mono && 'font-mono tabular-nums', $props.tone === 'neutral' ? 'text-ink' : TONE_TEXT[$props.tone])">
      {{ $props.value }}
    </p>
    <p v-if="$props.hint" class="mt-0.5 truncate text-2xs text-muted">
      {{ $props.hint }}
    </p>
  </div>
</template>
