<script setup lang="ts">
import type { BackupFile, RestorePlan } from '@/lib/api'
import { errorMessage } from '@shared/error-message'
import { computed, ref, watch } from 'vue'
import Notice from '@/components/settings/Notice.vue'
import AppButton from '@/components/ui/AppButton.vue'
import CheckField from '@/components/ui/CheckField.vue'
import Modal from '@/components/ui/Modal.vue'
import SelectField from '@/components/ui/SelectField.vue'
import Skeleton from '@/components/ui/Skeleton.vue'
import TextField from '@/components/ui/TextField.vue'
import TransText from '@/components/ui/TransText.vue'
import { t } from '@/i18n'
import * as api from '@/lib/api'
import { cn } from '@/lib/cn'
import { kindLabel, panelNote, panelText } from '@/lib/panel-text'
import { inputClass, labelClass } from '@/lib/ui'

interface RestoreSource {
  kind: 'stored'
  name: string
}

type RestoreTarget = RestoreSource | { kind: 'upload' }

const props = withDefaults(defineProps<{
  files: BackupFile[]
  initial?: RestoreTarget | null
}>(), {
  initial: null,
})

const emit = defineEmits<{ applied: [message: string] }>()
const open = defineModel<boolean>('open', { default: false })

const UPLOAD = '__upload__'

const busy = ref(false)
const error = ref<string | null>(null)
const plan = ref<RestorePlan | null>(null)
const file = ref<File | null>(null)
const password = ref('')
const target = ref<RestoreTarget>({ kind: 'upload' })
const sourceValue = ref<string>(UPLOAD)

const selectedCount = computed(() => plan.value?.items.filter(item => item.selected).length ?? 0)

/**
 * What the plan will write, and what it will skip, in the reader's language.
 *
 * Both lists are the panel's own English sentences. `appliedIds`/`skippedItems` are the same facts
 * in parts, so each is resolved through `items` (which carries the label keys) and rendered here —
 * while a panel that predates those fields still reads correctly from `applied`/`skipped`.
 */
const appliedLabels = computed(() => {
  const view = plan.value
  if (view === null)
    return []
  if (view.appliedIds === undefined)
    return view.applied
  return view.appliedIds.map(id => panelText(view.items.find(item => item.id === id) ?? { label: id }))
})

const skippedLabels = computed(() => {
  const view = plan.value
  if (view === null)
    return []
  if (view.skippedItems === undefined)
    return view.skipped
  return view.skippedItems.map((skip) => {
    const label = panelText(skip)
    if (skip.reasonKey === undefined)
      return label
    return `${label} (${t(skip.reasonKey, skip.reasonParams)})`
  })
})
const restoringGlobal = computed(() => plan.value?.items.some(item => item.id === 'global:settings' && item.selected) ?? false)
const needsPassword = computed(() => plan.value?.needsPassword === true)
const canApply = computed(() => plan.value !== null && !needsPassword.value && selectedCount.value > 0 && !busy.value)
const sourceOptions = computed(() => [
  ...props.files.map(entry => ({ value: entry.name, label: entry.encrypted ? t('settings.restore.encryptedName', { name: entry.name }) : entry.name })),
  { value: UPLOAD, label: t('settings.restore.uploadOption') },
])

const fileInput = cn(
  inputClass,
  'cursor-pointer text-xs',
  'file:mr-2 file:cursor-pointer file:rounded-control file:border-0 file:bg-panel-2 file:px-2 file:py-1 file:text-xs file:text-ink',
)

function describe(caught: unknown): string {
  return errorMessage(caught)
}

function restoreOptions(): api.RestoreOptions {
  return password.value.length > 0 ? { password: password.value } : {}
}

async function planCurrent(): Promise<void> {
  const where = target.value
  if (where.kind === 'upload' && file.value === null) {
    plan.value = null
    return
  }

  busy.value = true
  error.value = null
  plan.value = null
  try {
    plan.value = where.kind === 'stored'
      ? await api.restoreStoredBackup(where.name, false, restoreOptions())
      : await api.restoreUploadedBackup(file.value!, false, restoreOptions())
  }
  catch (caught) {
    error.value = describe(caught)
  }
  finally {
    busy.value = false
  }
}

function chooseSource(value: string): void {
  sourceValue.value = value
  file.value = null
  target.value = value === UPLOAD ? { kind: 'upload' } : { kind: 'stored', name: value }
  void planCurrent()
}

function pickFile(event: Event): void {
  file.value = (event.target as HTMLInputElement).files?.[0] ?? null
  void planCurrent()
}

function selectAllRestorable(selected: boolean): void {
  for (const item of plan.value?.items ?? []) {
    if (item.restorable)
      item.selected = selected
  }
}

async function apply(): Promise<void> {
  const current = plan.value
  const where = target.value
  if (current === null || !canApply.value)
    return

  busy.value = true
  error.value = null
  const options: api.RestoreOptions = {
    ...restoreOptions(),
    include: current.items.filter(item => item.restorable && item.selected).map(item => item.id),
  }

  try {
    const result = where.kind === 'stored'
      ? await api.restoreStoredBackup(where.name, true, options)
      : await api.restoreUploadedBackup(file.value!, true, options)

    open.value = false
    plan.value = null
    file.value = null
    password.value = ''

    const notes: string[] = []
    if (result.reloaded)
      notes.push(t('settings.restore.noteReloaded'))
    if (result.restartRequired)
      notes.push(t('settings.restore.noteRestart'))
    const count = result.applied.length
    emit('applied', notes.length === 0
      ? t('settings.restore.restored', { count })
      : t('settings.restore.restoredWithNotes', { count, notes: notes.join('; ') }))
  }
  catch (caught) {
    error.value = describe(caught)
  }
  finally {
    busy.value = false
  }
}

watch(open, (isOpen) => {
  if (!isOpen) {
    plan.value = null
    file.value = null
    password.value = ''
    error.value = null
    return
  }

  const first = props.files[0]
  target.value = props.initial ?? (first === undefined ? { kind: 'upload' } : { kind: 'stored', name: first.name })
  sourceValue.value = target.value.kind === 'stored' ? target.value.name : UPLOAD
  void planCurrent()
}, { immediate: true })
</script>

<template>
  <Modal
    v-model:open="open"
    :title="t('settings.restore.title')"
    :description="t('settings.restore.description')"
    width="w-[min(92vw,38rem)]"
  >
    <div class="space-y-3">
      <SelectField
        :model-value="sourceValue"
        :label="t('settings.restore.archive')"
        :hint="t('settings.restore.archiveHint')"
        :options="sourceOptions"
        :disabled="busy"
        wide
        @update:model-value="chooseSource"
      />

      <div v-if="target.kind === 'upload'" class="flex min-w-0 flex-col gap-1">
        <label :class="labelClass" for="restore-upload">{{ t('settings.restore.archiveFile') }}</label>
        <input id="restore-upload" type="file" accept=".zip,application/zip" :class="fileInput" :disabled="busy" @change="pickFile">
        <p v-if="file" class="font-mono text-2xs text-muted">
          {{ file.name }}
        </p>
      </div>

      <Skeleton v-if="busy" class="h-20 w-full" />

      <Notice v-else-if="plan" tone="warn" :title="t('settings.restore.unchangedTitle')">
        <p>
          <TransText v-if="target.kind === 'stored'" k="settings.restore.archiveLine">
            <template #name>
              <code>{{ target.name }}</code>
            </template>
          </TransText>
          <template v-else>
            {{ t('settings.restore.uploadedArchive') }}
          </template>
        </p>

        <template v-if="plan.needsPassword">
          <p class="mt-2">
            {{ plan.error ?? t('settings.restore.passwordProtected') }}
          </p>
          <div class="mt-2 max-w-sm">
            <TextField v-model="password" type="password" autocomplete="off" :label="t('settings.restore.password')" />
          </div>
          <div class="mt-2">
            <AppButton size="sm" variant="secondary" :disabled="busy" @click="planCurrent">
              {{ t('settings.restore.checkAgain') }}
            </AppButton>
          </div>
        </template>

        <template v-else>
          <p class="mt-2">
            {{ t('settings.restore.choosePrompt', { selected: selectedCount, total: plan.items.length }) }}
          </p>
          <ul class="mt-1 max-h-64 space-y-0.5 overflow-auto">
            <li v-for="item in plan.items" :key="item.id">
              <CheckField
                v-model="item.selected"
                :label="panelText(item)"
                :hint="[kindLabel(item.kind), item.workspaceId, panelNote(item)].filter(Boolean).join(' · ')"
                :disabled="!item.restorable || busy"
              />
            </li>
          </ul>
          <div class="mt-2 flex flex-wrap items-center gap-2">
            <AppButton size="xs" variant="ghost" :disabled="busy" @click="selectAllRestorable(true)">
              {{ t('common.selectAll') }}
            </AppButton>
            <AppButton size="xs" variant="ghost" :disabled="busy" @click="selectAllRestorable(false)">
              {{ t('common.selectNone') }}
            </AppButton>
          </div>

          <p class="mt-2">
            {{ t('settings.restore.willRestore', { items: appliedLabels.join(', ') || t('settings.restore.nothing') }) }}
            <template v-if="skippedLabels.length > 0">
              {{ t('settings.restore.skipped', { items: skippedLabels.join(', ') }) }}
            </template>
            <template v-if="plan.restartRequired">
              {{ t('settings.restore.restartNote') }}
            </template>
            <template v-else-if="restoringGlobal">
              {{ t('settings.restore.reloadedNote') }}
            </template>
          </p>
        </template>
      </Notice>

      <Notice v-if="error" tone="danger">
        {{ error }}
      </Notice>
    </div>

    <template #footer>
      <AppButton size="sm" variant="ghost" :disabled="busy" @click="open = false">
        {{ t('common.cancel') }}
      </AppButton>
      <AppButton
        v-if="plan && !needsPassword"
        size="sm"
        variant="danger"
        :disabled="!canApply"
        :loading="busy"
        @click="apply"
      >
        {{ target.kind === 'stored' ? t('settings.restore.applyStored') : t('settings.restore.applyUpload') }}
      </AppButton>
    </template>
  </Modal>
</template>
