<script setup lang="ts">
import { Play, Plus, Search, Server as ServerIcon, Square, X } from 'lucide-vue-next'
import { computed, ref } from 'vue'
import AddServerDialog from '@/components/server/AddServerDialog.vue'
import ServerCard from '@/components/server/ServerCard.vue'
import AppButton from '@/components/ui/AppButton.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import PageHeader from '@/components/ui/PageHeader.vue'
import SegmentedControl from '@/components/ui/SegmentedControl.vue'
import Skeleton from '@/components/ui/Skeleton.vue'
import { useControlPlane } from '@/composables/useControlPlane'
import { inputClass } from '@/lib/ui'

const { servers, appState, now, seriesOf, startAll, stopAll } = useControlPlane()

const showAdd = ref(false)
const query = ref('')
const filter = ref('all')

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'running', label: 'Running' },
  { value: 'stopped', label: 'Stopped' },
  { value: 'attention', label: 'Attention' },
  { value: 'disabled', label: 'Disabled' },
]

const loading = computed(() => appState.value === null)

const visible = computed(() => {
  const needle = query.value.trim().toLowerCase()
  return servers.value.filter((server) => {
    if (filter.value === 'running' && server.status !== 'running')
      return false
    if (filter.value === 'stopped' && !['stopped', 'stopping'].includes(server.status))
      return false
    if (filter.value === 'disabled' && server.config.enabled)
      return false
    if (filter.value === 'attention'
      && !(server.status === 'crashed' || server.status === 'conflict' || server.health === 'unhealthy')) {
      return false
    }
    if (needle.length === 0)
      return true
    const haystack = `${server.id} ${server.config.label ?? ''} ${server.config.command} ${server.config.port ?? ''}`.toLowerCase()
    return haystack.includes(needle)
  })
})

const counts = computed(() => ({
  all: servers.value.length,
  running: servers.value.filter(server => server.status === 'running').length,
  attention: servers.value.filter(server =>
    server.status === 'crashed' || server.status === 'conflict' || server.health === 'unhealthy').length,
}))
</script>

<template>
  <div class="mx-auto max-w-7xl space-y-5 p-4 sm:p-5">
    <PageHeader
      title="Servers"
      description="Every entry in servers.config.json, with live resources, health and history."
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

    <div class="flex flex-wrap items-center gap-2">
      <SegmentedControl
        v-model="filter"
        :options="FILTERS.map(option => ({ ...option, label: `${option.label}${option.value === 'all' ? ` ${counts.all}` : option.value === 'running' ? ` ${counts.running}` : option.value === 'attention' && counts.attention > 0 ? ` ${counts.attention}` : ''}` }))"
      />
      <div class="relative ml-auto w-full sm:w-64">
        <Search class="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
        <input
          v-model="query"
          type="search"
          placeholder="Filter by id, label, command or port"
          class="pl-8" :class="[inputClass]"
          aria-label="Filter servers"
        >
        <button
          v-if="query.length > 0"
          type="button"
          class="absolute right-1.5 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-control text-faint hover:text-ink"
          aria-label="Clear the filter"
          @click="query = ''"
        >
          <X class="size-3.5" />
        </button>
      </div>
    </div>

    <div v-if="loading" class="grid gap-4 lg:grid-cols-2">
      <Skeleton v-for="index in 4" :key="index" class="h-72 w-full" rounded="rounded-panel" />
    </div>

    <EmptyState
      v-else-if="servers.length === 0"
      title="No servers configured"
      description="Add the first process this panel should supervise. Its command, args, env and working directory all live in the config file."
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

    <EmptyState
      v-else-if="visible.length === 0"
      compact
      title="Nothing matches that filter"
      description="Try a different status or clear the search."
    >
      <template #action>
        <AppButton @click="query = ''; filter = 'all'">
          Clear filters
        </AppButton>
      </template>
    </EmptyState>

    <div v-else class="grid gap-4 lg:grid-cols-2">
      <ServerCard
        v-for="server in visible"
        :key="server.id"
        :server="server"
        :series="seriesOf(server.id)"
        :now="now"
      />
    </div>

    <AddServerDialog v-model:open="showAdd" />
  </div>
</template>
