<script setup lang="ts">
import type { CertificateErrors } from '@/lib/proxy'
import { computed, nextTick, onScopeDispose, ref, watch } from 'vue'
import { ROUTE_ID_PATTERN, slugifyCertificateId, uniqueCertificateId } from '@/lib/proxy'

/** One pair, added to the list. The upload is the page's call, not this sheet's. */
const props = defineProps<{
  open: boolean
  /** Ids already taken; the suggested id steps around them. */
  taken: string[]
  busy: boolean
  error: string | null
}>()

const emit = defineEmits<{
  close: []
  submit: [payload: { id: string, label: string, certificate: string, privateKey: string }]
}>()

const label = ref('')
const id = ref('')
const certificate = ref('')
const privateKey = ref('')
const errors = ref<CertificateErrors>({})
const idTouched = ref(false)
const labelField = ref<HTMLInputElement | null>(null)

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

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape')
    emit('close')
}

watch(() => props.open, async (open) => {
  if (!open) {
    window.removeEventListener('keydown', onKey)
    return
  }
  label.value = ''
  id.value = ''
  certificate.value = ''
  privateKey.value = ''
  errors.value = {}
  idTouched.value = false
  window.addEventListener('keydown', onKey)
  await nextTick()
  labelField.value?.focus()
})

onScopeDispose(() => window.removeEventListener('keydown', onKey))

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
    problems.id = 'an id of letters, digits, dash or underscore'
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
  <div v-if="props.open" class="overlay" @click.self="emit('close')">
    <div class="overlay__panel overlay__panel--sheet dialog" role="dialog" aria-label="certificate">
      <div class="overlay__head">
        <span class="overlay__title">add certificate</span>
        <span class="view__spacer" />
        <span class="faint">a pair a route set to “uploaded certificate” can serve</span>
        <kbd class="kbd">esc</kbd>
      </div>

      <form class="sheet__form" @submit.prevent="submit">
        <div class="overlay__body">
          <div class="grid">
            <label class="field">
              <span class="field__label">label</span>
              <input ref="labelField" v-model="label" placeholder="home wildcard" spellcheck="false" required>
              <span v-if="errors.label" class="field__hint danger">{{ errors.label }}</span>
            </label>

            <label class="field">
              <span class="field__label">id</span>
              <input :value="id" spellcheck="false" @input="typedId(($event.target as HTMLInputElement).value)">
              <span v-if="errors.id" class="field__hint danger">{{ errors.id }}</span>
              <span v-else class="field__hint">names the files on disk</span>
            </label>

            <label class="field">
              <span class="field__label">certificate file (.pem, .crt)</span>
              <input type="file" accept=".pem,.crt,.cer,text/plain" @change="readFileInto($event, 'cert')">
            </label>

            <label class="field">
              <span class="field__label">private key file (.pem, .key)</span>
              <input type="file" accept=".pem,.key,text/plain" @change="readFileInto($event, 'key')">
            </label>

            <label class="field grid__full">
              <span class="field__label">or paste the certificate</span>
              <textarea v-model="certificate" rows="3" spellcheck="false" placeholder="-----BEGIN CERTIFICATE-----" />
              <span v-if="errors.certificate" class="field__hint danger">{{ errors.certificate }}</span>
            </label>

            <label class="field grid__full">
              <span class="field__label">or paste the private key</span>
              <textarea v-model="privateKey" rows="3" spellcheck="false" placeholder="-----BEGIN PRIVATE KEY-----" />
              <span v-if="errors.privateKey" class="field__hint danger">{{ errors.privateKey }}</span>
            </label>
          </div>

          <p v-if="props.error" class="note note--error">
            {{ props.error }}
          </p>
        </div>

        <div class="group sheet__foot">
          <div class="actions">
            <button type="button" class="btn btn--sm" @click="emit('close')">
              cancel
            </button>
            <button type="submit" class="btn btn--sm btn--primary" :disabled="!canSubmit">
              {{ props.busy ? 'storing…' : 'store certificate' }}
            </button>
          </div>
        </div>
      </form>
    </div>
  </div>
</template>
