<script setup lang="ts">
import { computed } from 'vue'
import { cn } from '@/lib/cn'

const props = withDefaults(defineProps<{
  title: string
  description?: string
  columns?: 1 | 2 | 3
  dense?: boolean
  class?: string
}>(), {
  description: undefined,
  columns: 2,
  dense: false,
  class: undefined,
})

const grid = computed(() => ({
  1: 'grid-cols-1',
  2: 'grid-cols-1 sm:grid-cols-2',
  3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
}[props.columns]))
</script>

<template>
  <section :class="cn('rounded-panel border border-line bg-panel-2/40', props.dense ? 'p-3' : 'p-3.5', props.class)">
    <!--
      The action row may wrap below the title instead of forcing the title to give way.
      `shrink-0` on an unwrapping row made the row's min-content the sum of every button
      beside the title, so a group with three actions took the width and the heading was
      squeezed. Measured in Chromium at 320 px: "Interface" sat in a **5 px** box holding
      51 px of text, and its description spilled to **304 px** tall at 5 px wide (one word
      per line); "Destinations" was 24 px beside 222 px of actions. Same shape as
      `PageHeader`, which was fixed this way. Wrapping is a no-op where the row fits, so
      the desktop row is unchanged.
    -->
    <header class="mb-3 flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0">
        <h3 class="text-xs font-semibold text-ink">
          {{ props.title }}
        </h3>
        <p v-if="props.description" class="mt-0.5 text-2xs leading-4 text-muted">
          {{ props.description }}
        </p>
      </div>
      <div class="flex min-w-0 flex-wrap items-center gap-2">
        <slot name="actions" />
      </div>
    </header>
    <div :class="cn('grid gap-3', grid)">
      <slot />
    </div>
  </section>
</template>
