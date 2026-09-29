<script setup lang="ts">
import type { BackupFile, RestorePlan } from '@/lib/api'
import { computed, ref, watch } from 'vue'
import Notice from '@/components/settings/Notice.vue'
import AppButton from '@/components/ui/AppButton.vue'
import CheckField from '@/components/ui/CheckField.vue'
import Modal from '@/components/ui/Modal.vue'
import SelectField from '@/components/ui/SelectField.vue'
import Skeleton from '@/components/ui/Skeleton.vue'
import TextField from '@/components/ui/TextField.vue'
import * as api from '@/lib/api'
import { cn } from '@/lib/cn'
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
const restoringGlobal = computed(() => plan.value?.items.some(item => item.id === 'global:settings' && item.selected) ?? false)
const needsPassword = computed(() => plan.value?.needsPassword === true)
const canApply = computed(() => plan.value !== null && !needsPassword.value && selectedCount.value > 0 && !busy.value)
const sourceOptions = computed(() => [
  ...props.files.map(entry => ({ value: entry.name, label: entry.encrypted ? `${entry.name} — encrypted` : entry.name })),
  { value: UPLOAD, label: 'Upload a file…' },
])

const fileInput = cn(
  inputClass,
  'cursor-pointer text-xs',
  'file:mr-2 file:cursor-pointer file:rounded-control file:border-0 file:bg-panel-2 file:px-2 file:py-1 file:text-xs file:text-ink',
)

function describe(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught)
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
      notes.push('the restored servers are live, autostart entries starting')
    if (result.restartRequired)
      notes.push('restart the panel to apply its own settings')
    emit('applied', `Restored ${result.applied.length} item(s)${notes.length === 0 ? '' : ` — ${notes.join('; ')}`}.`)
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
    title="Restore a backup"
    description="Nothing is written until the plan is applied."
    width="w-[min(92vw,38rem)]"
  >
    <div class="space-y-3">
      <SelectField
        :model-value="sourceValue"
        label="Archive"
        hint="A stored archive, or a .zip from this machine."
        :options="sourceOptions"
        :disabled="busy"
        wide
        @update:model-value="chooseSource"
      />

      <div v-if="target.kind === 'upload'" class="flex min-w-0 flex-col gap-1">
        <label :class="labelClass" for="restore-upload">Archive file (.zip)</label>
        <input id="restore-upload" type="file" accept=".zip,application/zip" :class="fileInput" :disabled="busy" @change="pickFile">
        <p v-if="file" class="font-mono text-2xs text-muted">
          {{ file.name }}
        </p>
      </div>

      <Skeleton v-if="busy" class="h-20 w-full" />

      <Notice v-else-if="plan" tone="warn" title="Nothing has changed yet">
        <p>
          <template v-if="target.kind === 'stored'">
            Archive <code>{{ target.name }}</code>.
          </template>
          <template v-else>
            The uploaded archive.
          </template>
        </p>

        <template v-if="plan.needsPassword">
          <p class="mt-2">
            {{ plan.error ?? 'This backup is password-protected.' }}
          </p>
          <div class="mt-2 max-w-sm">
            <TextField v-model="password" type="password" autocomplete="off" label="Password" />
          </div>
          <div class="mt-2">
            <AppButton size="sm" variant="secondary" :disabled="busy" @click="planCurrent">
              Check again with the password
            </AppButton>
          </div>
        </template>

        <template v-else>
          <p class="mt-2">
            Choose what to restore — {{ selectedCount }} of {{ plan.items.length }} selected.
          </p>
          <ul class="mt-1 max-h-64 space-y-0.5 overflow-auto">
            <li v-for="item in plan.items" :key="item.id">
              <CheckField
                v-model="item.selected"
                :label="item.label"
                :hint="[item.kind, item.workspaceId, item.note].filter(Boolean).join(' · ')"
                :disabled="!item.restorable || busy"
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
            Will restore: {{ plan.applied.join(', ') || 'nothing' }}.
            <template v-if="plan.skipped.length">
              Skipped: {{ plan.skipped.join(', ') }}.
            </template>
            <template v-if="plan.restartRequired">
              The panel's own settings differ, so restart the panel afterwards.
            </template>
            <template v-else-if="restoringGlobal">
              Restored workspaces are reloaded immediately; entries marked autostart start on their own.
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
        Cancel
      </AppButton>
      <AppButton
        v-if="plan && !needsPassword"
        size="sm"
        variant="danger"
        :disabled="!canApply"
        :loading="busy"
        @click="apply"
      >
        {{ target.kind === 'stored' ? 'Apply this restore' : 'Restore the upload' }}
      </AppButton>
    </template>
  </Modal>
</template>
