<script setup lang="ts">
import type { DdnsAccount, DdnsConfig, DdnsProviderInfo, DdnsRecordState, DdnsRecordType } from '@shared/contracts'
import type { DraftAccount, DraftConfig, DraftDomain } from '@/lib/ddns'
import type { Tone } from '@/lib/status'
import { errorMessage } from '@shared/error-message'
import { computed, onMounted, reactive, ref, watch } from 'vue'
import ConfirmButton from '@/components/settings/ConfirmButton.vue'
import Notice from '@/components/settings/Notice.vue'
import AppButton from '@/components/ui/AppButton.vue'
import CheckField from '@/components/ui/CheckField.vue'
import Disclosure from '@/components/ui/Disclosure.vue'
import FieldGroup from '@/components/ui/FieldGroup.vue'
import Modal from '@/components/ui/Modal.vue'
import NumberField from '@/components/ui/NumberField.vue'
import SelectField from '@/components/ui/SelectField.vue'
import TextField from '@/components/ui/TextField.vue'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import ToneBadge from '@/components/ui/ToneBadge.vue'
import { useControlPlane } from '@/composables/useControlPlane'
import { useToasts } from '@/composables/useToasts'
import { useWorkspaces } from '@/composables/useWorkspaces'
import { t, tc } from '@/i18n'
import * as api from '@/lib/api'
import { cloneDdnsConfig, ddnsConfigEquals, newDraftDomainKey, requiredDdnsNumber, toDdnsConfig } from '@/lib/ddns'
import { formatAgo } from '@/lib/format'

/**
 * The policy is part of the page's patch, so the settings Save owns it. Only the
 * credentials keep an endpoint of their own — they are a secret, like the bot token.
 */
const patch = defineModel<DdnsConfig | null>('patch', { default: null })
const baseline = defineModel<DraftConfig | null>('baseline', { default: null })

/** A catalog key, not the text: the label is read at render time, in the viewer's language. */
const RECORD_STATE: Record<DdnsRecordState, { labelKey: string, tone: Tone }> = {
  pending: { labelKey: 'settings.ddns.statePending', tone: 'neutral' },
  ok: { labelKey: 'settings.ddns.stateOk', tone: 'ok' },
  unchanged: { labelKey: 'settings.ddns.stateUnchanged', tone: 'neutral' },
  skipped: { labelKey: 'settings.ddns.stateSkipped', tone: 'warn' },
  error: { labelKey: 'settings.ddns.stateError', tone: 'danger' },
}

const control = useControlPlane()
const workspace = useWorkspaces()
const toasts = useToasts()

const view = ref<Awaited<ReturnType<typeof api.fetchDdns>> | null>(null)
const draft = ref<DraftConfig | null>(null)
const loadError = ref<string | null>(null)
const actionError = ref<string | null>(null)
const checking = ref(false)

const newAccount = reactive({ id: '', provider: 'cloudflare' })
const newDomain = reactive({ host: '', account: '' })

const credentialAccount = ref<DdnsAccount | null>(null)
const credentialDraft = ref<Record<string, string>>({})
const credentialBusy = ref(false)
const credentialError = ref<string | null>(null)

const providers = computed<DdnsProviderInfo[]>(() => view.value?.providers ?? [])
const accounts = computed<DraftAccount[]>(() => draft.value?.accounts ?? [])
const domains = computed<DraftDomain[]>(() => draft.value?.domains ?? [])
const accountIds = computed(() => accounts.value.map(account => account.id).join(','))

const providerOptions = computed(() => providers.value.map(provider => ({ value: provider.id, label: provider.label })))
const accountOptions = computed(() => accounts.value.map(account => ({ value: account.id, label: account.id })))

/** Live state from the SSE frame; the fetch is only the fallback before one lands. */
const status = computed(() => workspace.selected.value?.ddns ?? view.value?.status ?? null)

const dirty = computed(() => draft.value !== null && baseline.value !== null && !ddnsConfigEquals(draft.value, baseline.value))
const canAddAccount = computed(() => /^[a-z0-9][a-z0-9_-]*$/.test(newAccount.id) && !accounts.value.some(account => account.id === newAccount.id))
const canAddDomain = computed(() => newDomain.host.includes('.') && newDomain.account.length > 0 && !domains.value.some(domain => domain.host.toLowerCase() === newDomain.host.trim().toLowerCase()))

const credentialsOpen = computed({
  get: () => credentialAccount.value !== null,
  set: (value: boolean) => {
    if (!value)
      credentialAccount.value = null
  },
})

const credentialFields = computed(() => (credentialAccount.value === null ? [] : providerOf(credentialAccount.value.provider)?.fields ?? []))

function providerOf(id: string): DdnsProviderInfo | null {
  return providers.value.find(provider => provider.id === id) ?? null
}

function accountProvider(domain: DraftDomain): DdnsProviderInfo | null {
  const account = accounts.value.find(entry => entry.id === domain.account)
  return account === undefined ? null : providerOf(account.provider)
}

function providerLabel(account: DraftAccount): string {
  return providerOf(account.provider)?.label ?? account.provider
}

function credentialsSet(id: string): boolean {
  return view.value?.credentials.includes(id) === true
}

function domainsUsing(id: string): number {
  return domains.value.filter(domain => domain.account === id).length
}

function toggleType(domain: DraftDomain, recordType: DdnsRecordType, on: boolean): void {
  const next = on ? [...new Set([...domain.types, recordType])] : domain.types.filter(entry => entry !== recordType)
  domain.types = next.length > 0 ? next : domain.types
}

/** Optional fields are cleared by removing the key, which the schema reads as "inherit". */
function setOptional(target: DraftDomain, key: 'zone' | 'ttl', value: string | number | null | undefined): void {
  if (value === undefined || value === null || value === '')
    delete target[key]
  else
    (target as Record<string, unknown>)[key] = value
}

/**
 * A required numeric field the NumberField can report as empty. See
 * `requiredDdnsNumber` for why a cleared box must not stay cleared.
 */
function setRequired(target: DraftConfig | null, key: 'intervalMs' | 'ttl', value: number | null): void {
  if (target === null)
    return
  target[key] = requiredDdnsNumber(value, key)
}

/** Publishes the pending block to the page's patch; null means "nothing to save". */
function syncPatch(): void {
  patch.value = draft.value === null || baseline.value === null || ddnsConfigEquals(draft.value, baseline.value)
    ? null
    : toDdnsConfig(draft.value)
}

function apply(next: Awaited<ReturnType<typeof api.fetchDdns>>, keepDraft = false): void {
  view.value = next
  baseline.value = cloneDdnsConfig(next.config)
  if (!keepDraft)
    draft.value = cloneDdnsConfig(next.config)
  syncPatch()
}

async function load(): Promise<void> {
  loadError.value = null
  try {
    apply(await api.fetchDdns(workspace.activeId.value))
    newAccount.provider = providerOptions.value[0]?.value ?? 'cloudflare'
    newDomain.account = accounts.value[0]?.id ?? ''
  }
  catch (caught) {
    loadError.value = errorMessage(caught)
  }
}

onMounted(() => {
  void load()
})

// The section belongs to the selected workspace; a switch re-reads its policy.
watch(() => workspace.activeId.value, (id, previous) => {
  if (id !== previous && id.length > 0)
    void load()
})

// A draft edit is news for the page: it owns the Save that will write it.
watch(draft, syncPatch, { deep: true })

// Watching the ids, not the array: pushing onto `draft.accounts` mutates the same
// array the computed hands back, which Vue would not see as a change.
watch(accountIds, () => {
  if (!accounts.value.some(account => account.id === newDomain.account))
    newDomain.account = accounts.value[0]?.id ?? ''
})

function addAccount(): void {
  if (!canAddAccount.value || draft.value === null)
    return
  draft.value.accounts.push({ id: newAccount.id, provider: newAccount.provider, label: '' })
  newAccount.id = ''
}

function removeAccount(account: DraftAccount): void {
  if (draft.value === null || domainsUsing(account.id) > 0)
    return
  draft.value.accounts = draft.value.accounts.filter(entry => entry.id !== account.id)
}

function addDomain(): void {
  if (!canAddDomain.value || draft.value === null)
    return
  draft.value.domains.push({ host: newDomain.host.trim().toLowerCase(), account: newDomain.account, types: ['A'], proxied: false, enabled: true, key: newDraftDomainKey() })
  newDomain.host = ''
}

function removeDomain(domain: DraftDomain): void {
  if (draft.value === null)
    return
  draft.value.domains = draft.value.domains.filter(entry => entry !== domain)
}

function discard(): void {
  if (baseline.value !== null)
    draft.value = cloneDdnsConfig(baseline.value)
  actionError.value = null
}

async function updateNow(): Promise<void> {
  if (checking.value)
    return
  checking.value = true
  actionError.value = null
  try {
    // Keeps an unsaved draft: a pass does not change the policy.
    apply(await api.checkDdns(workspace.activeId.value), true)
    toasts.success(status.value?.lastResult ?? t('settings.ddns.passFinished'))
  }
  catch (caught) {
    actionError.value = errorMessage(caught)
  }
  finally {
    checking.value = false
  }
}

function openCredentials(account: DraftAccount): void {
  credentialAccount.value = account
  credentialDraft.value = Object.fromEntries((providerOf(account.provider)?.fields ?? []).map(field => [field.key, '']))
  credentialError.value = null
}

async function saveCredentials(): Promise<void> {
  const account = credentialAccount.value
  if (account === null || credentialBusy.value)
    return
  credentialBusy.value = true
  credentialError.value = null
  try {
    apply(await api.saveDdnsCredentials(workspace.activeId.value, account.id, account.provider, credentialDraft.value), true)
    toasts.success(t('settings.ddns.credentialsSaved', { account: account.id }))
    credentialAccount.value = null
  }
  catch (caught) {
    credentialError.value = errorMessage(caught)
  }
  finally {
    credentialBusy.value = false
  }
}

async function clearCredentials(): Promise<void> {
  const account = credentialAccount.value
  if (account === null || credentialBusy.value)
    return
  credentialBusy.value = true
  credentialError.value = null
  try {
    apply(await api.clearDdnsCredentials(workspace.activeId.value, account.id), true)
    toasts.success(t('settings.ddns.credentialsRemoved', { account: account.id }))
    credentialAccount.value = null
  }
  catch (caught) {
    credentialError.value = errorMessage(caught)
  }
  finally {
    credentialBusy.value = false
  }
}

// The page owns the Save, so it asks for a re-read once the block has landed.
defineExpose({ reload: load })
</script>

<template>
  <div class="space-y-3">
    <Notice v-if="loadError" tone="danger" :title="t('settings.ddns.loadErrorTitle')">
      {{ loadError }}
    </Notice>

    <template v-if="draft !== null">
      <FieldGroup
        :title="t('settings.ddns.title')"
        :description="t('settings.ddns.description')"
      >
        <template #actions>
          <AppButton size="xs" variant="ghost" :disabled="!dirty" @click="discard">
            {{ t('common.reset') }}
          </AppButton>
          <ToneBadge v-if="status?.running" tone="info" dot>
            {{ t('settings.ddns.checking') }}
          </ToneBadge>
          <ToneBadge v-else-if="status?.enabled" :tone="status.records.some(record => record.state === 'error') ? 'danger' : 'ok'" dot>
            {{ status.records.some(record => record.state === 'error') ? t('settings.ddns.needsAttention') : t('settings.ddns.watching') }}
          </ToneBadge>
          <AppButton size="xs" variant="ghost" :loading="checking" @click="updateNow">
            {{ t('settings.ddns.updateNow') }}
          </AppButton>
        </template>

        <ToggleSwitch
          v-model="draft.enabled"
          :label="t('settings.ddns.enabled')"
          :hint="t('settings.ddns.enabledHint')"
          wide
        />
        <!-- Both keys are required, so a cleared box falls back to the schema's default
             rather than storing null, which the panel rejects for the whole save. -->
        <NumberField
          :model-value="draft.intervalMs"
          :label="t('settings.ddns.interval')"
          :min="60000"
          :step="60000"
          :hint="t('settings.ddns.intervalHint')"
          @update:model-value="value => setRequired(draft, 'intervalMs', value)"
        />
        <NumberField
          :model-value="draft.ttl"
          :label="t('settings.ddns.ttl')"
          :min="1"
          :hint="t('settings.ddns.ttlHint')"
          @update:model-value="value => setRequired(draft, 'ttl', value)"
        />
        <ToggleSwitch v-model="draft.ipv4.enabled" :label="t('settings.ddns.detectIpv4')" :hint="t('settings.ddns.detectIpv4Hint')" />
        <ToggleSwitch v-model="draft.ipv6.enabled" :label="t('settings.ddns.detectIpv6')" :hint="t('settings.ddns.detectIpv6Hint')" />
      </FieldGroup>

      <Notice v-if="actionError" tone="danger">
        {{ actionError }}
      </Notice>

      <section class="rounded-panel border border-line bg-panel-2/40 p-3.5">
        <header class="mb-3">
          <h3 class="text-xs font-semibold text-ink">
            {{ t('settings.ddns.accountsTitle') }}
          </h3>
          <p class="mt-0.5 text-2xs leading-4 text-muted">
            {{ t('settings.ddns.accountsDescription') }}
          </p>
        </header>

        <ul v-if="accounts.length > 0" class="divide-y divide-line-soft">
          <li v-for="account in accounts" :key="account.id" class="flex flex-wrap items-center gap-x-3 gap-y-2 py-2 first:pt-0">
            <div class="min-w-0">
              <p class="font-mono text-xs text-ink">
                {{ account.id }}
              </p>
              <p class="text-2xs text-faint">
                {{ providerLabel(account) }}
                <span v-if="domainsUsing(account.id) > 0"> · {{ tc('settings.ddns.hostnameCount', domainsUsing(account.id)) }}</span>
              </p>
            </div>
            <div class="ml-auto flex items-center gap-2">
              <ToneBadge :tone="credentialsSet(account.id) ? 'ok' : 'warn'" dot>
                {{ credentialsSet(account.id) ? t('settings.ddns.credentialsSet') : t('settings.ddns.noCredentials') }}
              </ToneBadge>
              <AppButton size="xs" variant="secondary" @click="openCredentials(account)">
                {{ t('settings.ddns.credentials') }}
              </AppButton>
              <AppButton
                size="xs"
                variant="danger-ghost"
                :disabled="domainsUsing(account.id) > 0"
                :title="domainsUsing(account.id) > 0 ? t('settings.ddns.removeAccountBlocked') : undefined"
                @click="removeAccount(account)"
              >
                {{ t('common.remove') }}
              </AppButton>
            </div>
          </li>
        </ul>
        <p v-else class="text-2xs text-muted">
          {{ t('settings.ddns.noAccounts') }}
        </p>

        <div class="mt-3 grid grid-cols-1 gap-2 border-t border-line-soft pt-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <SelectField v-model="newAccount.provider" :label="t('settings.ddns.provider')" :options="providerOptions" />
          <TextField v-model="newAccount.id" :label="t('settings.ddns.accountId')" :placeholder="t('settings.ddns.accountIdPlaceholder')" />
          <AppButton variant="secondary" :disabled="!canAddAccount" @click="addAccount">
            {{ t('common.add') }}
          </AppButton>
        </div>
        <p class="mt-1.5 text-2xs text-faint">
          {{ t('settings.ddns.accountIdHint') }}
        </p>
      </section>

      <section class="rounded-panel border border-line bg-panel-2/40 p-3.5">
        <header class="mb-3">
          <h3 class="text-xs font-semibold text-ink">
            {{ t('settings.ddns.hostnamesTitle') }}
          </h3>
          <p class="mt-0.5 text-2xs leading-4 text-muted">
            {{ t('settings.ddns.hostnamesDescription') }}
          </p>
        </header>

        <ul v-if="domains.length > 0" class="space-y-2">
          <li v-for="domain in domains" :key="domain.key" class="rounded-control border border-line-soft bg-panel/50 p-2.5">
            <div class="flex flex-wrap items-end gap-2">
              <div class="min-w-40 flex-1">
                <TextField v-model="domain.host" :label="t('common.hostname')" />
              </div>
              <div class="w-44 shrink-0">
                <SelectField v-model="domain.account" :label="t('settings.ddns.account')" :options="accountOptions" />
              </div>
              <CheckField v-model="domain.enabled" :label="t('common.enabled')" />
              <AppButton size="xs" variant="danger-ghost" @click="removeDomain(domain)">
                {{ t('common.remove') }}
              </AppButton>
            </div>

            <div class="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1">
              <CheckField
                :model-value="domain.types.includes('A')"
                :label="t('settings.ddns.recordA')"
                @update:model-value="value => toggleType(domain, 'A', value === true)"
              />
              <CheckField
                :model-value="domain.types.includes('AAAA')"
                :label="t('settings.ddns.recordAaaa')"
                :disabled="accountProvider(domain)?.families.includes('AAAA') === false"
                :hint="accountProvider(domain)?.families.includes('AAAA') === false ? t('settings.ddns.aaaaUnsupported') : undefined"
                @update:model-value="value => toggleType(domain, 'AAAA', value === true)"
              />
              <CheckField
                v-if="accountProvider(domain)?.proxied === true"
                v-model="domain.proxied"
                :label="t('settings.ddns.proxied')"
                :hint="t('settings.ddns.proxiedHint')"
              />
              <ToneBadge v-if="domain.types.includes('AAAA') && !draft.ipv6.enabled" tone="warn">
                {{ t('settings.ddns.ipv6Off') }}
              </ToneBadge>
            </div>

            <Disclosure :title="t('settings.ddns.advanced')" :hint="t('settings.ddns.advancedHint')" class="mt-2">
              <TextField
                :model-value="domain.zone ?? ''"
                :label="t('settings.ddns.registeredDomain')"
                :placeholder="t('settings.ddns.registeredDomainPlaceholder')"
                :hint="t('settings.ddns.registeredDomainHint')"
                @update:model-value="value => setOptional(domain, 'zone', value)"
              />
              <NumberField
                v-if="accountProvider(domain)?.ttl !== false"
                :model-value="domain.ttl ?? null"
                :min="1"
                nullable
                :label="t('settings.ddns.ttlOverride')"
                :hint="t('settings.ddns.ttlOverrideHint')"
                @update:model-value="value => setOptional(domain, 'ttl', value)"
              />
            </Disclosure>
          </li>
        </ul>
        <p v-else class="text-2xs text-muted">
          {{ t('settings.ddns.noHostnames') }}
        </p>

        <div class="mt-3 grid grid-cols-1 gap-2 border-t border-line-soft pt-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <TextField v-model="newDomain.host" :label="t('common.hostname')" :placeholder="t('settings.ddns.hostnamePlaceholder')" />
          <SelectField v-model="newDomain.account" :label="t('settings.ddns.account')" :options="accountOptions" :disabled="accounts.length === 0" />
          <AppButton variant="secondary" :disabled="!canAddDomain" @click="addDomain">
            {{ t('common.add') }}
          </AppButton>
        </div>
      </section>

      <section v-if="status !== null && status.records.length > 0" class="rounded-panel border border-line bg-panel-2/40 p-3.5">
        <header class="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          <h3 class="text-xs font-semibold text-ink">
            {{ t('settings.ddns.lastPass') }}
          </h3>
          <span v-if="status.lastResult" class="text-2xs text-muted">{{ status.lastResult }}</span>
          <span v-if="status.ipv4" class="font-mono text-2xs text-faint">{{ t('settings.ddns.ipv4Value', { address: status.ipv4 }) }}</span>
          <span v-if="status.ipv6" class="font-mono text-2xs text-faint">{{ t('settings.ddns.ipv6Value', { address: status.ipv6 }) }}</span>
          <span v-if="status.lastRunAt" class="ml-auto text-2xs text-faint">{{ formatAgo(status.lastRunAt, control.now.value) }}</span>
        </header>
        <div class="overflow-x-auto">
          <table class="w-full text-left text-xs">
            <thead>
              <tr class="text-2xs text-faint">
                <th class="py-1 pr-3 font-medium">
                  {{ t('common.hostname') }}
                </th>
                <th class="py-1 pr-3 font-medium">
                  {{ t('settings.ddns.type') }}
                </th>
                <th class="py-1 pr-3 font-medium">
                  {{ t('settings.ddns.state') }}
                </th>
                <th class="py-1 pr-3 font-medium">
                  {{ t('settings.ddns.address') }}
                </th>
                <th class="py-1 font-medium">
                  {{ t('settings.ddns.detail') }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="record in status.records" :key="`${record.host}|${record.type}`" class="border-t border-line-soft align-top">
                <td class="py-1.5 pr-3 font-mono text-2xs text-ink">
                  {{ record.host }}
                </td>
                <td class="py-1.5 pr-3 text-2xs text-muted">
                  {{ record.type }}
                </td>
                <td class="py-1.5 pr-3">
                  <ToneBadge :tone="RECORD_STATE[record.state].tone" dot>
                    {{ t(RECORD_STATE[record.state].labelKey) }}
                  </ToneBadge>
                </td>
                <td class="py-1.5 pr-3 font-mono text-2xs text-muted">
                  {{ record.ip ?? '—' }}
                </td>
                <td class="py-1.5 text-2xs text-faint">
                  {{ record.message ?? '—' }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </div>

  <Modal
    v-model:open="credentialsOpen"
    :title="t('settings.ddns.credentialsTitle')"
    :description="credentialAccount === null ? '' : `${providerLabel(credentialAccount)} — ${credentialAccount.id}`"
    width="w-[min(92vw,32rem)]"
  >
    <div class="space-y-3">
      <p class="text-2xs leading-4 text-muted">
        {{ t('settings.ddns.credentialsDescription') }}
      </p>
      <TextField
        v-for="field in credentialFields"
        :key="field.key"
        v-model="credentialDraft[field.key]"
        type="password"
        autocomplete="off"
        :label="field.label"
        :hint="`${field.hint}${field.optional ? ` ${t('settings.ddns.optional')}` : ''}`"
        wide
      />
      <a
        v-if="credentialAccount !== null"
        class="inline-block text-2xs text-accent underline decoration-line underline-offset-2"
        :href="providerOf(credentialAccount.provider)?.docsUrl"
        target="_blank"
        rel="noreferrer"
      >{{ t('settings.ddns.whereToGet') }}</a>
      <Notice v-if="credentialError" tone="danger">
        {{ credentialError }}
      </Notice>
    </div>

    <template #footer>
      <!-- Behind a popover: the credentials are sealed on disk and cannot be read back,
           so one click here is unrecoverable — and it sits beside "Save credentials". -->
      <ConfirmButton
        v-if="credentialAccount !== null && credentialsSet(credentialAccount.id)"
        :label="t('settings.ddns.forget')"
        :confirm-label="t('settings.ddns.forgetConfirm')"
        :title="t('settings.ddns.forgetTitle')"
        :hint="t('settings.ddns.forgetHint')"
        :loading="credentialBusy"
        :disabled="credentialBusy"
        @confirm="clearCredentials"
      />
      <AppButton size="sm" variant="ghost" :disabled="credentialBusy" @click="credentialsOpen = false">
        {{ t('common.cancel') }}
      </AppButton>
      <AppButton
        size="sm"
        variant="primary"
        :loading="credentialBusy"
        :disabled="Object.values(credentialDraft).every(value => value.trim().length === 0)"
        @click="saveCredentials"
      >
        {{ t('settings.ddns.saveCredentials') }}
      </AppButton>
    </template>
  </Modal>
</template>
