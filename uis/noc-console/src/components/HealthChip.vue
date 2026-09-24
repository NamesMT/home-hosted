<script setup lang="ts">
import type { HealthState } from '@shared/contracts'

defineProps<{ health: HealthState }>()

const labels: Record<HealthState, string> = {
  disabled: 'off',
  unknown: 'unknown',
  healthy: 'healthy',
  unhealthy: 'unhealthy',
}
</script>

<template>
  <span class="chip" :class="`chip--${health}`">{{ labels[health] }}</span>
</template>
