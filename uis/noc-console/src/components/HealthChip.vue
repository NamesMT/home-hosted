<script setup lang="ts">
import type { HealthState } from '@shared/contracts'

defineProps<{ health: HealthState }>()

/** Partial on purpose: a newer panel may send a state this UI has no label for, shown as it came. */
const labels: Partial<Record<string, string>> & Record<HealthState, string> = {
  disabled: 'off',
  unknown: 'unknown',
  healthy: 'healthy',
  unhealthy: 'unhealthy',
}
</script>

<template>
  <span class="chip" :class="`chip--${health}`">{{ labels[health] ?? health }}</span>
</template>
