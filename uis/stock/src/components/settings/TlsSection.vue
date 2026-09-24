<script setup lang="ts">
import type { ControlView } from '@shared/contracts'
import { computed, ref } from 'vue'
import ConfirmButton from '@/components/settings/ConfirmButton.vue'
import Notice from '@/components/settings/Notice.vue'
import { followRebinding } from '@/components/settings/settingsForm'
import AppButton from '@/components/ui/AppButton.vue'
import CopyButton from '@/components/ui/CopyButton.vue'
import FieldGroup from '@/components/ui/FieldGroup.vue'
import TextAreaField from '@/components/ui/TextAreaField.vue'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import ToneBadge from '@/components/ui/ToneBadge.vue'
import { useControlPlane } from '@/composables/useControlPlane'
import * as api from '@/lib/api'
import { cn } from '@/lib/cn'
import { inputClass, labelClass } from '@/lib/ui'

const props = defineProps<{
  view: ControlView | null
  dirty: boolean
}>()

const emit = defineEmits<{ reset: [] }>()

const enabled = defineModel<boolean>('tlsEnabled', { required: true })

const control = useControlPlane()

const certInput = ref('')
const keyInput = ref('')
const message = ref<string | null>(null)
const error = ref<string | null>(null)
const busy = ref(false)

const tls = computed(() => props.view?.tls ?? null)
const liveAddress = computed(() => (props.view ? `${props.view.protocol}://${props.view.bindHost}:${props.view.port}` : '—'))
const canSave = computed(() => certInput.value.trim().length > 0 && keyInput.value.trim().length > 0 && !busy.value)

const fileInput = cn(
  inputClass,
  'cursor-pointer text-xs',
  'file:mr-2 file:cursor-pointer file:rounded-control file:border-0 file:bg-panel-2 file:px-2 file:py-1 file:text-xs file:text-ink',
)

async function readFileInto(event: Event, target: 'cert' | 'key'): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file)
    return
  const text = await file.text()
  if (target === 'cert')
    certInput.value = text
  else keyInput.value = text
}

async function uploadCertificate(): Promise<void> {
  busy.value = true
  error.value = null
  message.value = null
  try {
    const result = await api.uploadTls(certInput.value, keyInput.value)
    certInput.value = ''
    keyInput.value = ''
    message.value = 'Certificate stored.'
    await control.refresh()
    const failure = await followRebinding(result)
    if (failure !== null)
      error.value = failure
  }
  catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  }
  finally {
    busy.value = false
  }
}

async function removeCertificate(): Promise<void> {
  busy.value = true
  error.value = null
  message.value = null
  try {
    const result = await api.clearTls()
    message.value = 'Certificate removed.'
    await control.refresh()
    const failure = await followRebinding(result)
    if (failure !== null)
      error.value = failure
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
  <FieldGroup
    title="HTTPS"
    description="Upload a PEM pair and the panel serves TLS on its own listener. A self-signed certificate is fine on a home network."
  >
    <template #actions>
      <AppButton size="xs" variant="ghost" :disabled="!props.dirty" @click="emit('reset')">
        Reset
      </AppButton>
    </template>

    <ToggleSwitch
      v-model="enabled"
      label="Serve the panel over HTTPS"
      hint="Saved with Save settings; the panel rebinds and this page follows it."
      class="sm:col-span-2"
    />

    <div class="flex min-w-0 flex-col gap-1 sm:col-span-2">
      <span class="text-xs font-medium text-muted">Live address</span>
      <div class="flex items-center gap-1.5 rounded-control border border-line bg-page/60 px-2.5 py-1.5">
        <span class="min-w-0 flex-1 truncate font-mono text-xs text-ink">{{ liveAddress }}</span>
        <CopyButton :value="liveAddress" label="Copy the live address" />
      </div>
    </div>
  </FieldGroup>

  <FieldGroup class="mt-3" title="Certificate" description="PEM-encoded certificate and its private key. Both stay in the secrets file.">
    <div v-if="tls?.error" class="sm:col-span-2">
      <Notice tone="danger" title="The stored certificate cannot be used">
        {{ tls.error }}
      </Notice>
    </div>
    <div v-else-if="tls?.certPresent" class="space-y-3 sm:col-span-2">
      <dl class="divide-y divide-line-soft text-xs">
        <div class="flex items-start justify-between gap-4 py-1.5">
          <dt class="text-muted">
            Subject
          </dt>
          <dd class="min-w-0 text-right font-mono text-xs text-ink">
            {{ tls.subject ?? '—' }}
          </dd>
        </div>
        <div class="flex items-start justify-between gap-4 py-1.5">
          <dt class="text-muted">
            Issuer
          </dt>
          <dd class="min-w-0 text-right font-mono text-xs text-ink">
            {{ tls.issuer ?? '—' }}
          </dd>
        </div>
        <div class="flex items-start justify-between gap-4 py-1.5">
          <dt class="text-muted">
            Valid until
          </dt>
          <dd class="font-mono text-xs tabular-nums text-ink">
            {{ tls.validTo ? tls.validTo.slice(0, 10) : '—' }}
            <span v-if="tls.daysRemaining !== null" :class="cn('ml-1.5', tls.daysRemaining < 14 ? 'text-warn' : 'text-faint')">
              ({{ tls.daysRemaining }} days)
            </span>
          </dd>
        </div>
        <div class="flex items-center justify-between gap-4 py-1.5">
          <dt class="text-muted">
            Private key
          </dt>
          <dd>
            <ToneBadge :tone="tls.keyMatches ? 'ok' : 'danger'" dot>
              {{ tls.keyMatches ? 'matches the certificate' : 'does not match' }}
            </ToneBadge>
          </dd>
        </div>
        <div class="flex items-start justify-between gap-4 py-1.5">
          <dt class="text-muted">
            Fingerprint
          </dt>
          <dd class="flex min-w-0 items-center gap-1.5">
            <span class="min-w-0 truncate font-mono text-2xs text-ink">{{ tls.fingerprint ?? '—' }}</span>
            <CopyButton v-if="tls.fingerprint" :value="tls.fingerprint" label="Copy the fingerprint" />
          </dd>
        </div>
      </dl>
    </div>
    <div v-else class="sm:col-span-2">
      <Notice tone="info" title="No certificate uploaded">
        Upload a PEM certificate and key below, then save. HTTPS is not served until a certificate is present.
      </Notice>
    </div>

    <div class="flex min-w-0 flex-col gap-1">
      <label :class="labelClass" for="tls-cert-file">Certificate file (.pem, .crt)</label>
      <input id="tls-cert-file" type="file" accept=".pem,.crt,.cer,text/plain" :class="fileInput" @change="readFileInto($event, 'cert')">
    </div>
    <div class="flex min-w-0 flex-col gap-1">
      <label :class="labelClass" for="tls-key-file">Private key file (.pem, .key)</label>
      <input id="tls-key-file" type="file" accept=".pem,.key,text/plain" :class="fileInput" @change="readFileInto($event, 'key')">
    </div>
    <TextAreaField v-model="certInput" label="Or paste the certificate" :rows="4" placeholder="-----BEGIN CERTIFICATE-----" />
    <TextAreaField v-model="keyInput" label="Or paste the private key" :rows="4" placeholder="-----BEGIN PRIVATE KEY-----" />

    <div class="flex flex-wrap items-center gap-2 sm:col-span-2">
      <AppButton variant="primary" :disabled="!canSave" :loading="busy" @click="uploadCertificate">
        Save certificate
      </AppButton>
      <ConfirmButton
        v-if="tls?.certPresent"
        label="Remove certificate"
        confirm-label="Confirm remove"
        confirm-variant="danger"
        :disabled="busy"
        @confirm="removeCertificate"
      />
    </div>

    <div v-if="error || message" class="space-y-2 sm:col-span-2">
      <Notice v-if="error" tone="danger">
        {{ error }}
      </Notice>
      <Notice v-if="message" tone="ok">
        {{ message }}
      </Notice>
    </div>
  </FieldGroup>
</template>
