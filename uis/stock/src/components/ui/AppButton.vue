<script setup lang="ts">
import { LoaderCircle } from 'lucide-vue-next'
import { computed, useAttrs } from 'vue'
import { cn } from '@/lib/cn'
import { focusRing } from '@/lib/ui'

defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost'
  size?: 'xs' | 'sm' | 'md' | 'icon' | 'icon-sm'
  type?: 'button' | 'submit' | 'reset'
  disabled?: boolean
  loading?: boolean
  block?: boolean
}>(), {
  variant: 'secondary',
  size: 'sm',
  type: 'button',
  disabled: false,
  loading: false,
  block: false,
})

const attrs = useAttrs()

const VARIANTS = {
  'primary': 'bg-accent text-accent-ink border-transparent hover:brightness-110 active:brightness-95 shadow-[inset_0_1px_0_rgb(255_255_255/0.14)]',
  'secondary': 'bg-raise text-ink border-line hover:bg-hover',
  'ghost': 'bg-transparent text-muted border-transparent hover:bg-hover hover:text-ink',
  'danger': 'bg-danger text-white border-transparent hover:brightness-110 active:brightness-95',
  'danger-ghost': 'bg-transparent text-danger border-danger/30 hover:bg-danger-soft',
} as const

const SIZES = {
  'xs': 'h-6 gap-1 px-1.5 text-2xs',
  'sm': 'h-8 gap-1.5 px-2.5 text-xs',
  'md': 'h-9 gap-2 px-3.5 text-sm',
  'icon': 'h-9 w-9 justify-center',
  'icon-sm': 'h-8 w-8 justify-center',
} as const

const classes = computed(() => cn(
  'inline-flex select-none items-center rounded-control border font-medium whitespace-nowrap',
  'transition-[background-color,border-color,color,filter,opacity] duration-150 ease-out',
  'disabled:pointer-events-none disabled:opacity-45',
  VARIANTS[props.variant],
  SIZES[props.size],
  props.block && 'w-full',
  focusRing,
  attrs.class as string | undefined,
))
</script>

<template>
  <button
    v-bind="{ ...attrs, class: undefined }"
    :type="props.type"
    :class="classes"
    :disabled="props.disabled || props.loading"
    :aria-busy="props.loading || undefined"
  >
    <LoaderCircle v-if="props.loading" class="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
    <slot />
  </button>
</template>
