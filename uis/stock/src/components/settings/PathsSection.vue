<script setup lang="ts">
import type { WorkspaceView } from '@shared/contracts'
import { computed } from 'vue'
import CopyButton from '@/components/ui/CopyButton.vue'
import FieldGroup from '@/components/ui/FieldGroup.vue'
import { t } from '@/i18n'

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
  /** The label as it reads in a "Copy …" button, which lowercases it in English. */
  copyLabel: string
}

const globalSettings = computed(() => (props.dataRoot === null ? null : `${props.dataRoot}/settings.json`))

const rows = computed<PathRow[]>(() => [
  // The state directory first: everything else on this page lives inside it.
  { key: 'data', label: t('settings.paths.dataRoot'), hint: t('settings.paths.dataRootHint'), copyLabel: t('settings.paths.dataRoot'), value: props.dataRoot ?? '—' },
  { key: 'settings', label: t('settings.paths.globalSettings'), hint: t('settings.paths.globalSettingsHint'), copyLabel: t('settings.paths.globalSettings'), value: globalSettings.value ?? '—' },
  { key: 'project', label: t('settings.paths.projectDir'), hint: t('settings.paths.projectDirHint'), copyLabel: t('settings.paths.projectDir'), value: props.projectDir ?? '—' },
  { key: 'panel', label: t('settings.paths.panelAddress'), hint: t('settings.paths.panelAddressHint'), copyLabel: t('settings.paths.panelAddress'), value: props.panelUrl ?? '—' },
])

/** One workspace's files, as the server reports them. */
function workspaceRows(workspace: WorkspaceView): PathRow[] {
  return [
    { key: `${workspace.id}:config`, label: t('settings.paths.serversConfig'), hint: t('settings.paths.serversConfigHint', { label: workspace.label }), copyLabel: t('settings.paths.serversConfig'), value: workspace.configPath },
    { key: `${workspace.id}:settings`, label: t('settings.paths.workspaceSettings'), hint: t('settings.paths.workspaceSettingsHint'), copyLabel: t('settings.paths.workspaceSettings'), value: workspace.settingsPath },
    { key: `${workspace.id}:logs`, label: t('settings.paths.logs'), hint: t('settings.paths.logsHint'), copyLabel: t('settings.paths.logs'), value: workspace.logsDir },
  ]
}
</script>

<template>
  <div class="space-y-3">
    <FieldGroup :title="t('settings.paths.whereThingsLive')" :description="t('settings.paths.whereThingsLiveDescription')">
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
            <CopyButton :value="row.value" :label="t('settings.paths.copyPath', { label: row.copyLabel.toLowerCase() })" />
          </div>
        </li>
      </ul>
    </FieldGroup>

    <FieldGroup
      :title="t('settings.paths.workspaceFiles')"
      :description="t('settings.paths.workspaceFilesDescription')"
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
              <CopyButton :value="row.value" :label="t('settings.paths.copyPath', { label: row.copyLabel.toLowerCase() })" />
            </div>
          </li>
        </ul>
      </div>
    </FieldGroup>
  </div>
</template>
