<script setup lang="ts">
import { computed } from 'vue'
import { clamp } from '@/lib/format'

const props = withDefaults(defineProps<{
  value: number | null
  max?: number
  tone?: 'accent' | 'ok' | 'warn' | 'danger'
  text?: string
  digits?: number
}>(), { max: 100, tone: 'accent', digits: 0 })

const width = computed(() => (props.value === null ? 0 : clamp((props.value / props.max) * 100, 0, 100)))
const label = computed(() => props.text ?? (props.value === null ? '—' : `${props.value.toFixed(props.digits)}%`))
</script>

<template>
  <span class="meter">
    <span class="meter__track">
      <i class="meter__fill" :class="`meter__fill--${tone}`" :style="{ width: `${width}%` }" />
    </span>
    <span class="meter__text">{{ label }}</span>
  </span>
</template>
