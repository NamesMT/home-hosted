<script setup lang="ts">
import type { BackupsConfig, BackupsView } from '@shared/contracts'
import type { BackupsForm } from '@/components/settings/settingsForm'
import type { RestorePlan } from '@/lib/api'
import { Archive, Download, RotateCcw } from 'lucide-vue-next'
import { computed, ref } from 'vue'
import ConfirmButton from '@/components/settings/ConfirmButton.vue'
import Notice from '@/components/settings/Notice.vue'
import { numberModel } from '@/components/settings/settingsForm'
import AppButton from '@/components/ui/AppButton.vue'
import CheckField from '@/components/ui/CheckField.vue'
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
import { focusRing, inputClass, labelClass } from '@/lib/ui'

const props = defineProps<{
  state: BackupsView | null
  policy: BackupsConfig | null
  configPath: string | null
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
/** Optional: encrypts the next archive. Never stored anywhere. */
const backupPassword = ref('')
const restorePlan = ref<RestorePlan | null>(null)
const restoreFile = ref<File | null>(null)
const restorePassword = ref('')
/** What the shown plan refers to, so "apply" cannot target the wrong archive. */
const restoreTarget = ref<{ kind: 'stored', name: string } | { kind: 'upload' } | null>(null)

const files = computed(() => props.state?.files ?? [])
const paths = computed(() => props.state?.paths ?? [])
const selectedCount = computed(() => restorePlan.value?.items.filter(item => item.selected).length ?? 0)
const restoringConfig = computed(() => restorePlan.value?.items.some(item => item.id === 'config' && item.selected) ?? false)

const fileInput = cn(
  inputClass,
  'cursor-pointer text-xs',
  'file:mr-2 file:cursor-pointer file:rounded-control file:border-0 file:bg-panel-2 file:px-2 file:py-1 file:text-xs file:text-ink',
)
const downloadClass = cn(
  'inline-flex h-6 shrink-0 items-center gap-1 rounded-control border border-line bg-raise px-2 text-2xs font-medium text-ink',
  'transition-colors duration-150 hover:bg-hover',
  focusRing,
)

function selectAllRestorable(selected: boolean): void {
  for (const item of restorePlan.value?.items ?? []) {
    if (item.restorable)
      item.selected = selected
  }
}

async function runBackup(): Promise<void> {
  busy.value = true
  error.value = null
  message.value = null
  try {
    await api.createBackup(backupPassword.value)
    backupPassword.value = ''
    message.value = 'Backup created.'
    await control.refresh()
  }
  catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  }
  finally {
    busy.value = false
  }
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

function pickRestoreFile(event: Event): void {
  restoreFile.value = (event.target as HTMLInputElement).files?.[0] ?? null
  restorePlan.value = null
  restoreTarget.value = null
  error.value = null
  message.value = null
}

function restoreOptions(): api.RestoreOptions {
  return restorePassword.value.length > 0 ? { password: restorePassword.value } : {}
}

/** `name` selects a stored archive; without it the picked upload is used. */
async function planRestore(name?: string): Promise<void> {
  busy.value = true
  error.value = null
  message.value = null
  restorePlan.value = null
  try {
    if (name !== undefined) {
      restoreTarget.value = { kind: 'stored', name }
      restorePlan.value = await api.restoreStoredBackup(name, false, restoreOptions())
    }
    else if (restoreFile.value !== null) {
      restoreTarget.value = { kind: 'upload' }
      restorePlan.value = await api.restoreUploadedBackup(restoreFile.value, false, restoreOptions())
    }
    else {
      restoreTarget.value = null
    }

    if (restorePlan.value === null)
      error.value = 'Choose a stored backup or upload one first.'
  }
  catch (caught) {
    restoreTarget.value = null
    error.value = caught instanceof Error ? caught.message : String(caught)
  }
  finally {
    busy.value = false
  }
}

/** Re-reads the same archive, now with whatever the password field holds. */
async function replanRestore(): Promise<void> {
  const target = restoreTarget.value
  if (target === null)
    return
  await planRestore(target.kind === 'stored' ? target.name : undefined)
}

async function applyRestore(): Promise<void> {
  const target = restoreTarget.value
  const plan = restorePlan.value
  if (target === null || plan === null) {
    error.value = 'Check an archive first.'
    return
  }

  busy.value = true
  error.value = null
  const options: api.RestoreOptions = {
    ...restoreOptions(),
    include: plan.items.filter(item => item.restorable && item.selected).map(item => item.id),
  }

  try {
    const result = target.kind === 'stored'
      ? await api.restoreStoredBackup(target.name, true, options)
      : restoreFile.value !== null
        ? await api.restoreUploadedBackup(restoreFile.value, true, options)
        : null

    restorePlan.value = null
    restoreTarget.value = null
    restoreFile.value = null
    restorePassword.value = ''

    const notes: string[] = []
    if (result?.reloaded)
      notes.push('the restored servers are live, autostart entries starting')
    if (result?.restartRequired)
      notes.push('restart the panel to apply its own settings')
    message.value = result === null
      ? 'The restore failed.'
      : `Restored ${result.applied.length} item(s)${notes.length === 0 ? '' : ` — ${notes.join('; ')}`}.`
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
    <FieldGroup title="Policy" description="What a backup captures, and how many archives are kept.">
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
        hint="Comma separated, in addition to every entry's data directories."
        placeholder="{home}/myapp-data"
      />
      <div v-if="props.policy !== null" class="flex min-w-0 flex-col gap-1 sm:col-span-2">
        <span class="text-xs font-medium text-muted">Archive directory</span>
        <div class="flex items-center gap-1.5 rounded-control border border-line bg-page/60 px-2.5 py-1.5">
          <span class="min-w-0 flex-1 truncate font-mono text-xs text-ink">{{ props.policy.dir }}</span>
          <CopyButton :value="props.policy.dir" label="Copy the archive directory" />
        </div>
        <p class="text-2xs leading-4 text-faint">
          Changing it is a file-level decision: edit <code>{{ props.configPath ?? 'the config file' }}</code>.
        </p>
      </div>
    </FieldGroup>

    <FieldGroup title="Declared paths" description="Config, secrets and TLS are always captured. A path already covered by a declared parent is skipped.">
      <div v-if="props.state === null" class="space-y-2 sm:col-span-2">
        <Skeleton class="h-4 w-full" />
      </div>
      <p v-else-if="paths.length === 0" class="text-xs text-muted sm:col-span-2">
        No data paths are declared yet. Add <code>dataEnvs</code> or <code>backupPaths</code> to a server to capture its data.
      </p>
      <ul v-else class="divide-y divide-line-soft sm:col-span-2">
        <li v-for="entry in paths" :key="`${entry.origin}:${entry.path}`" class="flex items-start justify-between gap-3 py-1.5">
          <div class="min-w-0">
            <p class="truncate font-mono text-xs text-ink">
              {{ entry.path }}
            </p>
            <p class="mt-0.5 text-2xs leading-4 text-muted">
              {{ entry.included ? `from ${entry.origin}` : entry.note ?? 'not captured' }}
              <template v-if="entry.included && entry.ignoreGenerated">
                · generated directories skipped
              </template>
            </p>
          </div>
          <ToneBadge :tone="entry.included ? 'ok' : 'neutral'" plain>
            {{ entry.included ? 'included' : 'skipped' }}
          </ToneBadge>
        </li>
      </ul>
    </FieldGroup>

    <FieldGroup v-if="form.enabled" title="Create a backup now" description="Optional password encrypts the archive; restoring it will ask for the same password.">
      <TextField
        v-model="backupPassword"
        type="password"
        autocomplete="new-password"
        label="Password (optional)"
        wide
      />
      <div class="sm:col-span-2">
        <AppButton variant="primary" :disabled="busy" :loading="busy" @click="runBackup">
          Create backup now
        </AppButton>
      </div>
    </FieldGroup>

    <FieldGroup title="Archives" description="Stored in the backup directory and downloadable at any time.">
      <div v-if="props.state === null" class="space-y-2 sm:col-span-2">
        <Skeleton class="h-4 w-full" />
        <Skeleton class="h-4 w-2/3" />
      </div>
      <div v-else-if="files.length === 0" class="sm:col-span-2">
        <EmptyState
          compact
          title="No archives yet"
          :description="form.enabled
            ? 'Create one now to capture the config, secrets and every declared data path.'
            : 'Nothing has been archived yet, and backups are off.'"
        >
          <template #icon>
            <Archive class="size-4" />
          </template>
          <template v-if="form.enabled" #action>
            <AppButton size="sm" variant="primary" :disabled="busy" @click="runBackup">
              Create backup now
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
            <AppButton size="xs" variant="secondary" :disabled="busy" @click="planRestore(file.name)">
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
    </FieldGroup>

    <FieldGroup title="Restore" description="Nothing is written until the plan is applied.">
      <div class="flex min-w-0 flex-col gap-1 sm:col-span-2">
        <label :class="labelClass" for="restore-upload">Restore from an uploaded .zip</label>
        <input id="restore-upload" type="file" accept=".zip,application/zip" :class="fileInput" @change="pickRestoreFile">
        <p v-if="restoreFile" class="font-mono text-2xs text-muted">
          {{ restoreFile.name }}
        </p>
      </div>
      <div class="sm:col-span-2">
        <AppButton variant="secondary" :disabled="busy || restoreFile === null" @click="planRestore()">
          Check the upload
        </AppButton>
      </div>

      <div v-if="restorePlan" class="sm:col-span-2">
        <Notice tone="warn" :title="restorePlan.dryRun ? 'Nothing has changed yet' : 'Applied'">
          <p>
            <template v-if="restoreTarget?.kind === 'stored'">
              Archive <code>{{ restoreTarget.name }}</code>.
            </template>
            <template v-else>
              The uploaded archive.
            </template>
          </p>

          <template v-if="restorePlan.needsPassword">
            <p class="mt-2">
              {{ restorePlan.error ?? 'This backup is password-protected.' }}
            </p>
            <div class="mt-2 max-w-sm">
              <TextField v-model="restorePassword" type="password" autocomplete="off" label="Password" />
            </div>
            <div class="mt-2">
              <AppButton size="sm" variant="secondary" :disabled="busy" @click="replanRestore">
                Check again with the password
              </AppButton>
            </div>
          </template>

          <template v-else>
            <p class="mt-2">
              Choose what to restore — {{ selectedCount }} of {{ restorePlan.items.length }} selected.
            </p>
            <ul class="mt-1 max-h-64 space-y-0.5 overflow-auto">
              <li v-for="item in restorePlan.items" :key="item.id">
                <CheckField
                  v-model="item.selected"
                  :label="item.label"
                  :hint="[item.kind, item.note].filter(Boolean).join(' · ')"
                  :disabled="!item.restorable"
                />
              </li>
            </ul>
            <div class="mt-2 flex flex-wrap items-center gap-2">
              <AppButton size="xs" variant="ghost" :disabled="busy" @click="selectAllRestorable(true)">
                Select all
              </AppButton>
              <AppButton size="xs" variant="ghost" :disabled="busy" @click="selectAllRestorable(false)">
                Select none
              </AppButton>
            </div>

            <p class="mt-2">
              Will restore: {{ restorePlan.applied.join(', ') || 'nothing' }}.
              <template v-if="restorePlan.skipped.length">
                Skipped: {{ restorePlan.skipped.join(', ') }}.
              </template>
              <template v-if="restorePlan.restartRequired">
                The panel's own settings differ, so restart the panel afterwards.
              </template>
              <template v-else-if="restoringConfig">
                Restored servers are reloaded immediately; entries marked autostart start on their own.
              </template>
            </p>
            <div class="mt-2">
              <AppButton
                size="sm"
                variant="danger"
                :disabled="busy || selectedCount === 0"
                :loading="busy"
                @click="applyRestore"
              >
                {{ restoreTarget?.kind === 'stored' ? 'Apply this restore' : 'Restore the upload' }}
              </AppButton>
            </div>
          </template>
        </Notice>
      </div>

      <div v-if="error || message" class="space-y-2 sm:col-span-2">
        <Notice v-if="error" tone="danger">
          {{ error }}
        </Notice>
        <Notice v-if="message" tone="ok">
          {{ message }}
        </Notice>
      </div>
    </FieldGroup>
  </div>
</template>
