<script setup lang="ts">
import { computed } from 'vue'
import { sparkPoints } from '@/lib/format'

const props = withDefaults(defineProps<{
  values: number[]
  width?: number
  height?: number
  color?: string
  max?: number
  fill?: boolean
}>(), { width: 62, height: 14, color: 'var(--accent)', fill: true })

const points = computed(() => sparkPoints(props.values, props.width, props.height, props.max))
const area = computed(() => (points.value.length === 0
  ? ''
  : `0,${props.height} ${points.value} ${props.width},${props.height}`))
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
    <polygon v-if="fill && area" class="spark__fill" :points="area" :fill="color" />
    <polyline v-if="points" class="spark__line" :points="points" :stroke="color" />
  </svg>
</template>
