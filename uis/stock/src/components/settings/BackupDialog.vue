<script setup lang="ts">
import type { BackupsView } from '@shared/contracts'
import type { CaptureChoice } from '@/components/settings/backupSelection'
import { computed, ref, watch } from 'vue'
import { captureItems, includeIds } from '@/components/settings/backupSelection'
import Notice from '@/components/settings/Notice.vue'
import AppButton from '@/components/ui/AppButton.vue'
import CheckField from '@/components/ui/CheckField.vue'
import Modal from '@/components/ui/Modal.vue'
import TextField from '@/components/ui/TextField.vue'
import * as api from '@/lib/api'

const props = defineProps<{ state: BackupsView | null }>()
const emit = defineEmits<{ created: [message: string] }>()

const open = defineModel<boolean>('open', { default: false })

const busy = ref(false)
const error = ref<string | null>(null)
const password = ref('')
const choices = ref<CaptureChoice[]>([])

function rebuild(preserve: boolean): void {
  const previous = new Map(choices.value.map(choice => [choice.id, choice.selected]))
  choices.value = captureItems(props.state?.paths ?? []).map(item => ({
    ...item,
    selected: preserve ? previous.get(item.id) ?? true : true,
  }))
}

const selectedCount = computed(() => choices.value.filter(choice => choice.selected).length)
const configSelected = computed(() => choices.value.find(choice => choice.id === 'config')?.selected ?? false)
const canCreate = computed(() => props.state !== null && selectedCount.value > 0 && !busy.value)

watch(open, (isOpen) => {
  if (!isOpen)
    return
  password.value = ''
  error.value = null
  rebuild(false)
}, { immediate: true })

// The declared paths land after the first frame; keep whatever the person already ticked.
watch(() => props.state, () => {
  if (open.value)
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
    open.value = false
    emit('created', 'Backup created.')
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
  <Modal
    v-model:open="open"
    title="Create a backup"
    description="Pick what this archive captures. Nothing is written until you create it."
    width="w-[min(92vw,36rem)]"
  >
    <div class="space-y-3">
      <div class="flex items-center justify-between gap-2">
        <span class="text-xs font-medium text-muted">{{ selectedCount }} of {{ choices.length }} selected</span>
        <div class="flex items-center gap-1.5">
          <AppButton size="xs" variant="ghost" :disabled="busy" @click="selectAll(true)">
            Select all
          </AppButton>
          <AppButton size="xs" variant="ghost" :disabled="busy" @click="selectAll(false)">
            Select none
          </AppButton>
        </div>
      </div>

      <ul class="max-h-72 space-y-0.5 overflow-auto">
        <li v-for="choice in choices" :key="choice.id">
          <CheckField v-model="choice.selected" :label="choice.label" :hint="choice.hint" :disabled="busy" />
        </li>
      </ul>

      <Notice v-if="!configSelected" tone="warn">
        Without the config, a restore can only place data where the target instance already declares the same server.
      </Notice>

      <TextField
        v-model="password"
        type="password"
        autocomplete="new-password"
        label="Password (optional)"
        hint="Encrypts the archive; restoring it asks for the same password."
        wide
      />

      <Notice v-if="error" tone="danger">
        {{ error }}
      </Notice>
    </div>

    <template #footer>
      <AppButton size="sm" variant="ghost" :disabled="busy" @click="open = false">
        Cancel
      </AppButton>
      <AppButton size="sm" variant="primary" :disabled="!canCreate" :loading="busy" @click="submit">
        Create backup
      </AppButton>
    </template>
  </Modal>
</template>
