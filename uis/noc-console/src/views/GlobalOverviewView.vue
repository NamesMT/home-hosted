<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import HealthChip from '@/components/HealthChip.vue'
import HostVitals from '@/components/HostVitals.vue'
import Sparkline from '@/components/Sparkline.vue'
import StatusChip from '@/components/StatusChip.vue'
import { useControlPlane } from '@/composables/useControlPlane'
import { selectedId } from '@/composables/useUi'
import { useWorkspaces } from '@/composables/useWorkspaces'
import { briefBytes, formatRatio, formatUptime } from '@/lib/format'
import { workspacePath } from '@/router'

/**
 * Panel-wide overview: host vitals and every server the panel supervises, with
 * each workspace as its own labelled group. The workspace pages live under
 * `/w/<id>/…`.
 */
const control = useControlPlane()
const workspace = useWorkspaces()
const router = useRouter()

const groups = computed(() => control.workspaces.value)
const all = computed(() => control.allServers.value.map(entry => entry.server))
const running = computed(() => all.value.filter(server => server.status === 'running'))
const attention = computed(() => all.value.filter(server =>
  server.status === 'crashed' || server.status === 'conflict' || server.health === 'unhealthy'))

function openWorkspace(id: string): void {
  workspace.select(id)
  void router.push(workspacePath(id, 'servers'))
}

function openServer(workspaceId: string, serverId: string): void {
  workspace.select(workspaceId)
  selectedId.value = serverId
  void router.push(workspacePath(workspaceId, 'servers'))
}
</script>

<template>
  <div class="view">
    <div class="view__head">
      <span class="view__title">global overview</span>
      <span class="view__count">{{ groups.length }} workspace{{ groups.length === 1 ? '' : 's' }} · {{ all.length }} server{{ all.length === 1 ? '' : 's' }}</span>
      <span class="view__count">{{ running.length }}/{{ all.length }} running</span>
      <span v-if="attention.length > 0" class="chip chip--danger">{{ attention.length }} need attention</span>
      <span class="view__spacer" />
      <button type="button" class="btn btn--sm" @click="control.refresh()">
        refresh
      </button>
    </div>

    <HostVitals />

    <section v-for="group in groups" :key="group.id" class="pane global__group">
      <div class="pane__head">
        <span class="pane__title">{{ group.label }}</span>
        <span class="mono faint">{{ group.id }}</span>
        <span class="faint">{{ group.runningCount }}/{{ group.serverCount }} running</span>
        <span v-if="group.crashedCount > 0" class="chip chip--danger">{{ group.crashedCount }} crashed</span>
        <span class="view__spacer" />
        <button type="button" class="btn btn--xs" @click="openWorkspace(group.id)">
          open workspace →
        </button>
      </div>

      <p v-if="group.configError" class="banner banner--warn">
        <strong>config problem</strong>
        <span>{{ group.configError }}</span>
        <code>{{ group.configPath }}</code>
      </p>

      <div v-if="group.servers.length > 0" class="tblwrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>server</th>
              <th>status</th>
              <th class="num">
                pid
              </th>
              <th class="num">
                port
              </th>
              <th class="num">
                uptime
              </th>
              <th>cpu</th>
              <th>rss</th>
              <th class="num">
                health
              </th>
              <th class="num">
                uptime %
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="server in group.servers"
              :key="`${group.id}:${server.id}`"
              class="global__row"
              tabindex="0"
              @click="openServer(group.id, server.id)"
              @keydown.enter="openServer(group.id, server.id)"
            >
              <td class="id">
                {{ server.id }}
                <span v-if="server.config.label" class="faint">{{ server.config.label }}</span>
              </td>
              <td>
                <StatusChip :status="server.status" />
              </td>
              <td class="num">
                {{ server.pid ?? '—' }}
              </td>
              <td class="num" :class="{ accent: server.portState === 'in-use' }">
                {{ server.config.port ?? '—' }}
              </td>
              <td class="num">
                {{ server.startedAt === null ? '—' : formatUptime(control.now.value - server.startedAt) }}
              </td>
              <td>
                <span class="row" style="gap: 0.35rem">
                  <Sparkline :values="control.seriesOf(group.id, server.id).cpu" color="var(--accent)" :width="54" :height="13" />
                  <span class="num mono">{{ (server.resources?.cpuPercent ?? 0).toFixed(0) }}%</span>
                </span>
              </td>
              <td class="num">
                {{ briefBytes(server.resources?.rssBytes ?? null) }}
              </td>
              <td class="num">
                <HealthChip :health="server.health" />
              </td>
              <td class="num">
                {{ formatRatio(server.history.uptimeRatio) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="empty">
        no servers in this workspace — <button type="button" class="btn btn--xs" @click="openWorkspace(group.id)">
          open it
        </button> to add one
      </p>
    </section>

    <p v-if="groups.length === 0" class="empty">
      the panel serves no workspace yet
    </p>
  </div>
</template>

<style scoped>
.global__group {
  margin: 0 0.75rem 0.75rem;
}
.global__row {
  cursor: pointer;
}
</style>
