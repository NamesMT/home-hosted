<script setup lang="ts">
import type { CertificateErrors } from '@/lib/proxy'
import { computed, ref, watch } from 'vue'
import Notice from '@/components/settings/Notice.vue'
import AppButton from '@/components/ui/AppButton.vue'
import Modal from '@/components/ui/Modal.vue'
import TextAreaField from '@/components/ui/TextAreaField.vue'
import TextField from '@/components/ui/TextField.vue'
import { cn } from '@/lib/cn'
import { ROUTE_ID_PATTERN, slugifyCertificateId, uniqueCertificateId } from '@/lib/proxy'
import { inputClass, labelClass } from '@/lib/ui'

/** One pair, added to the list. The upload is the page's call, not this form's. */
const props = defineProps<{
  /** Ids already taken; the suggested id steps around them. */
  taken: string[]
  busy: boolean
  error: string | null
}>()

const emit = defineEmits<{
  submit: [payload: { id: string, label: string, certificate: string, privateKey: string }]
}>()

const open = defineModel<boolean>('open', { default: false })

const label = ref('')
const id = ref('')
const certificate = ref('')
const privateKey = ref('')
const errors = ref<CertificateErrors>({})
/** The id follows the label until somebody types one of their own. */
const idTouched = ref(false)

const fileInput = cn(
  inputClass,
  'cursor-pointer text-xs',
  'file:mr-2 file:cursor-pointer file:rounded-control file:border-0 file:bg-panel-2 file:px-2 file:py-1 file:text-xs file:text-ink',
)

const suggestedId = computed(() => uniqueCertificateId(slugifyCertificateId(label.value), props.taken))
const canSubmit = computed(() => !props.busy && label.value.trim().length > 0 && certificate.value.trim().length > 0 && privateKey.value.trim().length > 0)

/** The id follows the label until somebody types one; clearing it hands it back. */
function typedId(value: string): void {
  id.value = value
  idTouched.value = value.trim().length > 0
}

watch([label, () => props.taken], () => {
  if (!idTouched.value)
    id.value = suggestedId.value
}, { immediate: true })

watch(open, (isOpen) => {
  if (!isOpen)
    return
  label.value = ''
  id.value = ''
  certificate.value = ''
  privateKey.value = ''
  errors.value = {}
  idTouched.value = false
})

async function readFileInto(event: Event, target: 'cert' | 'key'): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file)
    return
  const text = await file.text()
  if (target === 'cert')
    certificate.value = text
  else privateKey.value = text
}

function submit(): void {
  const name = label.value.trim()
  const chosen = id.value.trim()
  const problems: CertificateErrors = {}
  if (name.length === 0)
    problems.label = 'a label is required'
  if (!ROUTE_ID_PATTERN.test(chosen))
    problems.id = 'the id must start with a letter or digit, then letters, digits, dash or underscore'
  else if (props.taken.includes(chosen))
    problems.id = `"${chosen}" is already used by another certificate`
  if (certificate.value.trim().length === 0)
    problems.certificate = 'paste or choose the certificate'
  if (privateKey.value.trim().length === 0)
    problems.privateKey = 'paste or choose the private key'

  errors.value = problems
  if (Object.keys(problems).length > 0)
    return

  emit('submit', { id: chosen, label: name, certificate: certificate.value, privateKey: privateKey.value })
}
</script>

<template>
  <Modal
    v-model:open="open"
    title="Add a certificate"
    description="The pair is stored on disk under its id, and a route set to “Uploaded certificate” can serve it."
  >
    <form class="space-y-3" @submit.prevent="submit">
      <div class="grid gap-3 sm:grid-cols-2">
        <TextField v-model="label" label="Label" placeholder="Home wildcard" :error="errors.label" />
        <TextField :model-value="id" label="Id" hint="names the files on disk" :error="errors.id" @update:model-value="typedId" />
      </div>

      <div class="grid gap-3 sm:grid-cols-2">
        <div class="flex min-w-0 flex-col gap-1">
          <label :class="labelClass" for="proxy-cert-file">Certificate file (.pem, .crt)</label>
          <input id="proxy-cert-file" type="file" accept=".pem,.crt,.cer,text/plain" :class="fileInput" @change="readFileInto($event, 'cert')">
        </div>
        <div class="flex min-w-0 flex-col gap-1">
          <label :class="labelClass" for="proxy-cert-key">Private key file (.pem, .key)</label>
          <input id="proxy-cert-key" type="file" accept=".pem,.key,text/plain" :class="fileInput" @change="readFileInto($event, 'key')">
        </div>
      </div>

      <TextAreaField v-model="certificate" label="Or paste the certificate" :rows="4" placeholder="-----BEGIN CERTIFICATE-----" :error="errors.certificate" />
      <TextAreaField v-model="privateKey" label="Or paste the private key" :rows="4" placeholder="-----BEGIN PRIVATE KEY-----" :error="errors.privateKey" />

      <Notice v-if="props.error" tone="danger">
        {{ props.error }}
      </Notice>
    </form>

    <template #footer>
      <AppButton variant="ghost" :disabled="props.busy" @click="open = false">
        Cancel
      </AppButton>
      <AppButton variant="primary" :disabled="!canSubmit" :loading="props.busy" @click="submit">
        Store the certificate
      </AppButton>
    </template>
  </Modal>
</template>
