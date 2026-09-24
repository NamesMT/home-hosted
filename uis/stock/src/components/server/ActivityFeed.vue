<script setup lang="ts">
import type { HistoryEvent, ServerView } from '@shared/contracts'
import type { HistoryType } from '@/lib/status'
import { CircleAlert, CircleCheck, Play, RotateCw, Square, TriangleAlert } from 'lucide-vue-next'
import { computed } from 'vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import { cn } from '@/lib/cn'
import { formatAgo, formatDuration } from '@/lib/format'
import { HISTORY_TYPE_LABEL, HISTORY_TYPE_TONE, TONE_TEXT } from '@/lib/status'

const props = withDefaults(defineProps<{
  servers: ServerView[]
  now: number
  limit?: number
  serverId?: string
}>(), {
  limit: 12,
  serverId: undefined,
})

const ICONS = {
  'start': Play,
  'exit': Square,
  'crash': CircleAlert,
  'forced-restart': RotateCw,
  'unhealthy': TriangleAlert,
  'recovered': CircleCheck,
} as const

interface Row extends HistoryEvent {
  label: string
}

const rows = computed<Row[]>(() => {
  const out: Row[] = []
  for (const server of props.servers) {
    if (props.serverId !== undefined && server.id !== props.serverId)
      continue
    for (const event of server.history.events)
      out.push({ ...event, label: server.config.label ?? server.id })
  }
  return out.sort((a, b) => b.ts - a.ts).slice(0, props.limit)
})
</script>

<template>
  <EmptyState
    v-if="rows.length === 0"
    compact
    title="No events in the last 24 hours"
    description="Starts, exits, crashes and recoveries show up here as they happen."
  />

  <ol v-else class="flex flex-col">
    <li
      v-for="(row, index) in rows"
      :key="`${row.serverId}-${row.ts}-${index}`"
      class="flex items-start gap-2.5 border-line-soft py-2"
      :class="index > 0 && 'border-t'"
    >
      <component
        :is="ICONS[row.type as HistoryType]"
        :class="cn('mt-0.5 size-3.5 shrink-0', TONE_TEXT[HISTORY_TYPE_TONE[row.type as HistoryType]])"
      />
      <div class="min-w-0 flex-1">
        <p class="flex items-baseline gap-1.5">
          <span class="truncate text-xs font-medium text-ink">{{ HISTORY_TYPE_LABEL[row.type as HistoryType] }}</span>
          <RouterLink :to="`/servers/${row.serverId}`" class="truncate text-2xs text-muted hover:text-accent">
            {{ row.label }}
          </RouterLink>
        </p>
        <p class="mt-0.5 truncate font-mono text-2xs text-faint" :title="row.detail">
          {{ row.detail }}
          <span v-if="row.runtimeMs !== undefined" class="text-muted"> · ran {{ formatDuration(row.runtimeMs) }}</span>
        </p>
      </div>
      <span class="shrink-0 pt-0.5 text-2xs text-faint">{{ formatAgo(row.ts, props.now) }}</span>
    </li>
  </ol>
</template>
