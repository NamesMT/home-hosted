<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import AppButton from '@/components/ui/AppButton.vue'
import Modal from '@/components/ui/Modal.vue'
import TextField from '@/components/ui/TextField.vue'

const props = withDefaults(defineProps<{
  mode: 'create' | 'rename'
  /** The current label, when renaming. */
  initial?: string
  /** Resolves true when the change landed, so the dialog can close itself. */
  submit: (label: string) => Promise<boolean>
}>(), {
  initial: '',
})

const open = defineModel<boolean>('open', { default: false })

const label = ref(props.initial)
const busy = ref(false)
const error = ref<string | null>(null)

const title = computed(() => (props.mode === 'create' ? 'New workspace' : 'Rename workspace'))
const action = computed(() => (props.mode === 'create' ? 'Create workspace' : 'Rename'))

/** What the panel would derive the id from, so the URL part is never a surprise. */
const derivedId = computed(() => label.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40))

watch(open, (isOpen) => {
  if (isOpen) {
    label.value = props.initial
    error.value = null
  }
})

async function submit(): Promise<void> {
  const value = label.value.trim()
  if (value.length === 0) {
    error.value = 'A workspace needs a name.'
    return
  }
  busy.value = true
  error.value = null
  try {
    if (await props.submit(value))
      open.value = false
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <Modal
    v-model:open="open"
    :title="title"
    :description="mode === 'create'
      ? 'Its own settings, servers, logs, secrets and backups entry — served by this same panel.'
      : 'Only the name changes; the workspace id stays, so URLs and paths keep working.'"
    width="w-[min(92vw,26rem)]"
  >
    <div class="space-y-3">
      <TextField
        v-model="label"
        label="Name"
        placeholder="Home lab"
        :hint="mode === 'create' && derivedId.length > 0 ? `Shown in the header. Id: ${derivedId}` : 'Shown in the header.'"
        wide
        @keydown.enter.prevent="submit"
      />

      <p v-if="error" class="rounded-control border border-danger/40 bg-danger-soft px-2.5 py-1.5 text-2xs leading-4 text-danger">
        {{ error }}
      </p>
    </div>

    <template #footer>
      <AppButton variant="ghost" :disabled="busy" @click="open = false">
        Cancel
      </AppButton>
      <AppButton variant="primary" :loading="busy" @click="submit">
        {{ action }}
      </AppButton>
    </template>
  </Modal>
</template>
