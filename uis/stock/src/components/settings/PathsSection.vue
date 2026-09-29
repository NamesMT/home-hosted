<script setup lang="ts">
import type { WorkspaceView } from '@shared/contracts'
import { computed } from 'vue'
import CopyButton from '@/components/ui/CopyButton.vue'
import FieldGroup from '@/components/ui/FieldGroup.vue'

const props = defineProps<{
  dataRoot: string | null
  projectDir: string | null
  panelUrl: string | null
  /** Every workspace, so its own files can be shown from one place. */
  workspaces: WorkspaceView[]
}>()

interface PathRow {
  key: string
  label: string
  hint: string
  value: string
}

const globalSettings = computed(() => (props.dataRoot === null ? null : `${props.dataRoot}/settings.json`))

const rows = computed<PathRow[]>(() => [
  // The state directory first: everything else on this page lives inside it.
  { key: 'data', label: 'Data root', hint: 'HHOSTED_HOME — global settings, workspaces, TLS, backups and the UI.', value: props.dataRoot ?? '—' },
  { key: 'settings', label: 'Global settings', hint: 'settings.json — listener, auth, TLS policy, host vitals, backups.', value: globalSettings.value ?? '—' },
  { key: 'project', label: 'Project directory', hint: 'Base for relative entry paths.', value: props.projectDir ?? '—' },
  { key: 'panel', label: 'Panel address', hint: 'Where this control panel is live right now.', value: props.panelUrl ?? '—' },
])

/** One workspace's files, as the server reports them. */
function workspaceRows(workspace: WorkspaceView): PathRow[] {
  return [
    { key: `${workspace.id}:config`, label: 'Servers config', hint: `${workspace.label}'s servers.config.json.`, value: workspace.configPath },
    { key: `${workspace.id}:settings`, label: 'Workspace settings', hint: 'Server defaults, log retention, notifications, DDNS.', value: workspace.settingsPath },
    { key: `${workspace.id}:logs`, label: 'Logs', hint: 'Persisted output for this workspace.', value: workspace.logsDir },
  ]
}
</script>

<template>
  <div class="space-y-3">
    <FieldGroup title="Where things live" description="Read-only. Copy a path straight into a shell or an editor.">
      <ul class="divide-y divide-line-soft sm:col-span-2">
        <li v-for="row in rows" :key="row.key" class="flex items-start justify-between gap-3 py-2 first:pt-0 last:pb-0">
          <div class="min-w-0">
            <p class="text-xs font-medium text-ink">
              {{ row.label }}
            </p>
            <p class="mt-0.5 text-2xs leading-4 text-faint">
              {{ row.hint }}
            </p>
          </div>
          <div class="flex min-w-0 flex-1 items-center justify-end gap-1.5">
            <span class="min-w-0 truncate font-mono text-xs text-ink">{{ row.value }}</span>
            <CopyButton :value="row.value" :label="`Copy ${row.label.toLowerCase()}`" />
          </div>
        </li>
      </ul>
    </FieldGroup>

    <FieldGroup
      title="Workspace files"
      description="Each workspace owns its config, settings and log directory; nothing is shared between them."
    >
      <div v-for="workspace in workspaces" :key="workspace.id" class="space-y-2 sm:col-span-2">
        <p class="flex items-center gap-2 text-xs font-medium text-ink">
          {{ workspace.label }}
          <span class="font-mono text-2xs font-normal text-faint">{{ workspace.id }}</span>
        </p>
        <ul class="divide-y divide-line-soft">
          <li
            v-for="row in workspaceRows(workspace)"
            :key="row.key"
            class="flex items-start justify-between gap-3 py-1.5"
          >
            <div class="min-w-0">
              <p class="text-2xs font-medium text-ink">
                {{ row.label }}
              </p>
              <p class="mt-0.5 text-2xs leading-4 text-faint">
                {{ row.hint }}
              </p>
            </div>
            <div class="flex min-w-0 flex-1 items-center justify-end gap-1.5">
              <span class="min-w-0 truncate font-mono text-2xs text-ink">{{ row.value }}</span>
              <CopyButton :value="row.value" :label="`Copy ${row.label.toLowerCase()}`" />
            </div>
          </li>
        </ul>
      </div>
    </FieldGroup>
  </div>
</template>
