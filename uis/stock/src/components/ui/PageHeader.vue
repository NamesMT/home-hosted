<script setup lang="ts">
import { ChevronLeft } from '@lucide/vue'

withDefaults(defineProps<{
  title: string
  description?: string
  backTo?: string
  backLabel?: string
}>(), {
  description: undefined,
  backTo: undefined,
  backLabel: 'Back',
})
</script>

<template>
  <header class="flex flex-wrap items-start justify-between gap-3">
    <div class="min-w-0">
      <RouterLink
        v-if="$props.backTo"
        :to="$props.backTo"
        class="mb-1 inline-flex items-center gap-1 text-2xs text-muted transition-colors duration-150 hover:text-ink"
      >
        <ChevronLeft class="size-3" />
        {{ $props.backLabel }}
      </RouterLink>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <h1 class="text-2xl font-semibold tracking-tight text-ink">
          {{ $props.title }}
        </h1>
        <slot name="badges" />
      </div>
      <p v-if="$props.description" class="mt-1 max-w-2xl text-xs leading-relaxed text-muted">
        {{ $props.description }}
      </p>
    </div>
    <!--
      `shrink-0` on a wrapping row made the row's min-content width the full width of
      its buttons, so on a phone the header could not fit the screen and the last
      action — the "more actions" menu — sat off the right edge. The row may shrink
      and wrap instead; `sm:` keeps the desktop row on one line beside the title.
    -->
    <div class="flex min-w-0 flex-wrap items-center gap-2">
      <slot name="actions" />
    </div>
  </header>
</template>
