<script setup lang="ts">
import { computed } from 'vue'
import CopyButton from '@/components/ui/CopyButton.vue'
import FieldGroup from '@/components/ui/FieldGroup.vue'

const props = defineProps<{
  configPath: string | null
  dataRoot: string | null
  logsDir: string | null
  projectDir: string | null
  panelUrl: string | null
}>()

interface PathRow {
  key: string
  label: string
  hint: string
  value: string
}

const rows = computed<PathRow[]>(() => [
  // The state directory first: everything else on this page lives inside it.
  { key: 'data', label: 'Data root', hint: 'HHOSTED_HOME — config, secrets, TLS, logs and backups.', value: props.dataRoot ?? '—' },
  { key: 'config', label: 'Config file', hint: 'servers.config.json — every policy on this page.', value: props.configPath ?? '—' },
  { key: 'logs', label: 'Logs directory', hint: 'Persisted output for every server.', value: props.logsDir ?? '—' },
  { key: 'project', label: 'Project directory', hint: 'Base for relative entry paths.', value: props.projectDir ?? '—' },
  { key: 'panel', label: 'Panel address', hint: 'Where this control panel is live right now.', value: props.panelUrl ?? '—' },
])
</script>

<template>
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
</template>
