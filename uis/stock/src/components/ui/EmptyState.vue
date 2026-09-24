<script setup lang="ts">
import { cn } from '@/lib/cn'

withDefaults(defineProps<{
  title: string
  description?: string
  compact?: boolean
}>(), {
  description: undefined,
  compact: false,
})
</script>

<template>
  <div :class="cn('flex flex-col items-center justify-center gap-3 text-center', $props.compact ? 'px-4 py-8' : 'px-6 py-14')">
    <div v-if="$slots.icon" class="grid size-10 place-items-center rounded-full border border-line bg-panel-2 text-faint">
      <slot name="icon" />
    </div>
    <div class="max-w-sm space-y-1">
      <p class="text-sm font-medium text-ink">
        {{ $props.title }}
      </p>
      <p v-if="$props.description" class="text-xs leading-relaxed text-muted">
        {{ $props.description }}
      </p>
    </div>
    <div v-if="$slots.action" class="flex items-center gap-2">
      <slot name="action" />
    </div>
  </div>
</template>
