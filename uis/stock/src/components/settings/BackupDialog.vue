<script setup lang="ts">
import type { BackupsView } from '@shared/contracts'
import type { EntryChoice } from '@/components/settings/backupSelection'
import { errorMessage } from '@shared/error-message'
import { computed, ref, watch } from 'vue'
import { captureEntries, includeIds, selectionCount } from '@/components/settings/backupSelection'
import CaptureTree from '@/components/settings/CaptureTree.vue'
import Notice from '@/components/settings/Notice.vue'
import AppButton from '@/components/ui/AppButton.vue'
import Modal from '@/components/ui/Modal.vue'
import TextField from '@/components/ui/TextField.vue'
import { t } from '@/i18n'
import * as api from '@/lib/api'

const props = defineProps<{ state: BackupsView | null }>()
const emit = defineEmits<{ created: [message: string] }>()

const open = defineModel<boolean>('open', { default: false })

const busy = ref(false)
const error = ref<string | null>(null)
const password = ref('')
const choices = ref<EntryChoice[]>([])

function rebuild(preserve: boolean): void {
  choices.value = captureEntries(props.state?.entries ?? [], preserve ? choices.value : [])
}

const counts = computed(() => selectionCount(choices.value))
const includesSettings = computed(() => choices.value.some(entry => entry.id === 'global:settings' && entry.selected))
const canCreate = computed(() => props.state !== null && counts.value.leaves > 0 && !busy.value)

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

async function submit(): Promise<void> {
  if (!canCreate.value)
    return
  busy.value = true
  error.value = null
  try {
    await api.createBackup(password.value, includeIds(choices.value))
    open.value = false
    emit('created', t('settings.backup.created'))
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
  <Modal
    v-model:open="open"
    :title="t('settings.backup.createTitle')"
    :description="t('settings.backup.createDescription')"
    width="w-[min(92vw,40rem)]"
  >
    <div class="space-y-3">
      <div class="max-h-80 overflow-auto">
        <CaptureTree :choices="choices" :disabled="busy" show-count />
      </div>

      <Notice v-if="!includesSettings" tone="warn">
        {{ t('settings.backup.withoutGlobalSettings') }}
      </Notice>

      <TextField
        v-model="password"
        type="password"
        autocomplete="new-password"
        :label="t('settings.backup.password')"
        :hint="t('settings.backup.passwordHint')"
        wide
      />

      <Notice v-if="error" tone="danger">
        {{ error }}
      </Notice>
    </div>

    <template #footer>
      <AppButton size="sm" variant="ghost" :disabled="busy" @click="open = false">
        {{ t('common.cancel') }}
      </AppButton>
      <AppButton size="sm" variant="primary" :disabled="!canCreate" :loading="busy" @click="submit">
        {{ t('settings.backup.create') }}
      </AppButton>
    </template>
  </Modal>
</template>
