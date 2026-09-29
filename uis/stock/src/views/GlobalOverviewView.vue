<script setup lang="ts">
import { Activity, CircleAlert, Cpu, Layers, Plus, Server as ServerIcon } from 'lucide-vue-next'
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
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
import { useWorkspaces } from '@/composables/useWorkspaces'
import { formatDuration } from '@/lib/format'
import { workspacePath } from '@/router'

/**
 * Panel-wide overview: host vitals and every server the panel supervises, with
 * each workspace as its own labelled group. The per-workspace page is `/`.
 */
const control = useControlPlane()
const workspace = useWorkspaces()
const panel = usePanelHealth()
const router = useRouter()

const addOpen = ref(false)
const addTarget = ref<string>('')

const loading = computed(() => control.appState.value === null)
const groups = computed(() => control.workspaces.value)
const all = computed(() => control.allServers.value.map(entry => entry.server))

const running = computed(() => all.value.filter(server => server.status === 'running'))
const attention = computed(() => all.value.filter(server =>
  server.status === 'crashed' || server.status === 'conflict' || server.health === 'unhealthy'))

const host = computed(() => control.host.value)
const panelUptime = computed(() => (panel.startedAt.value === null ? '—' : formatDuration(control.now.value - panel.startedAt.value)))
const hostUptime = computed(() => (host.value?.enabled ? formatDuration(host.value.uptimeMs) : '—'))

function openAdd(workspaceId: string): void {
  addTarget.value = workspaceId
  addOpen.value = true
}

function openServer(workspaceId: string, serverId: string): void {
  workspace.select(workspaceId)
  void router.push(workspacePath(workspaceId, 'servers', serverId))
}

onMounted(async () => {
  await panel.refresh()
})
</script>

<template>
  <div class="mx-auto max-w-7xl space-y-5 p-4 sm:p-5">
    <PageHeader
      title="Global Overview"
      description="Host vitals and every server from every workspace, grouped by where it lives."
    />

    <Panel class="p-0">
      <div v-if="loading" class="grid grid-cols-2 gap-4 p-4 sm:grid-cols-3 lg:grid-cols-5">
        <div v-for="index in 5" :key="index" class="space-y-2">
          <Skeleton class="h-2.5 w-16" />
          <Skeleton class="h-6 w-20" />
        </div>
      </div>
      <div v-else class="grid grid-cols-2 divide-line-soft sm:grid-cols-3 sm:divide-x lg:grid-cols-5">
        <div class="p-4">
          <StatTile label="Workspaces" :value="String(groups.length)" :hint="`${all.length} servers in total`" />
        </div>
        <div class="p-4">
          <StatTile label="Running" :value="`${running.length}/${all.length}`" tone="ok" :hint="`${all.length - running.length} not up`" />
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
          <StatTile label="Panel uptime" :value="panelUptime" :hint="panel.status.value === 'degraded' ? 'degraded' : 'serving'" />
        </div>
        <div class="p-4">
          <StatTile label="Host uptime" :value="hostUptime" :hint="host?.enabled ? 'sampling on' : 'sampling off'" />
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
        <p class="mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-2xs text-danger">
          <button
            v-for="entry in control.allServers.value.filter(e => e.server.status === 'crashed' || e.server.status === 'conflict' || e.server.health === 'unhealthy')"
            :key="`${entry.workspace.id}:${entry.server.id}`"
            type="button"
            class="font-mono underline decoration-danger/40 underline-offset-2 hover:decoration-danger"
            @click="openServer(entry.workspace.id, entry.server.id)"
          >
            {{ entry.workspace.label }}/{{ entry.server.id }}
          </button>
        </p>
      </div>
    </div>

    <div class="grid gap-4 lg:grid-cols-3">
      <Panel class="lg:col-span-2">
        <template #header>
          <h2 class="flex items-center gap-1.5 text-sm font-semibold text-ink">
            <Cpu class="size-3.5 text-faint" />
            Host vitals
          </h2>
          <p class="text-2xs text-muted">
            This machine, shared by every workspace.
          </p>
        </template>
        <HostVitalsPanel :host="host" :now="control.now.value" />
      </Panel>

      <Panel>
        <template #header>
          <h2 class="flex items-center gap-1.5 text-sm font-semibold text-ink">
            <Activity class="size-3.5 text-faint" />
            Recent activity
          </h2>
        </template>
        <ActivityFeed :servers="all" :now="control.now.value" :limit="12" />
      </Panel>
    </div>

    <EmptyState
      v-if="!loading && all.length === 0"
      title="No servers anywhere yet"
      description="Pick a workspace in the header and add the first process it should keep alive."
    >
      <template #icon>
        <ServerIcon class="size-4" />
      </template>
    </EmptyState>

    <section v-for="group in groups" :key="group.id" class="space-y-3">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <h2 class="flex items-center gap-1.5 text-sm font-semibold text-ink">
          <Layers class="size-3.5 text-faint" />
          {{ group.label }}
          <span class="font-mono text-2xs font-normal text-faint">{{ group.id }}</span>
        </h2>
        <span class="text-2xs text-muted">{{ group.runningCount }}/{{ group.serverCount }} running</span>
        <div class="ml-auto flex items-center gap-1.5">
          <AppButton size="xs" variant="ghost" @click="openAdd(group.id)">
            <Plus class="size-3" />Add server
          </AppButton>
          <AppButton size="xs" variant="ghost" @click="workspace.select(group.id); router.push(workspacePath(group.id, 'overview'))">
            Open workspace
          </AppButton>
        </div>
      </div>

      <p v-if="group.configError" class="rounded-control border border-danger/25 bg-danger-soft px-3 py-2 text-2xs leading-4 text-danger">
        The config could not be read: {{ group.configError }}
      </p>

      <EmptyState
        v-if="group.servers.length === 0"
        compact
        title="No servers in this workspace"
        description="Add one and it will show up here and on the workspace page."
      >
        <template #action>
          <AppButton size="sm" variant="primary" @click="openAdd(group.id)">
            <Plus class="size-3.5" />Add a server
          </AppButton>
        </template>
      </EmptyState>

      <div v-else class="grid gap-4 lg:grid-cols-2">
        <ServerCard
          v-for="server in group.servers"
          :key="server.id"
          :server="server"
          :workspace-id="group.id"
          :series="control.seriesOf(group.id, server.id)"
          :now="control.now.value"
        />
      </div>
    </section>

    <p class="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-faint">
      <span>resource history is sampled every 5 s and kept for this session</span>
      <span class="font-mono">{{ control.appState.value?.control.url }}</span>
    </p>

    <AddServerDialog v-model:open="addOpen" :workspace-id="addTarget" />
  </div>
</template>
