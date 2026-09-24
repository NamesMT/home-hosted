<script setup lang="ts">
import type { Tone } from '@/lib/status'
import { computed } from 'vue'
import { cn } from '@/lib/cn'
import { TONE_SURFACE } from '@/lib/status'

const props = withDefaults(defineProps<{
  tone?: Tone
  dot?: boolean
  mono?: boolean
  plain?: boolean
}>(), {
  tone: 'neutral',
  dot: false,
  mono: false,
  plain: false,
})

const classes = computed(() => cn(
  'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-2xs font-medium whitespace-nowrap',
  props.plain ? cn('border-transparent bg-transparent', TONE_SURFACE[props.tone].split(' ').filter(c => c.startsWith('text-')).join(' ')) : TONE_SURFACE[props.tone],
  props.mono && 'font-mono',
))
</script>

<template>
  <span :class="classes">
    <span v-if="props.dot" class="size-1.5 shrink-0 rounded-full bg-current" />
    <slot />
  </span>
</template>
