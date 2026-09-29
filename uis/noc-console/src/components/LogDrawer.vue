<script setup lang="ts">
import type { LogLine } from '@shared/contracts'
import { computed, onScopeDispose, ref, watch } from 'vue'
import LogPane from '@/components/LogPane.vue'
import StatusChip from '@/components/StatusChip.vue'
import { unwatchLogs, useControlPlane, watchLogs } from '@/composables/useControlPlane'
import { useUi } from '@/composables/useUi'

const props = defineProps<{ serverId: string, workspaceId: string }>()

const control = useControlPlane()
const { drawerOpen } = useUi()
const lines = ref<LogLine[]>([])
const server = computed(() => control.serverById(props.workspaceId, props.serverId))

watch(() => [props.workspaceId, props.serverId] as const, ([workspaceId, id], previous) => {
  if (previous !== undefined)
    unwatchLogs(previous[0], previous[1])
  lines.value = watchLogs(workspaceId, id)
}, { immediate: true })

onScopeDispose(() => unwatchLogs(props.workspaceId, props.serverId))
</script>

<template>
  <aside class="drawer">
    <div class="drawer__head">
      <span class="led" :class="`led--${server?.status === 'running' ? 'running' : 'stopped'}`" />
      <span class="accent">{{ serverId }}</span>
      <span class="faint mono">{{ workspaceId }}</span>
      <StatusChip v-if="server" :status="server.status" />
      <span class="faint">{{ lines.length }} ln</span>
      <span class="view__spacer" />
      <button type="button" class="btn btn--xs btn--ghost" title="close (esc)" @click="drawerOpen = false">
        ×
      </button>
    </div>
    <LogPane :lines="lines" live :empty="server?.status === 'running' ? 'waiting for output…' : 'no buffered output'" />
  </aside>
</template>
