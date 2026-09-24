<script setup lang="ts">
import { cn } from '@/lib/cn'

withDefaults(defineProps<{ class?: string, rounded?: string }>(), {
  class: 'h-4 w-24',
  rounded: 'rounded',
})
</script>

<template>
  <span
    :class="cn('block animate-pulse bg-line-soft', rounded, $props.class)"
    style="animation-duration: 1.4s"
    aria-hidden="true"
  />
</template>
