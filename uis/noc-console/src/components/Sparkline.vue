<script setup lang="ts">
import { computed } from 'vue'
import { sparkSegments } from '@/lib/format'

/**
 * A `null` in `values` is a sample where nothing was measured, so the line breaks there instead of
 * dropping to the floor. Drawing a vertex for it made a stopped entry's chart identical to a
 * server honestly reading 0% — the one value `AGENTS.md` forbids a surface to invent.
 */
const props = withDefaults(defineProps<{
  values: (number | null)[]
  width?: number
  height?: number
  color?: string
  max?: number
  fill?: boolean
}>(), { width: 62, height: 14, color: 'var(--accent)', fill: true })

const segments = computed(() => sparkSegments(props.values, props.width, props.height, props.max))
</script>

<template>
  <svg
    class="spark"
    :width="width"
    :height="height"
    :viewBox="`0 0 ${width} ${height}`"
    preserveAspectRatio="none"
    aria-hidden="true"
  >
    <template v-for="(segment, index) in segments" :key="index">
      <polygon v-if="fill" class="spark__fill" :points="segment.area" :fill="color" />
      <polyline class="spark__line" :points="segment.line" :stroke="color" />
    </template>
    <!-- Nothing measured: a dashed baseline, not the flat line at the floor a zero vertex drew. -->
    <line
      v-if="segments.length === 0"
      class="spark__empty"
      x1="0"
      :x2="width"
      :y1="height - 1"
      :y2="height - 1"
      stroke="currentColor"
      stroke-dasharray="2 2"
      opacity="0.5"
    />
  </svg>
</template>
