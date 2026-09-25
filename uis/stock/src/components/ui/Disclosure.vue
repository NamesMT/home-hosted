<script setup lang="ts">
import { ChevronRight } from 'lucide-vue-next'

const props = withDefaults(defineProps<{
  title: string
  /** Small print beside the title, saying what is behind the fold. */
  hint?: string
  /** Open on first paint; the reader may fold it back at will. */
  open?: boolean
}>(), {
  hint: undefined,
  open: false,
})
</script>

<template>
  <!-- A native disclosure: keyboard-operable and screen-reader friendly for free. -->
  <details class="group rounded-panel border border-line bg-panel-2/40" :open="props.open">
    <summary
      class="flex cursor-pointer list-none select-none items-center gap-1.5 px-3 py-2 text-xs font-semibold text-ink [&::-webkit-details-marker]:hidden"
    >
      <ChevronRight class="size-3.5 shrink-0 text-muted transition-transform duration-150 group-open:rotate-90" aria-hidden="true" />
      {{ props.title }}
      <span v-if="props.hint" class="ml-1 truncate text-2xs font-normal text-faint">{{ props.hint }}</span>
    </summary>
    <div class="grid gap-3 border-t border-line-soft px-3 py-3">
      <slot />
    </div>
  </details>
</template>
