<script setup lang="ts">
import type { HistoryEvent, ServerView } from '@shared/contracts'
import type { HistoryType } from '@/lib/status'
import { CircleAlert, CircleCheck, Play, RotateCw, Square, TriangleAlert } from '@lucide/vue'
import { computed } from 'vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import { useWorkspaces } from '@/composables/useWorkspaces'
import { t } from '@/i18n'
import { cn } from '@/lib/cn'
import { formatAgo, formatDuration } from '@/lib/format'
import { HISTORY_TYPE_LABEL_KEY, HISTORY_TYPE_TONE, TONE_TEXT } from '@/lib/status'
import { workspacePath } from '@/router'

const props = withDefaults(defineProps<{
  servers: ServerView[]
  now: number
  limit?: number
  serverId?: string
  /**
   * Prefix each row with its workspace, for a feed that spans several.
   *
   * The label alone does not identify a server: ids and labels repeat across workspaces, so the
   * Global Overview rendered two identical `crashy` rows — one per workspace — and a person reading
   * the feed could not tell which entry had crashed, or which page a row would open. A feed scoped
   * to one workspace (the Overview, a detail page) leaves this off: there, the prefix is noise.
   */
  qualify?: boolean
}>(), {
  limit: 12,
  serverId: undefined,
  qualify: false,
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
  /** The workspace the event's server belongs to; a detail page lives under it. */
  workspaceId: string
  /** The workspace's human name, shown before the server when the feed spans several. */
  workspaceLabel: string
}

const workspaces = useWorkspaces()

/** The workspace's own name, falling back to its id for a frame that carries no label. */
function workspaceLabel(id: string): string {
  return workspaces.workspaces.value.find(workspace => workspace.id === id)?.label ?? id
}

const rows = computed<Row[]>(() => {
  const out: Row[] = []
  for (const server of props.servers) {
    if (props.serverId !== undefined && server.id !== props.serverId)
      continue
    const workspaceId = server.workspaceId ?? ''
    for (const event of server.history.events)
      // The frame carries each server's workspace, so a row links to the page that exists.
      out.push({ ...event, label: server.config.label ?? server.id, workspaceId, workspaceLabel: workspaceLabel(workspaceId) })
  }
  return out.sort((a, b) => b.ts - a.ts).slice(0, props.limit)
})
</script>

<template>
  <EmptyState
    v-if="rows.length === 0"
    compact
    :title="t('activity.emptyTitle')"
    :description="t('activity.emptyDescription')"
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
          <span class="truncate text-xs font-medium text-ink">{{ t(HISTORY_TYPE_LABEL_KEY[row.type as HistoryType]) }}</span>
          <RouterLink :to="workspacePath(row.workspaceId, 'servers', row.serverId)" class="truncate text-2xs text-muted hover:text-accent" :title="props.qualify ? `${row.workspaceLabel}/${row.label}` : row.label">
            <span v-if="props.qualify" class="text-faint">{{ row.workspaceLabel }}/</span>{{ row.label }}
          </RouterLink>
        </p>
        <p class="mt-0.5 truncate font-mono text-2xs text-faint" :title="row.detail">
          {{ row.detail }}
          <span v-if="row.runtimeMs !== undefined" class="text-muted"> · {{ t('activity.ran', { duration: formatDuration(row.runtimeMs) }) }}</span>
        </p>
      </div>
      <span class="shrink-0 pt-0.5 text-2xs text-faint">{{ formatAgo(row.ts, props.now) }}</span>
    </li>
  </ol>
</template>
