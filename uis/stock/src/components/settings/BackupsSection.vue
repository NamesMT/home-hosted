<script setup lang="ts">
import type { BackupsView, WorkspaceView } from '@shared/contracts'
import type { BackupsForm } from '@/components/settings/settingsForm'
import { Archive, Download, RotateCcw } from '@lucide/vue'
import { errorMessage } from '@shared/error-message'
import { computed, onMounted, ref } from 'vue'
import BackupDialog from '@/components/settings/BackupDialog.vue'
import ConfirmButton from '@/components/settings/ConfirmButton.vue'
import Notice from '@/components/settings/Notice.vue'
import RestoreDialog from '@/components/settings/RestoreDialog.vue'
import ScheduleScope from '@/components/settings/ScheduleScope.vue'
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
import TransText from '@/components/ui/TransText.vue'
import { useBackupSelection } from '@/composables/useBackupSelection'
import { useControlPlane } from '@/composables/useControlPlane'
import { t } from '@/i18n'
import * as api from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatBytes, formatDateTime } from '@/lib/format'
import { kindLabel, panelNote, panelText } from '@/lib/panel-text'
import { focusRing } from '@/lib/ui'

const props = defineProps<{
  state: BackupsView | null
  policy: BackupsView | null
  /** The panel's global settings file; the archive directory is a file-level decision. */
  configPath: string | null
  workspaces: WorkspaceView[]
  dirty: boolean
}>()

const emit = defineEmits<{ reset: [] }>()

/** The editable slice of the backups policy; `dir` stays a file-level decision. */
const form = defineModel<BackupsForm>('form', { required: true })

const control = useControlPlane()

/** The capture tree and the archives on disk; not in the state frame, so fetched here. */
const selection = useBackupSelection()

// The archive list is page content, not dialog content — the page must show what is on disk without
// anyone opening a dialog first. (The capture *tree* is dialog-gated; one fetch serves both.)
onMounted(() => { void selection.load() })

const keep = numberModel(() => form.value.keep, value => (form.value.keep = value), 5)
const scheduleHours = numberModel(() => form.value.scheduleHours, value => (form.value.scheduleHours = value), 24)
const scheduleKeep = numberModel(() => form.value.scheduleKeep, value => (form.value.scheduleKeep = value), 7)

/** When the last automatic archive ran, for the hint under the switch. */
const lastAutomatic = computed(() => {
  const at = props.state?.lastAutomaticAt ?? null
  return at === null ? null : formatDateTime(at)
})

/** Why the last scheduled pass failed, if it did: the page had no way to show this before. */
const scheduleError = computed(() => props.state?.scheduleError ?? null)

const busy = ref(false)
const message = ref<string | null>(null)
const error = ref<string | null>(null)
const createOpen = ref(false)
const restoreOpen = ref(false)
/** Which archive the restore dialog starts on; `null` lets it pick. */
const restoreSource = ref<{ kind: 'stored', name: string } | null>(null)

/** The archives on disk. Part of the selection model now, so loaded with the dialog's tree. */
const files = computed(() => selection.selection.value?.files ?? [])
/** What a backup would capture, for the read-only summary above the archive list. */
const entries = computed(() => selection.selection.value?.entries ?? [])

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
  // The new archive changes `files`, which is the selection model's, not the frame's.
  selection.invalidate()
  void control.refresh()
}

/** Open the capture dialog, fetching the tree it edits if this page has not got it yet. */
function openCreate(): void {
  void selection.load()
  createOpen.value = true
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
    message.value = t('settings.backups.deleted', { name })
    await selection.load()
    await control.refresh()
  }
  catch (caught) {
    error.value = errorMessage(caught)
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="space-y-3">
    <FieldGroup :title="t('settings.backups.policyTitle')" :description="t('settings.backups.policyDescription')">
      <template #actions>
        <AppButton size="xs" variant="ghost" :disabled="!props.dirty" @click="emit('reset')">
          {{ t('common.reset') }}
        </AppButton>
      </template>

      <ToggleSwitch
        v-model="form.enabled"
        :label="t('settings.backups.allow')"
        :hint="t('settings.backups.allowHint')"
        wide
      />
      <div v-if="!form.enabled" class="sm:col-span-2">
        <Notice tone="warn" :title="t('settings.backups.offTitle')">
          {{ t('settings.backups.offText') }}
        </Notice>
      </div>
      <NumberField v-model="keep" :label="t('settings.backups.keep')" :min="1" :hint="t('settings.backups.keepHint')" />
      <ToggleSwitch
        v-model="form.scheduleEnabled"
        :label="t('settings.backups.schedule')"
        :hint="t('settings.backups.scheduleHint')"
        wide
      />
      <template v-if="form.scheduleEnabled">
        <NumberField v-model="scheduleHours" :label="t('settings.backups.scheduleHours')" :min="1" :hint="t('settings.backups.scheduleHoursHint')" />
        <NumberField v-model="scheduleKeep" :label="t('settings.backups.scheduleKeep')" :min="1" :hint="t('settings.backups.scheduleKeepHint')" />
        <p v-if="lastAutomatic !== null" class="text-2xs text-muted sm:col-span-2">
          {{ t('settings.backups.scheduleLast', { when: lastAutomatic }) }}
        </p>
        <!--
          A failing schedule used to reach only the panel console. On the page it was
          indistinguishable from one that had not come due yet — "enabled, no archives".
        -->
        <p v-if="scheduleError !== null" class="text-2xs text-danger sm:col-span-2" role="status">
          {{ t('settings.backups.scheduleFailed', { when: formatDateTime(scheduleError.at), message: scheduleError.message }) }}
        </p>
        <!-- What an automatic archive contains. It used to be the full default scope, always. -->
        <ScheduleScope v-model:scope="form.scheduleScope" :selection="selection.selection.value" />
      </template>
      <TextField
        v-model="form.includePaths"
        :label="t('settings.backups.extraPaths')"
        :hint="t('settings.backups.extraPathsHint')"
        :placeholder="t('settings.backups.extraPathsPlaceholder')"
      />
      <div v-if="props.policy !== null" class="flex min-w-0 flex-col gap-1 sm:col-span-2">
        <span class="text-xs font-medium text-muted">{{ t('settings.backups.archiveDirectory') }}</span>
        <div class="flex items-center gap-1.5 rounded-control border border-line bg-page/60 px-2.5 py-1.5">
          <span class="min-w-0 flex-1 truncate font-mono text-xs text-ink">{{ props.policy.dir }}</span>
          <CopyButton :value="props.policy.dir" :label="t('settings.backups.copyArchiveDirectory')" />
        </div>
        <p class="text-2xs leading-4 text-faint">
          <TransText k="settings.backups.changeDirectory">
            <template #path>
              <code>{{ props.configPath ?? t('settings.backups.theSettingsFile') }}</code>
            </template>
          </TransText>
        </p>
      </div>
    </FieldGroup>

    <FieldGroup
      :title="t('settings.backups.capturesTitle')"
      :description="t('settings.backups.capturesDescription')"
    >
      <div v-if="props.state === null" class="space-y-2 sm:col-span-2">
        <Skeleton class="h-4 w-full" />
        <Skeleton class="h-4 w-2/3" />
      </div>
      <p v-else-if="entries.length === 0" class="text-xs text-muted sm:col-span-2">
        {{ t('settings.backups.nothingSelectable') }}
      </p>
      <ul v-else class="divide-y divide-line-soft sm:col-span-2">
        <li v-for="entry in entries" :key="entry.id" class="py-2 first:pt-0">
          <div class="flex items-center gap-2">
            <p class="min-w-0 flex-1 truncate text-xs font-medium text-ink">
              {{ panelText(entry) }}
            </p>
            <ToneBadge tone="neutral" plain>
              {{ kindLabel(entry.kind) }}
            </ToneBadge>
            <span v-if="entry.workspaceId" class="font-mono text-2xs text-faint">{{ entry.workspaceId }}</span>
          </div>
          <p v-if="panelNote(entry)" class="mt-0.5 text-2xs leading-4 text-muted">
            {{ panelNote(entry) }}
          </p>
          <ul v-if="entry.items.length > 0" class="mt-1 space-y-1">
            <li
              v-for="item in entry.items"
              :key="item.id"
              class="flex items-start justify-between gap-3 rounded-control bg-panel-2/40 px-2 py-1"
            >
              <div class="min-w-0">
                <p class="truncate font-mono text-2xs text-ink">
                  {{ item.path ?? panelText(item) }}
                </p>
                <p class="mt-0.5 text-2xs leading-4 text-faint">
                  {{ item.included ? (item.origin ? t('settings.backups.fromOrigin', { origin: item.origin }) : panelNote(item) ?? t('settings.backups.included')) : panelNote(item) ?? t('settings.backups.notCaptured') }}
                  <template v-if="item.included && item.ignoreGenerated">
                    · {{ t('settings.backups.generatedSkipped') }}
                  </template>
                </p>
              </div>
              <ToneBadge :tone="item.included ? 'ok' : 'neutral'" plain>
                {{ item.included ? t('settings.backups.included') : t('settings.backups.skipped') }}
              </ToneBadge>
            </li>
          </ul>
        </li>
      </ul>
      <p v-if="props.workspaces.length > 1" class="text-2xs leading-4 text-faint sm:col-span-2">
        {{ t('settings.backups.workspacesNote', { count: props.workspaces.length }) }}
      </p>
    </FieldGroup>

    <FieldGroup :title="t('settings.backups.archivesTitle')" :description="t('settings.backups.archivesDescription')">
      <template #actions>
        <AppButton
          v-if="form.enabled"
          size="xs"
          variant="primary"
          :disabled="props.state === null"
          @click="openCreate()"
        >
          {{ t('settings.backups.create') }}
        </AppButton>
        <AppButton size="xs" variant="secondary" :disabled="props.state === null" @click="openRestore()">
          {{ t('settings.backups.restore') }}
        </AppButton>
      </template>

      <div v-if="props.state === null" class="space-y-2 sm:col-span-2">
        <Skeleton class="h-4 w-full" />
        <Skeleton class="h-4 w-2/3" />
      </div>
      <div v-else-if="files.length === 0" class="sm:col-span-2">
        <EmptyState
          compact
          :title="t('settings.backups.noArchives')"
          :description="form.enabled
            ? t('settings.backups.noArchivesEnabled')
            : t('settings.backups.noArchivesDisabled')"
        >
          <template #icon>
            <Archive class="size-4" />
          </template>
          <template v-if="form.enabled" #action>
            <AppButton size="sm" variant="primary" @click="openCreate()">
              {{ t('settings.backups.create') }}
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
                {{ t('settings.backups.encrypted') }}
              </ToneBadge>
            </div>
            <p class="mt-0.5 font-mono text-2xs tabular-nums text-muted">
              {{ formatBytes(file.sizeBytes) }} · {{ formatDateTime(file.createdAt) }}
            </p>
          </div>
          <div class="flex items-center gap-1.5">
            <a :href="api.backupDownloadUrl(file.name)" :class="downloadClass">
              <Download class="size-3" aria-hidden="true" />
              {{ t('settings.backups.download') }}
            </a>
            <AppButton size="xs" variant="secondary" @click="openRestore(file.name)">
              <RotateCcw class="size-3" aria-hidden="true" />
              {{ t('settings.backups.restoreAction') }}
            </AppButton>
            <ConfirmButton
              :label="t('common.delete')"
              :confirm-label="t('settings.backups.confirmDelete')"
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

    <BackupDialog v-model:open="createOpen" :selection="selection.selection.value" @created="onCreated" />
    <RestoreDialog v-model:open="restoreOpen" :files="files" :initial="restoreSource" @applied="onRestored" />
  </div>
</template>
