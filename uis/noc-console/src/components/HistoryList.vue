<script setup lang="ts">
import type { HistoryEvent } from '@shared/contracts'
import { formatAgo, formatDuration } from '@/lib/format'

defineProps<{ events: HistoryEvent[], now: number }>()

const tone: Record<HistoryEvent['type'], string> = {
  'start': 'ok',
  'exit': 'neutral',
  'crash': 'danger',
  'forced-restart': 'warn',
  'unhealthy': 'warn',
  'recovered': 'ok',
  // A deploy's tone comes from its outcome; the row prints that, so the type is neutral here.
  'deploy': 'neutral',
  // A run's tone is its outcome too (`ok`/`failed`), which the detail line spells out.
  'job-run': 'neutral',
}
</script>

<template>
  <div class="history">
    <p v-if="events.length === 0" class="empty">
      no events in the window yet
    </p>
    <div v-for="(event, index) in events" :key="`${event.ts}-${index}`" class="history__row">
      <span class="history__ts">{{ formatAgo(event.ts, now) }}</span>
      <span class="history__type">
        <span class="chip" :class="`chip--${tone[event.type]}`">{{ event.type }}</span>
      </span>
      <span class="history__detail" :title="event.detail">{{ event.detail }}</span>
      <span v-if="event.runtimeMs !== undefined" class="faint">up {{ formatDuration(event.runtimeMs) }}</span>
    </div>
  </div>
</template>
