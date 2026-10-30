<script setup lang="ts">
import { Activity, CircleAlert, Play, Plus, Server as ServerIcon, Timer } from '@lucide/vue'
import { sumReadings } from '@shared/server-readings'
import { computed, ref } from 'vue'
import ActivityFeed from '@/components/server/ActivityFeed.vue'
import AddServerDialog from '@/components/server/AddServerDialog.vue'
import ServerCard from '@/components/server/ServerCard.vue'
import ConfirmButton from '@/components/settings/ConfirmButton.vue'
import AppButton from '@/components/ui/AppButton.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import PageHeader from '@/components/ui/PageHeader.vue'
import Panel from '@/components/ui/Panel.vue'
import Skeleton from '@/components/ui/Skeleton.vue'
import StatTile from '@/components/ui/StatTile.vue'
import { useControlPlane } from '@/composables/useControlPlane'
import { useWorkspaces } from '@/composables/useWorkspaces'
import { t, tc } from '@/i18n'
import { cn } from '@/lib/cn'
import { formatBytesShort, formatDuration } from '@/lib/format'
import { seriesMax } from '@/lib/telemetry'
import { workspacePath } from '@/router'

/**
 * The selected workspace's own overview. Host vitals are panel-wide and live on
 * the Global Overview (`/global`) — this page is only about what this workspace
 * supervises.
 */
const control = useControlPlane()
const workspace = useWorkspaces()

const showAdd = ref(false)

const loading = computed(() => control.appState.value === null)
const servers = workspace.servers
const label = computed(() => workspace.selected.value?.label ?? t('nav.workspace'))

const running = computed(() => servers.value.filter(server => server.status === 'running'))
const stopped = computed(() => servers.value.filter(server => ['stopped', 'stopping'].includes(server.status)))
const attention = computed(() => servers.value.filter(server =>
  server.status === 'crashed' || server.status === 'conflict' || server.health === 'unhealthy'))

const totalRss = computed(() => sumReadings(running.value, 'rssBytes'))

const peakRss = computed(() => {
  let peak = 0
  for (const server of servers.value) {
    const value = seriesMax(workspace.seriesOf(server.id).rss)
    if (value > peak)
      peak = value
  }
  return peak
})

/** Live CPU across this workspace's running servers, or nothing until every one has a sample. */
const liveCpu = computed(() => sumReadings(running.value, 'cpuPercent'))

const uptime = computed(() => {
  const started = servers.value
    .map(server => server.startedAt)
    .filter((value): value is number => typeof value === 'number')
  if (started.length === 0)
    return '—'
  return formatDuration(control.now.value - Math.min(...started))
})
</script>

<template>
  <div class="mx-auto max-w-7xl space-y-5 p-4 sm:p-5">
    <PageHeader
      :title="label"
      :description="t('views.overview.description')"
    >
      <template #actions>
        <AppButton variant="ghost" @click="workspace.startAll()">
          <Play class="size-3.5" />{{ t('views.actions.startAll') }}
        </AppButton>
        <ConfirmButton
          :label="t('views.actions.stopAll')"
          :confirm-label="t('views.actions.stopAllIgnore')"
          :alternative-label="t('views.actions.stopAllWithPersistent')"
          :title="t('views.actions.stopAllQuestion')"
          :hint="t('views.actions.stopAllHint')"
          variant="ghost"
          confirm-variant="danger"
          @confirm="workspace.stopAll()"
          @alternative="workspace.stopAll({ withPersistent: true })"
        />
        <AppButton variant="primary" @click="showAdd = true">
          <Plus class="size-3.5" />{{ t('views.actions.addServer') }}
        </AppButton>
      </template>
    </PageHeader>

    <Panel class="p-0">
      <div v-if="loading" class="grid grid-cols-2 gap-4 p-4 sm:grid-cols-3 lg:grid-cols-5">
        <div v-for="index in 5" :key="index" class="space-y-2">
          <Skeleton class="h-2.5 w-16" />
          <Skeleton class="h-6 w-20" />
        </div>
      </div>
      <div v-else class="grid grid-cols-2 divide-line-soft sm:grid-cols-3 sm:divide-x lg:grid-cols-5">
        <div class="p-4">
          <StatTile :label="t('views.overview.running')" :value="`${running.length}/${servers.length}`" tone="ok" :hint="t('views.overview.notUp', { count: servers.length - running.length })" />
        </div>
        <div class="p-4">
          <StatTile :label="t('views.overview.stopped')" :value="String(stopped.length)" :hint="t('views.overview.enabled', { count: servers.filter(s => s.config.enabled).length })" />
        </div>
        <div class="p-4">
          <StatTile
            :label="t('views.overview.needsAttention')"
            :value="String(attention.length)"
            :tone="attention.length > 0 ? 'danger' : 'ok'"
            :hint="attention.length === 0 ? t('views.overview.nothingBroken') : t('views.overview.crashedOrUnhealthy')"
          />
        </div>
        <div class="p-4">
          <StatTile :label="t('views.overview.processMemory')" :value="formatBytesShort(totalRss)" :hint="peakRss > 0 ? t('views.overview.peak', { value: formatBytesShort(peakRss) }) : t('views.overview.acrossTree')" />
        </div>
        <div class="p-4">
          <StatTile
            :label="t('views.overview.longestUptime')"
            :value="uptime"
            :hint="running.length === 0 ? t('views.overview.nothingRunning') : liveCpu === null ? t('metric.emptyHint') : t('views.overview.cpuNow', { value: liveCpu.toFixed(1) })"
          />
        </div>
      </div>
    </Panel>

    <div
      v-if="attention.length > 0"
      class="flex items-start gap-2.5 rounded-panel border border-danger/25 bg-danger-soft px-3.5 py-3"
    >
      <CircleAlert class="mt-0.5 size-4 shrink-0 text-danger" />
      <div class="min-w-0">
        <p class="text-xs font-medium text-danger">
          {{ tc('views.overview.needLook', attention.length) }}
        </p>
        <p class="mt-0.5 flex flex-wrap gap-x-2 text-2xs text-danger">
          <RouterLink
            v-for="server in attention"
            :key="server.id"
            :to="workspacePath(workspace.activeId.value, 'servers', server.id)"
            class="font-mono underline-offset-2 hover:underline"
          >
            {{ server.id }}
          </RouterLink>
        </p>
      </div>
    </div>

    <section class="space-y-3">
      <div class="flex items-center justify-between">
        <h2 class="flex items-center gap-1.5 text-sm font-semibold text-ink">
          <ServerIcon class="size-3.5 text-faint" />
          {{ t('nav.servers') }}
        </h2>
        <RouterLink :to="workspacePath(workspace.activeId.value, 'servers')" class="text-2xs text-muted transition-colors duration-150 hover:text-accent">
          {{ t('views.overview.openFullList') }}
        </RouterLink>
      </div>

      <div v-if="loading" class="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Skeleton v-for="index in 4" :key="index" class="h-64 w-full" rounded="rounded-panel" />
      </div>

      <EmptyState
        v-else-if="servers.length === 0"
        :title="t('views.overview.emptyTitle')"
        :description="t('views.overview.emptyDescription')"
      >
        <template #icon>
          <ServerIcon class="size-4" />
        </template>
        <template #action>
          <AppButton variant="primary" @click="showAdd = true">
            <Plus class="size-3.5" />{{ t('views.actions.addAServer') }}
          </AppButton>
        </template>
      </EmptyState>

      <div v-else class="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ServerCard
          v-for="server in servers"
          :key="server.id"
          :server="server"
          :workspace-id="workspace.activeId.value"
          :series="workspace.seriesOf(server.id)"
          :now="control.now.value"
        />
      </div>
    </section>

    <Panel>
      <template #header>
        <h2 class="flex items-center gap-1.5 text-sm font-semibold text-ink">
          <Activity class="size-3.5 text-faint" />
          {{ t('views.overview.recentActivity') }}
        </h2>
      </template>
      <template #actions>
        <RouterLink :to="workspacePath(workspace.activeId.value, 'logs')" class="text-2xs text-muted transition-colors duration-150 hover:text-accent">
          {{ t('nav.logs') }}
        </RouterLink>
      </template>
      <ActivityFeed :servers="servers" :now="control.now.value" :limit="10" />
    </Panel>

    <p class="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-faint">
      <span class="flex items-center gap-1"><Timer class="size-3" />{{ t('views.overview.sampling') }}</span>
      <span class="font-mono">{{ workspace.selected.value?.configPath }}</span>
      <span :class="cn('flex items-center gap-1')">
        <span class="size-1.5 rounded-full bg-ok" />
        {{ t('views.overview.workspaceLabel', { id: workspace.activeId.value }) }}
      </span>
    </p>

    <AddServerDialog v-model:open="showAdd" :workspace-id="workspace.activeId.value" />
  </div>
</template>
