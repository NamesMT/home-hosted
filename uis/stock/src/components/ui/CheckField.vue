<script setup lang="ts">
import { cn } from '@/lib/cn'
import { hintClass } from '@/lib/ui'

const props = withDefaults(defineProps<{
  label: string
  hint?: string
  disabled?: boolean
  wide?: boolean
}>(), {
  hint: undefined,
  disabled: false,
  wide: false,
})

const model = defineModel<boolean>({ default: false })
</script>

<template>
  <label
    :class="cn(
      'flex cursor-pointer select-none items-start gap-2 rounded-control px-2 py-1.5 text-xs transition-colors duration-150',
      'hover:bg-hover',
      props.disabled && 'cursor-not-allowed opacity-50 hover:bg-transparent',
      props.wide && 'sm:col-span-2',
    )"
  >
    <input
      v-model="model"
      type="checkbox"
      :disabled="props.disabled"
      class="mt-0.5 size-3.5 shrink-0 cursor-pointer appearance-none rounded-[4px] border border-line bg-page checked:border-accent checked:bg-accent checked:bg-[length:9px] checked:bg-center checked:bg-no-repeat checked:[background-image:url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22white%22 stroke-width=%224%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22><path d=%22M20 6 9 17l-5-5%22/></svg>')] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:cursor-not-allowed"
    >
    <span class="min-w-0">
      <span class="text-ink">{{ props.label }}</span>
      <span v-if="props.hint" class="mt-0.5 block" :class="[hintClass]">{{ props.hint }}</span>
      <slot />
    </span>
  </label>
</template>
