<script setup lang="ts">
import { cn } from '@/lib/cn'

/** A surface with a hairline border — the one container used across the app. */
withDefaults(defineProps<{
  padded?: boolean
  class?: string
}>(), {
  padded: true,
})
</script>

<template>
  <section :class="cn('rounded-panel border border-line bg-panel shadow-card', $props.padded && 'p-4', $props.class)">
    <header v-if="$slots.header || $slots.actions" class="mb-3 flex items-start justify-between gap-3">
      <div class="min-w-0">
        <slot name="header" />
      </div>
      <div class="flex shrink-0 items-center gap-1.5">
        <slot name="actions" />
      </div>
    </header>
    <slot />
  </section>
</template>
