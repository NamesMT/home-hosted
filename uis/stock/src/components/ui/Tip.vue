<script setup lang="ts">
import { TooltipContent, TooltipPortal, TooltipRoot, TooltipTrigger } from 'reka-ui'

withDefaults(defineProps<{
  label: string
  side?: 'top' | 'right' | 'bottom' | 'left'
  /** Skip the bubble when the label only repeats visible text. */
  disabled?: boolean
}>(), {
  side: 'top',
  disabled: false,
})
</script>

<template>
  <TooltipRoot :delay-duration="350">
    <TooltipTrigger as-child>
      <slot />
    </TooltipTrigger>
    <TooltipPortal v-if="!disabled">
      <TooltipContent
        :side="side"
        :side-offset="6"
        class="z-50 max-w-64 rounded-control border border-line bg-raise px-2 py-1 text-2xs text-ink shadow-float data-[state=delayed-open]:animate-[hh-fade-in_120ms_ease-out]"
      >
        {{ label }}
      </TooltipContent>
    </TooltipPortal>
  </TooltipRoot>
</template>
