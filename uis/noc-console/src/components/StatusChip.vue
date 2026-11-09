<script setup lang="ts">
import type { ServerStatus } from '@shared/contracts'

defineProps<{ status: ServerStatus }>()

/** Partial on purpose: a newer panel may send a status this UI has no label for, shown as it came. */
const labels: Partial<Record<string, string>> & Record<ServerStatus, string> = {
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
  <span class="chip" :class="`chip--${status}`">{{ labels[status] ?? status }}</span>
</template>
