<script setup lang="ts">
import { Activity, CircleAlert, Cpu, Play, Plus, Server as ServerIcon, Square, Timer } from 'lucide-vue-next'
import { computed, onMounted, ref } from 'vue'
import HostVitalsPanel from '@/components/host/HostVitalsPanel.vue'
import ActivityFeed from '@/components/server/ActivityFeed.vue'
import AddServerDialog from '@/components/server/AddServerDialog.vue'
import ServerCard from '@/components/server/ServerCard.vue'
import AppButton from '@/components/ui/AppButton.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import PageHeader from '@/components/ui/PageHeader.vue'
import Panel from '@/components/ui/Panel.vue'
import Skeleton from '@/components/ui/Skeleton.vue'
import StatTile from '@/components/ui/StatTile.vue'
import { useControlPlane } from '@/composables/useControlPlane'
import { usePanelHealth } from '@/composables/usePanelHealth'
import { cn } from '@/lib/cn'
import { formatBytesShort, formatDuration } from '@/lib/format'
import { seriesMax } from '@/lib/telemetry'

const { servers, host, now, appState, seriesOf, startAll, stopAll } = useControlPlane()
const panel = usePanelHealth()

const showAdd = ref(false)

const loading = computed(() => appState.value === null)

const running = computed(() => servers.value.filter(server => server.status === 'running'))
const stopped = computed(() => servers.value.filter(server => ['stopped', 'stopping'].includes(server.status)))
const attention = computed(() => servers.value.filter(server =>
  server.status === 'crashed' || server.status === 'conflict' || server.health === 'unhealthy'))

const totalRss = computed(() => {
  let total = 0
  for (const server of running.value) {
    const rss = server.resources?.rssBytes
    if (typeof rss === 'number')
      total += rss
  }
  return total
})

const peakRss = computed(() => {
  let peak = 0
  for (const server of servers.value) {
    const value = seriesMax(seriesOf(server.id).rss)
    if (value > peak)
      peak = value
  }
  return peak
})

const panelUptime = computed(() => (panel.startedAt.value === null ? '—' : formatDuration(now.value - panel.startedAt.value)))
const hostUptime = computed(() => (host.value?.enabled ? formatDuration(host.value.uptimeMs) : '—'))

/** Live CPU across every running server, for the "load now" tile. */
const liveCpu = computed(() => {
  let total = 0
  for (const server of running.value)
    total += server.resources?.cpuPercent ?? 0
  return total
})

onMounted(async () => {
  await panel.refresh()
})
</script>

<template>
  <div class="mx-auto max-w-7xl space-y-5 p-4 sm:p-5">
    <PageHeader
      title="Overview"
      description="Live state of everything this panel supervises, refreshed over a single event stream."
    >
      <template #actions>
        <AppButton variant="ghost" @click="startAll()">
          <Play class="size-3.5" />Start all
        </AppButton>
        <AppButton variant="ghost" @click="stopAll()">
          <Square class="size-3.5" />Stop all
        </AppButton>
        <AppButton variant="primary" @click="showAdd = true">
          <Plus class="size-3.5" />Add server
        </AppButton>
      </template>
    </PageHeader>

    <Panel class="p-0">
      <div v-if="loading" class="grid grid-cols-2 gap-4 p-4 sm:grid-cols-3 lg:grid-cols-6">
        <div v-for="index in 6" :key="index" class="space-y-2">
          <Skeleton class="h-2.5 w-16" />
          <Skeleton class="h-6 w-20" />
        </div>
      </div>
      <div v-else class="grid grid-cols-2 divide-line-soft sm:grid-cols-3 sm:divide-x lg:grid-cols-6">
        <div class="p-4">
          <StatTile label="Running" :value="`${running.length}/${servers.length}`" tone="ok" :hint="`${servers.length - running.length} not up`" />
        </div>
        <div class="p-4">
          <StatTile label="Stopped" :value="String(stopped.length)" :hint="`${servers.filter(s => s.config.enabled).length} enabled`" />
        </div>
        <div class="p-4">
          <StatTile
            label="Needs attention"
            :value="String(attention.length)"
            :tone="attention.length > 0 ? 'danger' : 'ok'"
            :hint="attention.length === 0 ? 'nothing is broken' : 'crashed or unhealthy'"
          />
        </div>
        <div class="p-4">
          <StatTile label="Process memory" :value="formatBytesShort(totalRss)" :hint="peakRss > 0 ? `peak ${formatBytesShort(peakRss)}` : 'across the tree'" />
        </div>
        <div class="p-4">
          <StatTile label="Panel uptime" :value="panelUptime" :hint="panel.status.value === 'degraded' ? 'degraded' : 'serving'" />
        </div>
        <div class="p-4">
          <StatTile
            label="Host uptime"
            :value="hostUptime"
            :hint="host?.enabled ? `${liveCpu.toFixed(1)}% cpu now` : 'sampling off'"
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
          {{ attention.length }} server{{ attention.length === 1 ? '' : 's' }} need a look
        </p>
        <p class="mt-0.5 flex flex-wrap gap-x-2 text-2xs text-danger">
          <RouterLink
            v-for="server in attention"
            :key="server.id"
            :to="`/servers/${server.id}`"
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
          Servers
        </h2>
        <RouterLink to="/servers" class="text-2xs text-muted transition-colors duration-150 hover:text-accent">
          Open the full list
        </RouterLink>
      </div>

      <div v-if="loading" class="grid gap-4 lg:grid-cols-2">
        <Skeleton v-for="index in 4" :key="index" class="h-64 w-full" rounded="rounded-panel" />
      </div>

      <EmptyState
        v-else-if="servers.length === 0"
        title="No servers yet"
        description="Add the first process this panel should keep alive."
      >
        <template #icon>
          <ServerIcon class="size-4" />
        </template>
        <template #action>
          <AppButton variant="primary" @click="showAdd = true">
            <Plus class="size-3.5" />Add a server
          </AppButton>
        </template>
      </EmptyState>

      <div v-else class="grid gap-4 lg:grid-cols-2">
        <ServerCard
          v-for="server in servers"
          :key="server.id"
          :server="server"
          :series="seriesOf(server.id)"
          :now="now"
        />
      </div>
    </section>

    <div class="grid gap-4 lg:grid-cols-3">
      <Panel class="lg:col-span-2">
        <template #header>
          <h2 class="flex items-center gap-1.5 text-sm font-semibold text-ink">
            <Cpu class="size-3.5 text-faint" />
            Host vitals
          </h2>
        </template>
        <HostVitalsPanel :host="host" :now="now" />
      </Panel>

      <Panel>
        <template #header>
          <h2 class="flex items-center gap-1.5 text-sm font-semibold text-ink">
            <Activity class="size-3.5 text-faint" />
            Recent activity
          </h2>
        </template>
        <template #actions>
          <RouterLink to="/logs" class="text-2xs text-muted transition-colors duration-150 hover:text-accent">
            Logs
          </RouterLink>
        </template>
        <ActivityFeed :servers="servers" :now="now" :limit="10" />
      </Panel>
    </div>

    <p class="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-faint">
      <span class="flex items-center gap-1"><Timer class="size-3" />resource history is sampled every 5 s and kept for this session</span>
      <span class="font-mono">{{ appState?.control.url }}</span>
      <span :class="cn('flex items-center gap-1', panel.status.value === 'degraded' && 'text-danger')">
        <span :class="cn('size-1.5 rounded-full', panel.status.value === 'degraded' ? 'bg-danger' : 'bg-ok')" />
        panel {{ panel.status.value }}
      </span>
    </p>

    <AddServerDialog v-model:open="showAdd" />
  </div>
</template>
