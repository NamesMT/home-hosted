<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import { cn } from '@/lib/cn'

/**
 * Responsive SVG sparkline. Null values break the line instead of reading as
 * zero, so a stopped process leaves a genuine gap in its own history.
 */
const props = withDefaults(defineProps<{
  values: (number | null)[]
  height?: number
  /** Fixed ceiling (e.g. 100 for CPU). Auto-scales otherwise. */
  max?: number | null
  min?: number | null
  fill?: boolean
  strokeWidth?: number
  color?: string
  class?: string
  interactive?: boolean
}>(), {
  height: 34,
  max: null,
  min: null,
  fill: true,
  strokeWidth: 1.5,
  color: undefined,
  class: undefined,
  interactive: false,
})

const hoverIndex = defineModel<number | null>('hoverIndex', { default: null })

const VIEW_W = 100
const gradientId = useId()
const track = ref<HTMLElement | null>(null)

const domain = computed(() => {
  const present = props.values.filter((value): value is number => value !== null && Number.isFinite(value))
  const top = props.max ?? (present.length > 0 ? Math.max(...present) : 1)
  const bottom = props.min ?? 0
  const ceiling = top === bottom ? bottom + 1 : top
  return { bottom, ceiling }
})

interface Segment {
  line: string
  area: string
}

const segments = computed<Segment[]>(() => {
  const values = props.values
  const { bottom, ceiling } = domain.value
  const span = ceiling - bottom
  const step = values.length > 1 ? VIEW_W / (values.length - 1) : VIEW_W
  const y = (value: number): number => props.height - ((value - bottom) / span) * props.height

  const out: Segment[] = []
  let points: Array<{ x: number, y: number }> = []

  const flush = (): void => {
    if (points.length === 0)
      return
    const line = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ')
    const first = points[0]!
    const last = points[points.length - 1]!
    const area = `${line} L${last.x.toFixed(2)} ${props.height} L${first.x.toFixed(2)} ${props.height} Z`
    out.push({ line, area })
    points = []
  }

  values.forEach((value, index) => {
    if (value === null || !Number.isFinite(value)) {
      flush()
      return
    }
    points.push({ x: index * step, y: y(value) })
  })
  flush()

  return out
})

const hoverX = computed(() => {
  if (hoverIndex.value === null || props.values.length < 2)
    return null
  return (hoverIndex.value / (props.values.length - 1)) * VIEW_W
})

const hoverY = computed(() => {
  const index = hoverIndex.value
  if (index === null)
    return null
  const value = props.values[index]
  if (value === null || value === undefined || !Number.isFinite(value))
    return null
  const { bottom, ceiling } = domain.value
  return props.height - ((value - bottom) / (ceiling - bottom)) * props.height
})

function onMove(event: MouseEvent): void {
  if (!props.interactive || !track.value || props.values.length === 0)
    return
  const rect = track.value.getBoundingClientRect()
  if (rect.width === 0)
    return
  const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
  hoverIndex.value = Math.round(ratio * (props.values.length - 1))
}

function onLeave(): void {
  hoverIndex.value = null
}
</script>

<template>
  <div
    ref="track"
    :class="cn('relative w-full', props.class)"
    :style="{ height: `${props.height}px` }"
    @mousemove="onMove"
    @mouseleave="onLeave"
  >
    <svg
      :viewBox="`0 0 ${VIEW_W} ${props.height}`"
      preserveAspectRatio="none"
      class="block size-full overflow-visible"
      role="img"
      aria-hidden="true"
    >
      <defs>
        <linearGradient :id="gradientId" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" :stop-color="props.color ?? 'currentColor'" stop-opacity="0.26" />
          <stop offset="100%" :stop-color="props.color ?? 'currentColor'" stop-opacity="0" />
        </linearGradient>
      </defs>
      <template v-for="(segment, index) in segments" :key="index">
        <path v-if="props.fill" :d="segment.area" :fill="`url(#${gradientId})`" stroke="none" />
        <path
          :d="segment.line"
          fill="none"
          :stroke="props.color ?? 'currentColor'"
          :stroke-width="props.strokeWidth"
          stroke-linecap="round"
          stroke-linejoin="round"
          vector-effect="non-scaling-stroke"
        />
      </template>
      <line
        v-if="hoverX !== null"
        :x1="hoverX"
        :x2="hoverX"
        y1="0"
        :y2="props.height"
        :stroke="props.color ?? 'currentColor'"
        stroke-width="1"
        stroke-dasharray="2 2"
        vector-effect="non-scaling-stroke"
        opacity="0.5"
      />
      <circle
        v-if="hoverX !== null && hoverY !== null"
        :cx="hoverX"
        :cy="hoverY"
        r="2"
        :fill="props.color ?? 'currentColor'"
        vector-effect="non-scaling-stroke"
      />
    </svg>
    <div v-if="segments.length === 0" class="absolute inset-x-0 top-1/2 border-t border-dashed border-line" />
  </div>
</template>
