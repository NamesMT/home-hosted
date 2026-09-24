<script setup lang="ts">
import type { ServerStatus } from '@shared/contracts'

defineProps<{ status: ServerStatus }>()

const labels: Record<ServerStatus, string> = {
  stopped: 'stopped',
  starting: 'starting',
  running: 'running',
  stopping: 'stopping',
  backoff: 'backoff',
  crashed: 'crashed',
  conflict: 'conflict',
}
</script>

<template>
  <span class="chip" :class="`chip--${status}`">{{ labels[status] }}</span>
</template>
