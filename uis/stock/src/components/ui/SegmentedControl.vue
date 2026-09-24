<script setup lang="ts">
import { cn } from '@/lib/cn'

const props = withDefaults(defineProps<{
  options: Array<{ value: string, label: string }>
  size?: 'sm' | 'md'
}>(), {
  size: 'sm',
})

const model = defineModel<string>({ default: '' })
</script>

<template>
  <div class="inline-flex items-center gap-0.5 rounded-control border border-line bg-panel-2 p-0.5">
    <button
      v-for="option in props.options"
      :key="option.value"
      type="button"
      :class="cn(
        'rounded-[5px] font-medium transition-colors duration-150',
        props.size === 'sm' ? 'h-6 px-2 text-2xs' : 'h-7 px-2.5 text-xs',
        model === option.value
          ? 'bg-raise text-ink shadow-card'
          : 'text-muted hover:text-ink',
      )"
      :aria-pressed="model === option.value"
      @click="model = option.value"
    >
      {{ option.label }}
    </button>
  </div>
</template>
