<script setup lang="ts">
import type { BackupsView } from '@shared/contracts'
import type { CaptureChoice } from '@/lib/backupSelection'
import { computed, ref, watch } from 'vue'
import * as api from '@/lib/api'
import { captureItems, includeIds } from '@/lib/backupSelection'

const props = defineProps<{ open: boolean, state: BackupsView | null }>()
const emit = defineEmits<{ close: [], done: [message: string] }>()

const busy = ref(false)
const error = ref<string | null>(null)
const password = ref('')
const choices = ref<CaptureChoice[]>([])

function rebuild(preserve: boolean): void {
  const previous = new Map(choices.value.map(choice => [choice.id, choice.selected]))
  choices.value = captureItems(props.state).map(item => ({
    ...item,
    selected: preserve ? previous.get(item.id) ?? true : true,
  }))
}

const selectedCount = computed(() => choices.value.filter(choice => choice.selected).length)
const configSelected = computed(() => choices.value.find(choice => choice.id === 'global:settings')?.selected ?? false)
const canCreate = computed(() => props.state !== null && selectedCount.value > 0 && !busy.value)

watch(() => props.open, (isOpen) => {
  if (!isOpen)
    return
  password.value = ''
  error.value = null
  rebuild(false)
}, { immediate: true })

// The declared paths land after the first frame; keep whatever was already ticked.
watch(() => props.state, () => {
  if (props.open)
    rebuild(true)
})

function selectAll(selected: boolean): void {
  for (const choice of choices.value) choice.selected = selected
}

async function submit(): Promise<void> {
  if (!canCreate.value)
    return
  busy.value = true
  error.value = null
  try {
    await api.createBackup(password.value, includeIds(choices.value))
    emit('done', 'backup created')
    emit('close')
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
  <div v-if="open" class="overlay" @click.self="emit('close')">
    <div class="overlay__panel overlay__panel--sheet dialog" role="dialog" aria-label="create a backup">
      <div class="overlay__head">
        <span class="overlay__title">create backup</span>
        <span class="view__spacer" />
        <span class="faint">{{ selectedCount }} of {{ choices.length }} selected</span>
        <kbd class="kbd">esc</kbd>
      </div>

      <div class="overlay__body">
        <div class="actions actions--start">
          <button type="button" class="btn btn--xs btn--ghost" :disabled="busy" @click="selectAll(true)">
            select all
          </button>
          <button type="button" class="btn btn--xs btn--ghost" :disabled="busy" @click="selectAll(false)">
            select none
          </button>
        </div>

        <div class="stack">
          <label v-for="choice in choices" :key="choice.id" class="field field--check">
            <input v-model="choice.selected" type="checkbox" :disabled="busy">
            <span class="field__label">
              {{ choice.label }}
              <em class="dim">— {{ choice.hint }}</em>
            </span>
          </label>
        </div>

        <p v-if="!configSelected" class="note note--warn">
          Without the config, a restore can only place data where the target instance already
          declares the same server.
        </p>

        <label class="field">
          <span class="field__label">password (optional)</span>
          <input v-model="password" type="password" autocomplete="new-password">
          <span class="field__hint">encrypts this archive only; restoring it asks for the same password</span>
        </label>

        <p v-if="error" class="note note--error">
          {{ error }}
        </p>
      </div>

      <div class="group sheet__foot">
        <div class="actions">
          <button type="button" class="btn btn--sm" :disabled="busy" @click="emit('close')">
            cancel
          </button>
          <button type="button" class="btn btn--sm btn--primary" :disabled="!canCreate" @click="submit">
            create backup
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
