<script setup lang="ts">
import type { BackupsConfig, BackupsView, WorkspaceView } from '@shared/contracts'
import type { BackupsForm } from '@/components/settings/settingsForm'
import { errorMessage } from '@shared/error-message'
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
import TransText from '@/components/ui/TransText.vue'
import { useControlPlane } from '@/composables/useControlPlane'
import { t } from '@/i18n'
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

/** The badge for an archive root's kind; an unknown kind reads as its own name. */
const KIND_LABEL: Record<string, string> = {
  settings: 'settings.backups.kindSettings',
  servers: 'settings.backups.kindServers',
  secrets: 'settings.backups.kindSecrets',
  tls: 'settings.backups.kindTls',
  data: 'settings.backups.kindData',
}

function kindLabel(kind: string): string {
  const key = KIND_LABEL[kind]
  return key === undefined ? kind : t(key)
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
    message.value = t('settings.backups.deleted', { name })
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
              {{ entry.label }}
            </p>
            <ToneBadge tone="neutral" plain>
              {{ kindLabel(entry.kind) }}
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
                  {{ item.included ? (item.origin ? t('settings.backups.fromOrigin', { origin: item.origin }) : item.note ?? t('settings.backups.included')) : item.note ?? t('settings.backups.notCaptured') }}
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
          @click="createOpen = true"
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
            <AppButton size="sm" variant="primary" @click="createOpen = true">
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

    <BackupDialog v-model:open="createOpen" :state="props.state" @created="onCreated" />
    <RestoreDialog v-model:open="restoreOpen" :files="files" :initial="restoreSource" @applied="onRestored" />
  </div>
</template>
