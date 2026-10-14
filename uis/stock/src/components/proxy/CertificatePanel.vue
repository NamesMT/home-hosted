<script setup lang="ts">
import type { ProxyCertificateView, ProxyView } from '@shared/contracts'
import { errorMessage } from '@shared/error-message'
import { KeyRound, Plus, Trash2 } from 'lucide-vue-next'
import { PopoverClose, PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui'
import { computed, ref } from 'vue'
import CertificateDialog from '@/components/proxy/CertificateDialog.vue'
import Notice from '@/components/settings/Notice.vue'
import AppButton from '@/components/ui/AppButton.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import FieldGroup from '@/components/ui/FieldGroup.vue'
import { t } from '@/i18n'
import * as api from '@/lib/api'
import { cn } from '@/lib/cn'
import { certificateTitle } from '@/lib/proxy'

/**
 * The pairs routes with `tls: "manual"` serve. A pair is a file on disk, so
 * adding and removing one writes through its own endpoint — the page's Save has
 * nothing to do with it.
 */
const props = defineProps<{
  certificates: ProxyCertificateView[]
  disabled: boolean
}>()

const emit = defineEmits<{ changed: [view: ProxyView] }>()

const dialogOpen = ref(false)
const busy = ref(false)
const error = ref<string | null>(null)
const message = ref<string | null>(null)
const confirming = ref<string | null>(null)

const taken = computed(() => props.certificates.map(certificate => certificate.id))

async function run(action: () => Promise<ProxyView>, done: string): Promise<boolean> {
  busy.value = true
  error.value = null
  message.value = null
  try {
    emit('changed', await action())
    message.value = done
    return true
  }
  catch (caught) {
    error.value = errorMessage(caught)
    return false
  }
  finally {
    busy.value = false
  }
}

async function add(payload: { id: string, label: string, certificate: string, privateKey: string }): Promise<void> {
  const stored = await run(
    () => api.uploadProxyCertificate(payload.id, payload.label, payload.certificate, payload.privateKey),
    t('proxy.certificate.stored', { label: payload.label }),
  )
  if (stored)
    dialogOpen.value = false
}

function remove(certificate: ProxyCertificateView): void {
  confirming.value = null
  void run(() => api.clearProxyCertificate(certificate.id), t('proxy.certificate.removed', { name: certificateTitle(certificate) }))
}
</script>

<template>
  <FieldGroup
    :title="t('proxy.certificate.title')"
    :description="t('proxy.certificate.description')"
  >
    <template #actions>
      <AppButton size="xs" variant="secondary" :disabled="props.disabled || busy" @click="dialogOpen = true">
        <Plus class="size-3.5" />
        {{ t('proxy.certificate.add') }}
      </AppButton>
    </template>

    <div v-if="props.certificates.length === 0" class="sm:col-span-2">
      <EmptyState
        compact
        :title="t('proxy.certificate.emptyTitle')"
        :description="t('proxy.certificate.emptyDescription')"
      >
        <template #icon>
          <KeyRound class="size-5" />
        </template>
        <template #action>
          <AppButton variant="primary" :disabled="props.disabled || busy" @click="dialogOpen = true">
            {{ t('proxy.certificateDialog.title') }}
          </AppButton>
        </template>
      </EmptyState>
    </div>

    <ul v-else class="space-y-2 sm:col-span-2">
      <li
        v-for="certificate in props.certificates"
        :key="certificate.id"
        class="rounded-panel border border-line bg-page/40 p-3"
      >
        <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p class="min-w-0 text-xs font-medium text-ink">
            {{ certificateTitle(certificate) }}
            <span class="ml-1.5 font-mono text-2xs text-faint">{{ certificate.id }}</span>
          </p>
          <span
            v-if="certificate.daysRemaining !== null"
            class="text-2xs tabular-nums"
            :class="certificate.daysRemaining < 14 ? 'text-warn' : 'text-faint'"
          >
            {{ t('proxy.certificate.daysLeft', { days: certificate.daysRemaining }) }}
          </span>
        </div>

        <div v-if="certificate.error" class="mt-2">
          <Notice tone="danger">
            {{ certificate.error }}
          </Notice>
        </div>

        <dl v-else class="mt-2 divide-y divide-line-soft text-2xs">
          <div class="flex items-start justify-between gap-4 py-1">
            <dt class="text-muted">
              {{ t('proxy.certificate.subject') }}
            </dt>
            <dd class="min-w-0 text-right font-mono text-ink">
              {{ certificate.subject ?? '—' }}
            </dd>
          </div>
          <div class="flex items-start justify-between gap-4 py-1">
            <dt class="text-muted">
              {{ t('proxy.certificate.issuer') }}
            </dt>
            <dd class="min-w-0 text-right font-mono text-ink">
              {{ certificate.issuer ?? '—' }}
            </dd>
          </div>
          <div class="flex items-start justify-between gap-4 py-1">
            <dt class="text-muted">
              {{ t('proxy.certificate.validUntil') }}
            </dt>
            <dd class="font-mono text-ink">
              {{ certificate.validTo ? certificate.validTo.slice(0, 10) : '—' }}
            </dd>
          </div>
          <div class="flex items-start justify-between gap-4 py-1">
            <dt class="shrink-0 text-muted">
              {{ t('proxy.certificate.covers') }}
            </dt>
            <dd class="min-w-0 text-right font-mono text-ink">
              <template v-if="certificate.hosts.length > 0">
                {{ certificate.hosts.join(', ') }}
              </template>
              <span v-else class="text-faint">{{ t('proxy.certificate.noSans') }}</span>
            </dd>
          </div>
        </dl>

        <div class="mt-2 flex justify-end">
          <PopoverRoot :open="confirming === certificate.id" @update:open="value => confirming = value ? certificate.id : null">
            <PopoverTrigger as-child>
              <AppButton size="xs" variant="danger-ghost" :disabled="busy" :aria-label="t('proxy.certificate.removeAria', { name: certificateTitle(certificate) })">
                <Trash2 class="size-3.5" />
                {{ t('common.remove') }}
              </AppButton>
            </PopoverTrigger>
            <PopoverPortal>
              <PopoverContent
                :side-offset="6"
                align="end"
                :class="cn(
                  'z-50 w-64 rounded-panel border border-line bg-raise p-3 shadow-float',
                  'focus-visible:outline-none data-[state=open]:animate-[hh-fade-in_120ms_ease-out]',
                )"
              >
                <p class="text-xs font-semibold text-ink">
                  {{ t('proxy.certificate.removeQuestion', { name: certificateTitle(certificate) }) }}
                </p>
                <p class="mt-1 text-2xs leading-4 text-muted">
                  {{ t('proxy.certificate.removeBody') }}
                </p>
                <div class="mt-2.5 flex justify-end gap-1.5">
                  <PopoverClose as-child>
                    <AppButton size="xs" variant="ghost">
                      {{ t('common.keepIt') }}
                    </AppButton>
                  </PopoverClose>
                  <AppButton size="xs" variant="danger" :loading="busy" @click="remove(certificate)">
                    {{ t('proxy.certificate.removeIt') }}
                  </AppButton>
                </div>
              </PopoverContent>
            </PopoverPortal>
          </PopoverRoot>
        </div>
      </li>
    </ul>

    <div v-if="error || message" class="space-y-2 sm:col-span-2">
      <Notice v-if="error" tone="danger">
        {{ error }}
      </Notice>
      <Notice v-if="message" tone="ok">
        {{ message }}
      </Notice>
    </div>

    <CertificateDialog
      v-model:open="dialogOpen"
      :taken="taken"
      :busy="busy"
      :error="error"
      @submit="add"
    />
  </FieldGroup>
</template>
