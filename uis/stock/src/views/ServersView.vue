<script setup lang="ts">
import { Play, Plus, Search, Server as ServerIcon, Square, X } from '@lucide/vue'
import { computed, ref } from 'vue'
import AddServerDialog from '@/components/server/AddServerDialog.vue'
import ServerCard from '@/components/server/ServerCard.vue'
import Notice from '@/components/settings/Notice.vue'
import AppButton from '@/components/ui/AppButton.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import PageHeader from '@/components/ui/PageHeader.vue'
import SegmentedControl from '@/components/ui/SegmentedControl.vue'
import Skeleton from '@/components/ui/Skeleton.vue'
import { useControlPlane } from '@/composables/useControlPlane'
import { useWorkspaces } from '@/composables/useWorkspaces'
import { t } from '@/i18n'
import { formatDateTime } from '@/lib/format'
import { inputClass } from '@/lib/ui'

const control = useControlPlane()
const workspace = useWorkspaces()
const { servers } = workspace

/** Processes the panel started that no entry owns any more, from the workspace view. */
const orphans = computed(() => workspace.selected.value?.orphans ?? [])

const showAdd = ref(false)
const query = ref('')
const filter = ref('all')

/** The picker renders the words; the value stays the filter key. */
const FILTERS = [
  { value: 'all', labelKey: 'views.servers.filterAll' },
  { value: 'running', labelKey: 'views.servers.filterRunning' },
  { value: 'stopped', labelKey: 'views.servers.filterStopped' },
  { value: 'attention', labelKey: 'views.servers.filterAttention' },
  { value: 'disabled', labelKey: 'views.servers.filterDisabled' },
] as const

const loading = computed(() => control.appState.value === null)

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

/** The count rides the label, and only where there is one to show. */
const filterOptions = computed(() => FILTERS.map(option => ({
  value: option.value,
  label: `${t(option.labelKey)}${option.value === 'all'
    ? ` ${counts.value.all}`
    : option.value === 'running'
      ? ` ${counts.value.running}`
      : option.value === 'attention' && counts.value.attention > 0
        ? ` ${counts.value.attention}`
        : ''}`,
})))
</script>

<template>
  <div class="mx-auto max-w-7xl space-y-5 p-4 sm:p-5">
    <PageHeader
      :title="t('nav.servers')"
      :description="t('views.servers.description', { workspace: workspace.selected.value?.label ?? t('nav.workspace') })"
    >
      <template #actions>
        <AppButton variant="ghost" @click="workspace.startAll()">
          <Play class="size-3.5" />{{ t('views.actions.startAll') }}
        </AppButton>
        <AppButton variant="ghost" @click="workspace.stopAll()">
          <Square class="size-3.5" />{{ t('views.actions.stopAll') }}
        </AppButton>
        <AppButton variant="primary" @click="showAdd = true">
          <Plus class="size-3.5" />{{ t('views.actions.addServer') }}
        </AppButton>
      </template>
    </PageHeader>

    <div class="flex flex-wrap items-center gap-2">
      <SegmentedControl v-model="filter" :options="filterOptions" />
      <div class="relative ml-auto w-full sm:w-64">
        <Search class="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
        <input
          v-model="query"
          type="search"
          :placeholder="t('views.servers.filterPlaceholder')"
          class="pl-8" :class="[inputClass]"
          :aria-label="t('views.servers.filterAria')"
        >
        <button
          v-if="query.length > 0"
          type="button"
          class="absolute right-1.5 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-control text-faint hover:text-ink"
          :aria-label="t('views.servers.clearFilter')"
          @click="query = ''"
        >
          <X class="size-3.5" />
        </button>
      </div>
    </div>

    <!--
      A process the panel started that no entry owns any more. Without this it runs with no card,
      no /healthz line and no CLI action, and the only recovery was `ps` + `kill`.
    -->
    <Notice v-if="orphans.length > 0" tone="warn" :title="t('views.servers.orphansTitle')">
      <p class="mt-0.5">
        {{ t('views.servers.orphansDescription') }}
      </p>
      <ul class="mt-2 space-y-1">
        <li v-for="orphan in orphans" :key="orphan.serverId" class="flex flex-wrap items-center gap-2">
          <code class="rounded-control bg-black/10 px-1.5 py-0.5 font-mono text-2xs dark:bg-white/10">{{ orphan.serverId }}</code>
          <span class="font-mono text-2xs text-muted">pid {{ orphan.pid }}</span>
          <span v-if="orphan.startedAt !== null" class="text-2xs text-faint">{{ t('views.servers.orphanStartedAt', { when: formatDateTime(orphan.startedAt) }) }}</span>
          <AppButton size="xs" variant="ghost" class="ml-auto" @click="control.stopOrphan(workspace.activeId.value, orphan.serverId)">
            {{ t('views.servers.stopOrphan') }}
          </AppButton>
        </li>
      </ul>
    </Notice>

    <div v-if="loading" class="grid gap-4 lg:grid-cols-2">
      <Skeleton v-for="index in 4" :key="index" class="h-72 w-full" rounded="rounded-panel" />
    </div>

    <EmptyState
      v-else-if="servers.length === 0"
      :title="t('views.servers.emptyTitle')"
      :description="t('views.servers.emptyDescription')"
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

    <EmptyState
      v-else-if="visible.length === 0"
      compact
      :title="t('views.servers.noMatchTitle')"
      :description="t('views.servers.noMatchDescription')"
    >
      <template #action>
        <AppButton @click="query = ''; filter = 'all'">
          {{ t('views.servers.clearFilters') }}
        </AppButton>
      </template>
    </EmptyState>

    <div v-else class="grid gap-4 lg:grid-cols-2">
      <ServerCard
        v-for="server in visible"
        :key="server.id"
        :server="server"
        :workspace-id="workspace.activeId.value"
        :series="workspace.seriesOf(server.id)"
        :now="control.now.value"
      />
    </div>

    <AddServerDialog v-model:open="showAdd" :workspace-id="workspace.activeId.value" />
  </div>
</template>
