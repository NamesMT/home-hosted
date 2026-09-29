<script setup lang="ts">
import type { BackupFile, RestorePlan } from '@shared/contracts'
import { computed, ref, watch } from 'vue'
import * as api from '@/lib/api'

interface RestoreSource {
  kind: 'stored'
  name: string
}

type RestoreTarget = RestoreSource | { kind: 'upload' }

const props = withDefaults(defineProps<{
  open: boolean
  files: readonly BackupFile[]
  initial?: RestoreTarget | null
}>(), {
  initial: null,
})

const emit = defineEmits<{ close: [], done: [message: string] }>()

const UPLOAD = '__upload__'

const busy = ref(false)
const error = ref<string | null>(null)
const plan = ref<RestorePlan | null>(null)
const file = ref<File | null>(null)
const password = ref('')
const target = ref<RestoreTarget>({ kind: 'upload' })
const sourceValue = ref<string>(UPLOAD)

const selectedCount = computed(() => plan.value?.items.filter(item => item.selected).length ?? 0)
const restoringConfig = computed(() => plan.value?.items.some(item => item.id === 'global:settings' && item.selected) ?? false)
const needsPassword = computed(() => plan.value?.needsPassword === true)
const canApply = computed(() => plan.value !== null && !needsPassword.value && selectedCount.value > 0 && !busy.value)
const sourceOptions = computed(() => [
  ...props.files.map(entry => ({ value: entry.name, label: entry.encrypted ? `${entry.name} — encrypted` : entry.name })),
  { value: UPLOAD, label: 'upload a file…' },
])

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
    error.value = caught instanceof Error ? caught.message : String(caught)
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

function onSourceChange(event: Event): void {
  chooseSource((event.target as HTMLSelectElement).value)
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

    plan.value = null
    file.value = null
    password.value = ''

    const notes: string[] = []
    if (result.reloaded)
      notes.push('the restored servers are live, autostart entries starting')
    if (result.restartRequired)
      notes.push('restart home-hosted to apply the panel settings')
    let message = `restored ${result.applied.length} item(s)${notes.length === 0 ? '' : ` — ${notes.join('; ')}`}`
    if (result.skipped.length > 0)
      message += ` · skipped: ${result.skipped.join(', ')}`
    emit('done', message)
    emit('close')
  }
  catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  }
  finally {
    busy.value = false
  }
}

watch(() => props.open, (isOpen) => {
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
  <div v-if="open" class="overlay" @click.self="emit('close')">
    <div class="overlay__panel overlay__panel--sheet dialog" role="dialog" aria-label="restore a backup">
      <div class="overlay__head">
        <span class="overlay__title">restore</span>
        <span class="view__spacer" />
        <span class="faint">nothing is written until the plan is applied</span>
        <kbd class="kbd">esc</kbd>
      </div>

      <div class="overlay__body">
        <label class="field grid__full">
          <span class="field__label">archive</span>
          <select :value="sourceValue" :disabled="busy" @change="onSourceChange">
            <option v-for="option in sourceOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
        </label>

        <label v-if="target.kind === 'upload'" class="field grid__full">
          <span class="field__label">archive file (.zip)</span>
          <input type="file" accept=".zip,application/zip" :disabled="busy" @change="pickFile">
          <span v-if="file" class="field__hint">{{ file.name }}</span>
        </label>

        <p v-if="busy" class="note">
          checking the archive…
        </p>

        <div v-else-if="plan" class="stack">
          <p class="note note--warn">
            <strong>Nothing changed yet.</strong>
            <template v-if="target.kind === 'stored'">
              Archive {{ target.name }}.
            </template>
            <template v-else>
              The uploaded archive.
            </template>
          </p>

          <template v-if="plan.needsPassword">
            <p class="note note--error">
              {{ plan.error ?? 'This backup is password-protected.' }}
            </p>
            <label class="field">
              <span class="field__label">password</span>
              <input v-model="password" type="password" autocomplete="off">
            </label>
            <div class="actions actions--start">
              <button type="button" class="btn btn--sm" :disabled="busy" @click="planCurrent">
                check again with the password
              </button>
            </div>
          </template>

          <template v-else>
            <p class="note">
              Choose what to restore — {{ selectedCount }} of {{ plan.items.length }} selected.
            </p>
            <div class="stack">
              <label
                v-for="item in plan.items"
                :key="item.id"
                class="field field--check"
                :class="{ faint: !item.restorable }"
              >
                <input v-model="item.selected" type="checkbox" :disabled="!item.restorable || busy">
                <span class="field__label">
                  {{ item.label }}
                  <span class="faint">· {{ item.kind }}</span>
                  <em v-if="item.note" class="dim">— {{ item.note }}</em>
                </span>
              </label>
            </div>
            <div class="actions actions--start">
              <button type="button" class="btn btn--sm btn--ghost" :disabled="busy" @click="selectAllRestorable(true)">
                select all
              </button>
              <button type="button" class="btn btn--sm btn--ghost" :disabled="busy" @click="selectAllRestorable(false)">
                select none
              </button>
            </div>

            <p class="note">
              Will restore: {{ plan.applied.join(', ') || 'nothing' }}.
              <template v-if="plan.skipped.length">
                Skipped: {{ plan.skipped.join(', ') }}.
              </template>
              <template v-if="plan.restartRequired">
                The panel settings differ, so restart home-hosted afterwards.
              </template>
              <template v-else-if="restoringConfig">
                The restored servers are reloaded immediately; entries marked autostart start on their own.
              </template>
            </p>
          </template>
        </div>

        <p v-if="error" class="note note--error">
          {{ error }}
        </p>
      </div>

      <div class="group sheet__foot">
        <div class="actions">
          <button type="button" class="btn btn--sm" :disabled="busy" @click="emit('close')">
            cancel
          </button>
          <button
            v-if="plan && !needsPassword"
            type="button"
            class="btn btn--sm btn--danger"
            :disabled="!canApply"
            @click="apply"
          >
            {{ target.kind === 'stored' ? 'Apply this restore' : 'Restore the upload' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
