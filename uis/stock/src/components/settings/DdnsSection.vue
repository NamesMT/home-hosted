<script setup lang="ts">
import type { DdnsAccount, DdnsConfig, DdnsProviderInfo, DdnsRecordState, DdnsRecordType } from '@shared/contracts'
import type { DraftAccount, DraftConfig, DraftDomain } from '@/lib/ddns'
import type { Tone } from '@/lib/status'
import { computed, onMounted, reactive, ref, watch } from 'vue'
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
import * as api from '@/lib/api'
import { cloneDdnsConfig } from '@/lib/ddns'
import { formatAgo } from '@/lib/format'

const RECORD_STATE: Record<DdnsRecordState, { label: string, tone: Tone }> = {
  pending: { label: 'Waiting', tone: 'neutral' },
  ok: { label: 'Updated', tone: 'ok' },
  unchanged: { label: 'Current', tone: 'neutral' },
  skipped: { label: 'Skipped', tone: 'warn' },
  error: { label: 'Failed', tone: 'danger' },
}

const control = useControlPlane()
const toasts = useToasts()

const view = ref<Awaited<ReturnType<typeof api.fetchDdns>> | null>(null)
const draft = ref<DraftConfig | null>(null)
const loadError = ref<string | null>(null)
const saveError = ref<string | null>(null)
const saving = ref(false)
const checking = ref(false)

const newAccount = reactive({ id: '', provider: 'cloudflare', label: '' })
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
const accountOptions = computed(() => accounts.value.map(account => ({ value: account.id, label: account.label.length > 0 ? `${account.label} (${account.id})` : account.id })))

/** Live state from the SSE frame; the fetch is only the fallback before one lands. */
const status = computed(() => control.appState.value?.ddns ?? view.value?.status ?? null)

const dirty = computed(() => draft.value !== null && view.value !== null && JSON.stringify(draft.value) !== JSON.stringify(view.value.config))
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
function setOptional(target: DraftDomain, key: 'zone' | 'ttl' | 'proxied', value: string | number | boolean | null | undefined): void {
  if (value === undefined || value === null || value === '')
    delete target[key]
  else
    (target as Record<string, unknown>)[key] = value
}

function apply(next: Awaited<ReturnType<typeof api.fetchDdns>>, keepDraft = false): void {
  view.value = next
  if (!keepDraft)
    draft.value = cloneDdnsConfig(next.config)
}

async function load(): Promise<void> {
  loadError.value = null
  try {
    apply(await api.fetchDdns())
    newAccount.provider = providerOptions.value[0]?.value ?? 'cloudflare'
    newDomain.account = accounts.value[0]?.id ?? ''
  }
  catch (caught) {
    loadError.value = caught instanceof Error ? caught.message : String(caught)
  }
}

onMounted(() => {
  void load()
})

// Watching the ids, not the array: pushing onto `draft.accounts` mutates the same
// array the computed hands back, which Vue would not see as a change.
watch(accountIds, () => {
  if (!accounts.value.some(account => account.id === newDomain.account))
    newDomain.account = accounts.value[0]?.id ?? ''
})

function addAccount(): void {
  if (!canAddAccount.value || draft.value === null)
    return
  draft.value.accounts.push({ id: newAccount.id, provider: newAccount.provider, label: newAccount.label.trim() })
  newAccount.id = ''
  newAccount.label = ''
}

function removeAccount(account: DraftAccount): void {
  if (draft.value === null || domainsUsing(account.id) > 0)
    return
  draft.value.accounts = draft.value.accounts.filter(entry => entry.id !== account.id)
}

function addDomain(): void {
  if (!canAddDomain.value || draft.value === null)
    return
  draft.value.domains.push({ host: newDomain.host.trim().toLowerCase(), account: newDomain.account, types: ['A'], enabled: true })
  newDomain.host = ''
}

function removeDomain(domain: DraftDomain): void {
  if (draft.value === null)
    return
  draft.value.domains = draft.value.domains.filter(entry => entry !== domain)
}

async function save(): Promise<void> {
  if (draft.value === null || saving.value)
    return
  saving.value = true
  saveError.value = null
  try {
    apply(await api.saveDdns(draft.value as unknown as DdnsConfig))
    toasts.success('Dynamic DNS saved')
  }
  catch (caught) {
    saveError.value = caught instanceof Error ? caught.message : String(caught)
  }
  finally {
    saving.value = false
  }
}

function discard(): void {
  if (view.value !== null)
    draft.value = cloneDdnsConfig(view.value.config)
  saveError.value = null
}

async function updateNow(): Promise<void> {
  if (checking.value)
    return
  checking.value = true
  saveError.value = null
  try {
    // Keeps an unsaved draft: a pass does not change the policy.
    apply(await api.checkDdns(), true)
    toasts.success(status.value?.lastResult ?? 'Dynamic DNS pass finished')
  }
  catch (caught) {
    saveError.value = caught instanceof Error ? caught.message : String(caught)
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
    apply(await api.saveDdnsCredentials(account.id, account.provider, credentialDraft.value), true)
    toasts.success(`Credentials saved for ${account.label || account.id}`)
    credentialAccount.value = null
  }
  catch (caught) {
    credentialError.value = caught instanceof Error ? caught.message : String(caught)
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
    apply(await api.clearDdnsCredentials(account.id), true)
    toasts.success(`Credentials removed for ${account.label || account.id}`)
    credentialAccount.value = null
  }
  catch (caught) {
    credentialError.value = caught instanceof Error ? caught.message : String(caught)
  }
  finally {
    credentialBusy.value = false
  }
}
</script>

<template>
  <div class="space-y-3">
    <Notice v-if="loadError" tone="danger" title="Dynamic DNS settings could not be loaded">
      {{ loadError }}
    </Notice>

    <template v-if="draft !== null">
      <FieldGroup
        title="Dynamic DNS"
        description="Keep these hostnames pointed at this machine's public address. Credentials live in the secrets file, never in servers.config.json."
      >
        <template #actions>
          <ToneBadge v-if="status?.running" tone="info" dot>
            checking
          </ToneBadge>
          <ToneBadge v-else-if="status?.enabled" :tone="status.records.some(record => record.state === 'error') ? 'danger' : 'ok'" dot>
            {{ status.records.some(record => record.state === 'error') ? 'needs attention' : 'watching' }}
          </ToneBadge>
          <AppButton size="xs" variant="ghost" :loading="checking" @click="updateNow">
            Update now
          </AppButton>
        </template>

        <ToggleSwitch
          v-model="draft.enabled"
          label="Keep dynamic DNS updated"
          hint="A pass runs on the interval below; a provider is only called when the address actually changed."
          wide
        />
        <NumberField v-model="draft.intervalMs" label="Check every (ms)" :min="60000" :step="60000" hint="60000 is one minute; the default is five." />
        <ToggleSwitch v-model="draft.ipv4.enabled" label="Detect IPv4" hint="Needed for A records." />
        <ToggleSwitch v-model="draft.ipv6.enabled" label="Detect IPv6" hint="Needed for AAAA records." />
        <NumberField v-model="draft.ttl" label="TTL (s)" :min="1" hint="1 means automatic where the provider supports it." />
        <ToggleSwitch v-model="draft.proxied" label="Proxy through Cloudflare" hint="Cloudflare only; a proxied record always uses automatic TTL." />
        <ToggleSwitch v-model="draft.notify" label="Notify on changes" hint="Uses the Telegram channel under Notifications; failures notify whenever that is on." wide />
      </FieldGroup>

      <section class="rounded-panel border border-line bg-panel-2/40 p-3.5">
        <header class="mb-3">
          <h3 class="text-xs font-semibold text-ink">
            Provider accounts
          </h3>
          <p class="mt-0.5 text-2xs leading-4 text-muted">
            One entry per API token. Credentials are stored on the server and never come back.
          </p>
        </header>

        <ul v-if="accounts.length > 0" class="divide-y divide-line-soft">
          <li v-for="account in accounts" :key="account.id" class="flex flex-wrap items-center gap-x-3 gap-y-2 py-2 first:pt-0">
            <div class="min-w-0">
              <p class="text-xs text-ink">
                {{ account.label || account.id }}
                <span v-if="account.label" class="font-mono text-2xs text-faint">{{ account.id }}</span>
              </p>
              <p class="text-2xs text-faint">
                {{ providerLabel(account) }}
                <span v-if="domainsUsing(account.id) > 0"> · {{ domainsUsing(account.id) }} hostname{{ domainsUsing(account.id) === 1 ? '' : 's' }}</span>
              </p>
            </div>
            <div class="ml-auto flex items-center gap-2">
              <ToneBadge :tone="credentialsSet(account.id) ? 'ok' : 'warn'" dot>
                {{ credentialsSet(account.id) ? 'credentials saved' : 'no credentials' }}
              </ToneBadge>
              <AppButton size="xs" variant="secondary" @click="openCredentials(account)">
                Credentials
              </AppButton>
              <AppButton
                size="xs"
                variant="danger-ghost"
                :disabled="domainsUsing(account.id) > 0"
                :title="domainsUsing(account.id) > 0 ? 'Remove the hostnames using this account first' : undefined"
                @click="removeAccount(account)"
              >
                Remove
              </AppButton>
            </div>
          </li>
        </ul>
        <p v-else class="text-2xs text-muted">
          No accounts yet. Pick a provider and add one.
        </p>

        <div class="mt-3 grid gap-2 border-t border-line-soft pt-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
          <SelectField v-model="newAccount.provider" label="Provider" :options="providerOptions" />
          <TextField v-model="newAccount.id" label="Account id" placeholder="cloudflare-home" />
          <TextField v-model="newAccount.label" label="Label" placeholder="Home zone" />
          <AppButton variant="secondary" :disabled="!canAddAccount" @click="addAccount">
            Add
          </AppButton>
        </div>
        <p class="mt-1.5 text-2xs text-faint">
          The account id is how stored credentials are keyed; lowercase letters, digits, `-` and `_`.
        </p>
      </section>

      <section class="rounded-panel border border-line bg-panel-2/40 p-3.5">
        <header class="mb-3">
          <h3 class="text-xs font-semibold text-ink">
            Hostnames
          </h3>
          <p class="mt-0.5 text-2xs leading-4 text-muted">
            The whole list to keep updated — suba.domain.com, domain.xyz and so on.
          </p>
        </header>

        <ul v-if="domains.length > 0" class="space-y-2">
          <li v-for="domain in domains" :key="`${domain.host}|${domain.account}`" class="rounded-control border border-line-soft bg-panel/50 p-2.5">
            <div class="flex flex-wrap items-end gap-2">
              <div class="min-w-40 flex-1">
                <TextField v-model="domain.host" label="Hostname" />
              </div>
              <div class="w-44 shrink-0">
                <SelectField v-model="domain.account" label="Account" :options="accountOptions" />
              </div>
              <CheckField v-model="domain.enabled" label="Enabled" />
              <AppButton size="xs" variant="danger-ghost" @click="removeDomain(domain)">
                Remove
              </AppButton>
            </div>

            <div class="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1">
              <CheckField
                :model-value="domain.types.includes('A')"
                label="A (IPv4)"
                @update:model-value="value => toggleType(domain, 'A', value === true)"
              />
              <CheckField
                :model-value="domain.types.includes('AAAA')"
                label="AAAA (IPv6)"
                :disabled="accountProvider(domain)?.families.includes('AAAA') === false"
                :hint="accountProvider(domain)?.families.includes('AAAA') === false ? 'This provider cannot manage AAAA records.' : undefined"
                @update:model-value="value => toggleType(domain, 'AAAA', value === true)"
              />
              <ToneBadge v-if="domain.types.includes('AAAA') && !draft.ipv6.enabled" tone="warn">
                IPv6 detection is off
              </ToneBadge>
            </div>

            <Disclosure title="Advanced" hint="registered domain, TTL and proxy overrides" class="mt-2">
              <TextField
                :model-value="domain.zone ?? ''"
                label="Registered domain"
                placeholder="example.co.uk"
                hint="Only when the provider has to be told the apex, e.g. three-label domains."
                @update:model-value="value => setOptional(domain, 'zone', value)"
              />
              <NumberField
                v-if="accountProvider(domain)?.ttl !== false"
                :model-value="domain.ttl ?? null"
                :min="1"
                nullable
                label="TTL override (s)"
                hint="Blank uses the value above."
                @update:model-value="value => setOptional(domain, 'ttl', value)"
              />
              <SelectField
                v-if="accountProvider(domain)?.proxied === true"
                :model-value="domain.proxied === undefined ? '' : String(domain.proxied)"
                label="Proxy"
                :options="[
                  { value: '', label: 'Use the default' },
                  { value: 'true', label: 'Proxied' },
                  { value: 'false', label: 'DNS only' },
                ]"
                @update:model-value="value => setOptional(domain, 'proxied', value === '' ? undefined : value === 'true')"
              />
            </Disclosure>
          </li>
        </ul>
        <p v-else class="text-2xs text-muted">
          No hostnames yet.
        </p>

        <div class="mt-3 grid gap-2 border-t border-line-soft pt-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <TextField v-model="newDomain.host" label="Hostname" placeholder="home.example.com" />
          <SelectField v-model="newDomain.account" label="Account" :options="accountOptions" :disabled="accounts.length === 0" />
          <AppButton variant="secondary" :disabled="!canAddDomain" @click="addDomain">
            Add
          </AppButton>
        </div>
      </section>

      <section v-if="status !== null && status.records.length > 0" class="rounded-panel border border-line bg-panel-2/40 p-3.5">
        <header class="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          <h3 class="text-xs font-semibold text-ink">
            Last pass
          </h3>
          <span v-if="status.lastResult" class="text-2xs text-muted">{{ status.lastResult }}</span>
          <span v-if="status.ipv4" class="font-mono text-2xs text-faint">IPv4 {{ status.ipv4 }}</span>
          <span v-if="status.ipv6" class="font-mono text-2xs text-faint">IPv6 {{ status.ipv6 }}</span>
          <span v-if="status.lastRunAt" class="ml-auto text-2xs text-faint">{{ formatAgo(status.lastRunAt, control.now.value) }}</span>
        </header>
        <div class="overflow-x-auto">
          <table class="w-full text-left text-xs">
            <thead>
              <tr class="text-2xs text-faint">
                <th class="py-1 pr-3 font-medium">
                  Hostname
                </th>
                <th class="py-1 pr-3 font-medium">
                  Type
                </th>
                <th class="py-1 pr-3 font-medium">
                  State
                </th>
                <th class="py-1 pr-3 font-medium">
                  Address
                </th>
                <th class="py-1 font-medium">
                  Detail
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
                    {{ RECORD_STATE[record.state].label }}
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

      <div class="flex flex-wrap items-center gap-2">
        <AppButton variant="primary" :disabled="!dirty" :loading="saving" @click="save">
          Save dynamic DNS
        </AppButton>
        <AppButton variant="ghost" :disabled="!dirty" @click="discard">
          Discard
        </AppButton>
        <p v-if="saveError" class="text-2xs text-danger">
          {{ saveError }}
        </p>
        <p v-else-if="dirty" class="text-2xs text-muted">
          Unsaved changes.
        </p>
      </div>
    </template>
  </div>

  <Modal
    v-model:open="credentialsOpen"
    title="Provider credentials"
    :description="credentialAccount === null ? '' : `${providerLabel(credentialAccount)} — ${credentialAccount.label || credentialAccount.id}`"
    width="w-[min(92vw,32rem)]"
  >
    <div class="space-y-3">
      <p class="text-2xs leading-4 text-muted">
        Saved fields are never sent back. Saving replaces every field for this account and runs a pass right away.
      </p>
      <TextField
        v-for="field in credentialFields"
        :key="field.key"
        v-model="credentialDraft[field.key]"
        type="password"
        autocomplete="off"
        :label="field.label"
        :hint="`${field.hint}${field.optional ? ' Optional.' : ''}`"
        wide
      />
      <a
        v-if="credentialAccount !== null"
        class="inline-block text-2xs text-accent underline decoration-line underline-offset-2"
        :href="providerOf(credentialAccount.provider)?.docsUrl"
        target="_blank"
        rel="noreferrer"
      >Where to get these</a>
      <Notice v-if="credentialError" tone="danger">
        {{ credentialError }}
      </Notice>
    </div>

    <template #footer>
      <AppButton
        v-if="credentialAccount !== null && credentialsSet(credentialAccount.id)"
        size="sm"
        variant="danger-ghost"
        :disabled="credentialBusy"
        @click="clearCredentials"
      >
        Forget
      </AppButton>
      <AppButton size="sm" variant="ghost" :disabled="credentialBusy" @click="credentialsOpen = false">
        Cancel
      </AppButton>
      <AppButton
        size="sm"
        variant="primary"
        :loading="credentialBusy"
        :disabled="Object.values(credentialDraft).every(value => value.trim().length === 0)"
        @click="saveCredentials"
      >
        Save credentials
      </AppButton>
    </template>
  </Modal>
</template>
