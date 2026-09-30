<script setup lang="ts">
import type { ProxyView, TlsStatus } from '@shared/contracts'
import { PopoverClose, PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui'
import { computed, ref } from 'vue'
import Notice from '@/components/settings/Notice.vue'
import AppButton from '@/components/ui/AppButton.vue'
import CopyButton from '@/components/ui/CopyButton.vue'
import FieldGroup from '@/components/ui/FieldGroup.vue'
import TextAreaField from '@/components/ui/TextAreaField.vue'
import ToneBadge from '@/components/ui/ToneBadge.vue'
import * as api from '@/lib/api'
import { cn } from '@/lib/cn'
import { inputClass, labelClass } from '@/lib/ui'

/**
 * The PEM pair routes with `tls: "manual"` serve. Nothing else on the page needs
 * it, so the section stands on its own and writes through its own endpoint.
 */
const props = defineProps<{
  tls: TlsStatus | null
}>()

const emit = defineEmits<{ changed: [view: ProxyView] }>()

const certInput = ref('')
const keyInput = ref('')
const busy = ref(false)
const error = ref<string | null>(null)
const message = ref<string | null>(null)
const confirming = ref(false)

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

async function run(action: () => Promise<ProxyView>, done: string): Promise<void> {
  busy.value = true
  error.value = null
  message.value = null
  try {
    emit('changed', await action())
    certInput.value = ''
    keyInput.value = ''
    message.value = done
  }
  catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  }
  finally {
    busy.value = false
  }
}

function removeCertificate(): void {
  confirming.value = false
  void run(() => api.clearProxyTls(), 'Certificate removed.')
}
</script>

<template>
  <FieldGroup
    title="Manual certificate"
    description="Served by routes set to “Uploaded certificate”. Everything else — public or local — is certified by the engine on its own."
  >
    <div v-if="props.tls?.error" class="sm:col-span-2">
      <Notice tone="danger" title="The stored certificate cannot be used">
        {{ props.tls.error }}
      </Notice>
    </div>

    <div v-else-if="props.tls?.certPresent" class="space-y-3 sm:col-span-2">
      <dl class="divide-y divide-line-soft text-xs">
        <div class="flex items-start justify-between gap-4 py-1.5">
          <dt class="text-muted">
            Subject
          </dt>
          <dd class="min-w-0 text-right font-mono text-xs text-ink">
            {{ props.tls.subject ?? '—' }}
          </dd>
        </div>
        <div class="flex items-start justify-between gap-4 py-1.5">
          <dt class="text-muted">
            Issuer
          </dt>
          <dd class="min-w-0 text-right font-mono text-xs text-ink">
            {{ props.tls.issuer ?? '—' }}
          </dd>
        </div>
        <div class="flex items-start justify-between gap-4 py-1.5">
          <dt class="text-muted">
            Valid until
          </dt>
          <dd class="font-mono text-xs tabular-nums text-ink">
            {{ props.tls.validTo ? props.tls.validTo.slice(0, 10) : '—' }}
            <span v-if="props.tls.daysRemaining !== null" :class="cn('ml-1.5', props.tls.daysRemaining < 14 ? 'text-warn' : 'text-faint')">
              ({{ props.tls.daysRemaining }} days)
            </span>
          </dd>
        </div>
        <div class="flex items-center justify-between gap-4 py-1.5">
          <dt class="text-muted">
            Private key
          </dt>
          <dd>
            <ToneBadge :tone="props.tls.keyMatches ? 'ok' : 'danger'" dot>
              {{ props.tls.keyMatches ? 'matches the certificate' : 'does not match' }}
            </ToneBadge>
          </dd>
        </div>
        <div class="flex items-start justify-between gap-4 py-1.5">
          <dt class="text-muted">
            Fingerprint
          </dt>
          <dd class="flex min-w-0 items-center gap-1.5">
            <span class="min-w-0 truncate font-mono text-2xs text-ink">{{ props.tls.fingerprint ?? '—' }}</span>
            <CopyButton v-if="props.tls.fingerprint" :value="props.tls.fingerprint" label="Copy the fingerprint" />
          </dd>
        </div>
      </dl>
    </div>

    <div v-else class="sm:col-span-2">
      <Notice tone="info" title="No certificate uploaded">
        A route set to “Uploaded certificate” serves nothing until a pair is stored here.
      </Notice>
    </div>

    <div class="flex min-w-0 flex-col gap-1">
      <label :class="labelClass" for="proxy-tls-cert">Certificate file (.pem, .crt)</label>
      <input id="proxy-tls-cert" type="file" accept=".pem,.crt,.cer,text/plain" :class="fileInput" @change="readFileInto($event, 'cert')">
    </div>
    <div class="flex min-w-0 flex-col gap-1">
      <label :class="labelClass" for="proxy-tls-key">Private key file (.pem, .key)</label>
      <input id="proxy-tls-key" type="file" accept=".pem,.key,text/plain" :class="fileInput" @change="readFileInto($event, 'key')">
    </div>
    <TextAreaField v-model="certInput" label="Or paste the certificate" :rows="4" placeholder="-----BEGIN CERTIFICATE-----" />
    <TextAreaField v-model="keyInput" label="Or paste the private key" :rows="4" placeholder="-----BEGIN PRIVATE KEY-----" />

    <div class="flex flex-wrap items-center gap-2 sm:col-span-2">
      <AppButton variant="primary" :disabled="!canSave" :loading="busy" @click="run(() => api.uploadProxyTls(certInput, keyInput), 'Certificate stored.')">
        Save certificate
      </AppButton>

      <PopoverRoot v-if="props.tls?.certPresent" v-model:open="confirming">
        <PopoverTrigger as-child>
          <AppButton variant="danger-ghost" :disabled="busy">
            Remove certificate
          </AppButton>
        </PopoverTrigger>
        <PopoverPortal>
          <PopoverContent
            :side-offset="6"
            align="start"
            class="z-50 w-64 rounded-panel border border-line bg-raise p-3 shadow-float focus-visible:outline-none data-[state=open]:animate-[hh-fade-in_120ms_ease-out]"
          >
            <p class="text-xs font-semibold text-ink">
              Remove the stored certificate?
            </p>
            <p class="mt-1 text-2xs leading-4 text-muted">
              Routes set to “Uploaded certificate” stop serving HTTPS until a pair is stored again.
              Certificates the engine manages itself are untouched.
            </p>
            <div class="mt-2.5 flex justify-end gap-1.5">
              <PopoverClose as-child>
                <AppButton size="xs" variant="ghost">
                  Keep it
                </AppButton>
              </PopoverClose>
              <AppButton size="xs" variant="danger" :loading="busy" @click="removeCertificate">
                Remove it
              </AppButton>
            </div>
          </PopoverContent>
        </PopoverPortal>
      </PopoverRoot>
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
