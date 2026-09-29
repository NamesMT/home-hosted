<script setup lang="ts">
import type { BackupsConfig, BackupsView, WorkspaceView } from '@shared/contracts'
import type { BackupsForm } from '@/components/settings/settingsForm'
import { Archive, Download, RotateCcw } from 'lucide-vue-next'
import { computed, ref } from 'vue'
import BackupDialog from '@/components/settings/BackupDialog.vue'
import ConfirmButton from '@/components/settings/ConfirmButton.vue'
import Notice from '@/components/settings/Notice.vue'
import RestoreDialog from '@/components/settings/RestoreDialog.vue'
import { numberModel } from '@/components/settings/settingsForm'
import AppButton from '@/components/ui/AppButton.vue'
import CopyButton from '@/components/ui/CopyButton.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import FieldGroup from '@/components/ui/FieldGroup.vue'
import NumberField from '@/components/ui/NumberField.vue'
import Skeleton from '@/components/ui/Skeleton.vue'
import TextField from '@/components/ui/TextField.vue'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import ToneBadge from '@/components/ui/ToneBadge.vue'
import { useControlPlane } from '@/composables/useControlPlane'
import * as api from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatBytes, formatDateTime } from '@/lib/format'
import { focusRing } from '@/lib/ui'

const props = defineProps<{
  state: BackupsView | null
  policy: BackupsConfig | null
  /** The panel's global settings file; the archive directory is a file-level decision. */
  configPath: string | null
  workspaces: WorkspaceView[]
  dirty: boolean
}>()

const emit = defineEmits<{ reset: [] }>()

/** The editable slice of the backups policy; `dir` stays a file-level decision. */
const form = defineModel<BackupsForm>('form', { required: true })

const control = useControlPlane()

const keep = numberModel(() => form.value.keep, value => (form.value.keep = value), 5)

const busy = ref(false)
const message = ref<string | null>(null)
const error = ref<string | null>(null)
const createOpen = ref(false)
const restoreOpen = ref(false)
/** Which archive the restore dialog starts on; `null` lets it pick. */
const restoreSource = ref<{ kind: 'stored', name: string } | null>(null)

const files = computed(() => props.state?.files ?? [])
const entries = computed(() => props.state?.entries ?? [])

const KIND_LABEL: Record<string, string> = {
  settings: 'settings',
  servers: 'servers',
  secrets: 'secrets',
  tls: 'tls',
  data: 'data',
}

const downloadClass = cn(
  'inline-flex h-6 shrink-0 items-center gap-1 rounded-control border border-line bg-raise px-2 text-2xs font-medium text-ink',
  'transition-colors duration-150 hover:bg-hover',
  focusRing,
)

function openRestore(name?: string): void {
  restoreSource.value = name === undefined ? null : { kind: 'stored', name }
  restoreOpen.value = true
}

function onCreated(result: string): void {
  error.value = null
  message.value = result
  void control.refresh()
}

function onRestored(result: string): void {
  error.value = null
  message.value = result
  void control.refresh()
}

async function removeBackup(name: string): Promise<void> {
  busy.value = true
  error.value = null
  message.value = null
  try {
    await api.deleteBackup(name)
    message.value = `Deleted ${name}.`
    await control.refresh()
  }
  catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="space-y-3">
    <FieldGroup title="Policy" description="How many archives the panel keeps, and the extra paths every one of them captures.">
      <template #actions>
        <AppButton size="xs" variant="ghost" :disabled="!props.dirty" @click="emit('reset')">
          Reset
        </AppButton>
      </template>

      <ToggleSwitch
        v-model="form.enabled"
        label="Allow backups"
        hint="Off stops new archives; whatever is already on disk stays downloadable and restorable."
        wide
      />
      <div v-if="!form.enabled" class="sm:col-span-2">
        <Notice tone="warn" title="Backups are off">
          Nothing new is archived until this is back on. The archives below can still be downloaded, restored and deleted.
        </Notice>
      </div>
      <NumberField v-model="keep" label="Keep" :min="1" hint="Older archives are pruned after each backup." />
      <TextField
        v-model="form.includePaths"
        label="Extra paths"
        hint="Comma separated, captured in every archive on top of what each workspace declares."
        placeholder="{home}/myapp-data"
      />
      <div v-if="props.policy !== null" class="flex min-w-0 flex-col gap-1 sm:col-span-2">
        <span class="text-xs font-medium text-muted">Archive directory</span>
        <div class="flex items-center gap-1.5 rounded-control border border-line bg-page/60 px-2.5 py-1.5">
          <span class="min-w-0 flex-1 truncate font-mono text-xs text-ink">{{ props.policy.dir }}</span>
          <CopyButton :value="props.policy.dir" label="Copy the archive directory" />
        </div>
        <p class="text-2xs leading-4 text-faint">
          Changing it is a file-level decision: edit <code>{{ props.configPath ?? 'the settings file' }}</code>.
        </p>
      </div>
    </FieldGroup>

    <FieldGroup
      title="What a backup captures"
      description="Pick these in the create dialog. A workspace can be taken whole or only its settings, servers, secrets and declared data paths."
    >
      <div v-if="props.state === null" class="space-y-2 sm:col-span-2">
        <Skeleton class="h-4 w-full" />
        <Skeleton class="h-4 w-2/3" />
      </div>
      <p v-else-if="entries.length === 0" class="text-xs text-muted sm:col-span-2">
        Nothing is selectable yet.
      </p>
      <ul v-else class="divide-y divide-line-soft sm:col-span-2">
        <li v-for="entry in entries" :key="entry.id" class="py-2 first:pt-0">
          <div class="flex items-center gap-2">
            <p class="min-w-0 flex-1 truncate text-xs font-medium text-ink">
              {{ entry.label }}
            </p>
            <ToneBadge tone="neutral" plain>
              {{ KIND_LABEL[entry.kind] ?? entry.kind }}
            </ToneBadge>
            <span v-if="entry.workspaceId" class="font-mono text-2xs text-faint">{{ entry.workspaceId }}</span>
          </div>
          <p v-if="entry.note" class="mt-0.5 text-2xs leading-4 text-muted">
            {{ entry.note }}
          </p>
          <ul v-if="entry.items.length > 0" class="mt-1 space-y-1">
            <li
              v-for="item in entry.items"
              :key="item.id"
              class="flex items-start justify-between gap-3 rounded-control bg-panel-2/40 px-2 py-1"
            >
              <div class="min-w-0">
                <p class="truncate font-mono text-2xs text-ink">
                  {{ item.path ?? item.label }}
                </p>
                <p class="mt-0.5 text-2xs leading-4 text-faint">
                  {{ item.included ? (item.origin ? `from ${item.origin}` : item.note ?? 'included') : item.note ?? 'not captured' }}
                  <template v-if="item.included && item.ignoreGenerated">
                    · generated directories skipped
                  </template>
                </p>
              </div>
              <ToneBadge :tone="item.included ? 'ok' : 'neutral'" plain>
                {{ item.included ? 'included' : 'skipped' }}
              </ToneBadge>
            </li>
          </ul>
        </li>
      </ul>
      <p v-if="props.workspaces.length > 1" class="text-2xs leading-4 text-faint sm:col-span-2">
        This panel serves {{ props.workspaces.length }} workspaces; each is its own selectable entry.
      </p>
    </FieldGroup>

    <FieldGroup title="Archives" description="Stored in the backup directory and downloadable at any time.">
      <template #actions>
        <AppButton
          v-if="form.enabled"
          size="xs"
          variant="primary"
          :disabled="props.state === null"
          @click="createOpen = true"
        >
          Create backup…
        </AppButton>
        <AppButton size="xs" variant="secondary" :disabled="props.state === null" @click="openRestore()">
          Restore…
        </AppButton>
      </template>

      <div v-if="props.state === null" class="space-y-2 sm:col-span-2">
        <Skeleton class="h-4 w-full" />
        <Skeleton class="h-4 w-2/3" />
      </div>
      <div v-else-if="files.length === 0" class="sm:col-span-2">
        <EmptyState
          compact
          title="No archives yet"
          :description="form.enabled
            ? 'Create one now to capture the panel and whichever workspaces you pick.'
            : 'Nothing has been archived yet, and backups are off.'"
        >
          <template #icon>
            <Archive class="size-4" />
          </template>
          <template v-if="form.enabled" #action>
            <AppButton size="sm" variant="primary" @click="createOpen = true">
              Create backup…
            </AppButton>
          </template>
        </EmptyState>
      </div>
      <ul v-else class="divide-y divide-line-soft sm:col-span-2">
        <li v-for="file in files" :key="file.name" class="flex flex-wrap items-center gap-x-3 gap-y-2 py-2 first:pt-0 last:pb-0">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="truncate font-mono text-xs text-ink">{{ file.name }}</span>
              <ToneBadge v-if="file.encrypted" tone="warn" plain>
                encrypted
              </ToneBadge>
            </div>
            <p class="mt-0.5 font-mono text-2xs tabular-nums text-muted">
              {{ formatBytes(file.sizeBytes) }} · {{ formatDateTime(file.createdAt) }}
            </p>
          </div>
          <div class="flex items-center gap-1.5">
            <a :href="api.backupDownloadUrl(file.name)" :class="downloadClass">
              <Download class="size-3" aria-hidden="true" />
              Download
            </a>
            <AppButton size="xs" variant="secondary" @click="openRestore(file.name)">
              <RotateCcw class="size-3" aria-hidden="true" />
              Restore
            </AppButton>
            <ConfirmButton
              label="Delete"
              confirm-label="Confirm delete"
              size="xs"
              variant="ghost"
              confirm-variant="danger"
              :disabled="busy"
              @confirm="removeBackup(file.name)"
            />
          </div>
        </li>
      </ul>

      <div v-if="error || message" class="space-y-2 sm:col-span-2">
        <Notice v-if="error" tone="danger">
          {{ error }}
        </Notice>
        <Notice v-if="message" tone="ok">
          {{ message }}
        </Notice>
      </div>
    </FieldGroup>

    <BackupDialog v-model:open="createOpen" :state="props.state" @created="onCreated" />
    <RestoreDialog v-model:open="restoreOpen" :files="files" :initial="restoreSource" @applied="onRestored" />
  </div>
</template>
