<script setup lang="ts">
import type { DdnsConfig, DdnsProviderInfo, DdnsRecordState, DdnsRecordType } from '@shared/contracts'
import type { DraftAccount, DraftConfig, DraftDomain } from '@/lib/ddns'
import { computed, onMounted, reactive, ref, watch } from 'vue'
import ConfirmButton from '@/components/ConfirmButton.vue'
import { useControlPlane } from '@/composables/useControlPlane'
import { useWorkspaces } from '@/composables/useWorkspaces'
import * as api from '@/lib/api'
import { cloneDdnsConfig, ddnsConfigEquals, newDraftDomainKey, toDdnsConfig } from '@/lib/ddns'
import { formatAgo } from '@/lib/format'

/**
 * The policy rides the page's patch, so the settings Save writes it; only credentials
 * keep an endpoint of their own, being a secret.
 */
const patch = defineModel<DdnsConfig | null>('patch', { default: null })
const baseline = defineModel<DraftConfig | null>('baseline', { default: null })

const RECORD_CHIP: Record<DdnsRecordState, { label: string, chip: string }> = {
  pending: { label: 'waiting', chip: 'chip--neutral' },
  ok: { label: 'updated', chip: 'chip--ok' },
  unchanged: { label: 'current', chip: 'chip--stopped' },
  skipped: { label: 'skipped', chip: 'chip--warn' },
  error: { label: 'failed', chip: 'chip--danger' },
}

const control = useControlPlane()
const workspace = useWorkspaces()

const view = ref<Awaited<ReturnType<typeof api.fetchDdns>> | null>(null)
const draft = ref<DraftConfig | null>(null)
const loadError = ref<string | null>(null)
const message = ref<string | null>(null)
const error = ref<string | null>(null)
const checking = ref(false)

const newAccount = reactive({ id: '', provider: 'cloudflare' })
const newDomain = reactive({ host: '', account: '' })

const editing = ref<string | null>(null)
const credentialDraft = ref<Record<string, string>>({})
const credentialBusy = ref(false)

const providers = computed<DdnsProviderInfo[]>(() => view.value?.providers ?? [])
const accounts = computed<DraftAccount[]>(() => draft.value?.accounts ?? [])
const domains = computed<DraftDomain[]>(() => draft.value?.domains ?? [])
const accountIds = computed(() => accounts.value.map(account => account.id).join(','))

const providerOptions = computed(() => providers.value.map(provider => ({ value: provider.id, label: provider.label })))
const accountOptions = computed(() => accounts.value.map(account => ({ value: account.id, label: account.id })))

/** Live state from the SSE frame; the fetch is only the fallback before one lands. */
const status = computed(() => workspace.ddns.value ?? view.value?.status ?? null)
const dirty = computed(() => draft.value !== null && baseline.value !== null && !ddnsConfigEquals(draft.value, baseline.value))
const canAddAccount = computed(() => /^[a-z0-9][a-z0-9_-]*$/.test(newAccount.id) && !accounts.value.some(account => account.id === newAccount.id))
const canAddDomain = computed(() => newDomain.host.includes('.') && newDomain.account.length > 0 && !domains.value.some(domain => domain.host.toLowerCase() === newDomain.host.trim().toLowerCase()))

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
    loadError.value = caught instanceof Error ? caught.message : String(caught)
  }
}

onMounted(() => {
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
  if (editing.value === account.id)
    editing.value = null
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

function editCredentials(account: DraftAccount): void {
  editing.value = editing.value === account.id ? null : account.id
  credentialDraft.value = Object.fromEntries((providerOf(account.provider)?.fields ?? []).map(field => [field.key, '']))
}

function discard(): void {
  if (baseline.value !== null)
    draft.value = cloneDdnsConfig(baseline.value)
  error.value = null
  message.value = null
}

async function updateNow(): Promise<void> {
  if (checking.value)
    return
  checking.value = true
  error.value = null
  try {
    // Keeps an unsaved draft: a pass does not change the policy.
    apply(await api.checkDdns(workspace.activeId.value), true)
    message.value = status.value?.lastResult ?? 'dynamic DNS pass finished'
  }
  catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  }
  finally {
    checking.value = false
  }
}

async function saveCredentials(account: DraftAccount): Promise<void> {
  if (credentialBusy.value)
    return
  credentialBusy.value = true
  error.value = null
  try {
    apply(await api.saveDdnsCredentials(account.id, account.provider, credentialDraft.value, workspace.activeId.value), true)
    message.value = `credentials saved for ${account.id}`
    editing.value = null
  }
  catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  }
  finally {
    credentialBusy.value = false
  }
}

// The page owns the Save, so it asks for a re-read once the block has landed.
defineExpose({ reload: load })

async function clearCredentials(account: DraftAccount): Promise<void> {
  if (credentialBusy.value)
    return
  credentialBusy.value = true
  error.value = null
  try {
    apply(await api.clearDdnsCredentials(account.id, workspace.activeId.value), true)
    message.value = `credentials removed for ${account.id}`
  }
  catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  }
  finally {
    credentialBusy.value = false
  }
}
</script>

<template>
  <div v-if="loadError" class="group">
    <p class="note note--error">
      {{ loadError }}
    </p>
  </div>

  <template v-else-if="draft !== null">
    <div class="group">
      <div class="group__head">
        <span class="group__title">dynamic dns</span>
        <span v-if="status?.running" class="chip chip--accent">checking</span>
        <span v-else-if="status?.enabled" class="chip" :class="status.records.some(record => record.state === 'error') ? 'chip--danger' : 'chip--ok'">
          {{ status.records.some(record => record.state === 'error') ? 'needs attention' : 'watching' }}
        </span>
        <span class="view__spacer" />
        <button type="button" class="btn btn--xs btn--ghost" :disabled="checking" @click="updateNow">
          {{ checking ? 'checking…' : 'update now' }}
        </button>
      </div>
      <p class="group__note">
        Keeps each hostname below pointed at this machine's public address. Credentials live in the
        git-ignored secrets file; only the policy is written to <code>servers.config.json</code>.
      </p>
      <div class="grid">
        <label class="field field--check">
          <input v-model="draft.enabled" type="checkbox">
          <span class="field__label">keep dynamic DNS updated</span>
        </label>
        <label class="field">
          <span class="field__label">check every (ms)</span>
          <input v-model.number="draft.intervalMs" inputmode="numeric" min="60000" step="60000">
        </label>
        <label class="field">
          <span class="field__label">ttl (s, 1 = auto)</span>
          <input v-model.number="draft.ttl" inputmode="numeric" min="1">
        </label>
        <label class="field field--check">
          <input v-model="draft.ipv4.enabled" type="checkbox">
          <span class="field__label">detect IPv4 (A records)</span>
        </label>
        <label class="field field--check">
          <input v-model="draft.ipv6.enabled" type="checkbox">
          <span class="field__label">detect IPv6 (AAAA records)</span>
        </label>
      </div>
      <div class="actions actions--start" style="margin-top: 0.6rem">
        <button type="button" class="btn btn--sm btn--ghost" :disabled="!dirty" @click="discard">
          reset
        </button>
        <span v-if="dirty" class="field__hint">unsaved — the page's save writes it</span>
      </div>
      <p v-if="error" class="note note--error">
        {{ error }}
      </p>
      <p v-else-if="message" class="note note--ok">
        {{ message }}
      </p>
    </div>

    <div class="group">
      <div class="group__head">
        <span class="group__title">accounts</span>
        <span class="view__spacer" />
        <span class="faint">{{ accounts.length }} configured</span>
      </div>
      <p class="group__note">
        One entry per API token. Stored credentials are never sent back to this page.
      </p>

      <div v-if="accounts.length > 0" class="stack">
        <div v-for="account in accounts" :key="account.id" class="pane" style="border-bottom: 1px solid var(--line-soft)">
          <div class="row" style="padding: 0.35rem 0">
            <span class="mono">{{ account.id }}</span>
            <span class="faint">{{ providerLabel(account) }}</span>
            <span v-if="domainsUsing(account.id) > 0" class="faint">· {{ domainsUsing(account.id) }} hostname{{ domainsUsing(account.id) === 1 ? '' : 's' }}</span>
            <span class="chip" :class="credentialsSet(account.id) ? 'chip--ok' : 'chip--warn'">
              {{ credentialsSet(account.id) ? 'credentials set' : 'no credentials' }}
            </span>
            <span class="view__spacer" />
            <button type="button" class="btn btn--xs btn--ghost" @click="editCredentials(account)">
              {{ editing === account.id ? 'close' : 'credentials' }}
            </button>
            <ConfirmButton
              label="remove"
              confirm-label="confirm remove"
              tone="danger"
              :disabled="domainsUsing(account.id) > 0"
              :title="domainsUsing(account.id) > 0 ? 'Remove the hostnames using this account first' : 'Removes the account; its credentials are kept until forgotten'"
              @confirm="removeAccount(account)"
            />
          </div>

          <div v-if="editing === account.id" class="grid grid--wide" style="padding: 0 0 0.5rem">
            <label v-for="field in providerOf(account.provider)?.fields ?? []" :key="field.key" class="field">
              <span class="field__label">{{ field.label }}</span>
              <input v-model="credentialDraft[field.key]" type="password" autocomplete="off">
              <span class="field__hint">{{ field.hint }}{{ field.optional ? ' optional.' : '' }}</span>
            </label>
            <div class="actions actions--start grid__full">
              <button
                type="button"
                class="btn btn--xs btn--primary"
                :disabled="credentialBusy || Object.values(credentialDraft).every(value => value.trim().length === 0)"
                @click="saveCredentials(account)"
              >
                save credentials
              </button>
              <ConfirmButton
                v-if="credentialsSet(account.id)"
                label="forget"
                confirm-label="confirm forget"
                tone="danger"
                :disabled="credentialBusy"
                @confirm="clearCredentials(account)"
              />
              <a class="faint" :href="providerOf(account.provider)?.docsUrl" target="_blank" rel="noreferrer">where to get these</a>
            </div>
          </div>
        </div>
      </div>
      <p v-else class="empty">
        no accounts yet — pick a provider and add one below
      </p>

      <div class="grid" style="margin-top: 0.5rem">
        <label class="field">
          <span class="field__label">provider</span>
          <select v-model="newAccount.provider">
            <option v-for="option in providerOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
        </label>
        <label class="field">
          <span class="field__label">account id</span>
          <input v-model="newAccount.id" placeholder="cloudflare-home">
        </label>
        <div class="field field--check">
          <button type="button" class="btn btn--xs" :disabled="!canAddAccount" @click="addAccount">
            add account
          </button>
        </div>
      </div>
      <p class="field__hint">
        The account id names the account and keys its stored credentials: lowercase letters, digits, <code>-</code> and <code>_</code>.
      </p>
    </div>

    <div class="group">
      <div class="group__head">
        <span class="group__title">hostnames</span>
        <span class="view__spacer" />
        <span class="faint">{{ domains.length }} configured</span>
      </div>
      <p class="group__note">
        The whole list to keep updated — suba.domain.com, domain.xyz and so on.
      </p>

      <div v-if="domains.length > 0" class="stack">
        <div v-for="domain in domains" :key="domain.key" class="pane" style="border-bottom: 1px solid var(--line-soft)">
          <div class="grid" style="padding: 0.35rem 0">
            <label class="field">
              <span class="field__label">hostname</span>
              <input v-model="domain.host">
            </label>
            <label class="field">
              <span class="field__label">account</span>
              <select v-model="domain.account">
                <option v-for="option in accountOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
              </select>
            </label>
            <div class="field field--check">
              <input v-model="domain.enabled" type="checkbox">
              <span class="field__label">enabled</span>
            </div>
            <div class="field field--check">
              <span class="view__spacer" />
              <ConfirmButton label="remove" confirm-label="confirm remove" tone="danger" @confirm="removeDomain(domain)" />
            </div>
          </div>

          <div class="row" style="padding-bottom: 0.35rem">
            <label class="field field--check" style="padding-top: 0">
              <input :checked="domain.types.includes('A')" type="checkbox" @change="toggleType(domain, 'A', ($event.target as HTMLInputElement).checked)">
              <span class="field__label">A (IPv4)</span>
            </label>
            <label class="field field--check" style="padding-top: 0">
              <input
                :checked="domain.types.includes('AAAA')"
                type="checkbox"
                :disabled="accountProvider(domain)?.families.includes('AAAA') === false"
                @change="toggleType(domain, 'AAAA', ($event.target as HTMLInputElement).checked)"
              >
              <span class="field__label">AAAA (IPv6)</span>
            </label>
            <span v-if="accountProvider(domain)?.families.includes('AAAA') === false" class="field__hint">this provider cannot manage AAAA records</span>
            <label v-if="accountProvider(domain)?.proxied === true" class="field field--check" style="padding-top: 0">
              <input v-model="domain.proxied" type="checkbox">
              <span class="field__label">proxied (Cloudflare)</span>
            </label>
            <span v-if="domain.types.includes('AAAA') && !draft.ipv6.enabled" class="chip chip--warn">IPv6 detection is off</span>
          </div>

          <div class="grid" style="padding-bottom: 0.5rem">
            <label class="field">
              <span class="field__label">registered domain (optional)</span>
              <input :value="domain.zone ?? ''" placeholder="example.co.uk" @input="setOptional(domain, 'zone', ($event.target as HTMLInputElement).value)">
            </label>
            <label v-if="accountProvider(domain)?.ttl !== false" class="field">
              <span class="field__label">ttl override (s, optional)</span>
              <input
                :value="domain.ttl ?? ''"
                inputmode="numeric"
                min="1"
                @input="setOptional(domain, 'ttl', ($event.target as HTMLInputElement).value === '' ? undefined : Number(($event.target as HTMLInputElement).value))"
              >
            </label>
          </div>
        </div>
      </div>
      <p v-else class="empty">
        no hostnames yet
      </p>

      <div class="grid" style="margin-top: 0.5rem">
        <label class="field">
          <span class="field__label">hostname</span>
          <input v-model="newDomain.host" placeholder="home.example.com">
        </label>
        <label class="field">
          <span class="field__label">account</span>
          <select v-model="newDomain.account" :disabled="accounts.length === 0">
            <option v-for="option in accountOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
        </label>
        <div class="field field--check">
          <button type="button" class="btn btn--xs" :disabled="!canAddDomain" @click="addDomain">
            add hostname
          </button>
        </div>
      </div>
    </div>

    <div v-if="status !== null && status.records.length > 0" class="group">
      <div class="group__head">
        <span class="group__title">last pass</span>
        <span v-if="status.lastResult" class="faint">{{ status.lastResult }}</span>
        <span v-if="status.ipv4" class="faint mono">IPv4 {{ status.ipv4 }}</span>
        <span v-if="status.ipv6" class="faint mono">IPv6 {{ status.ipv6 }}</span>
        <span class="view__spacer" />
        <span v-if="status.lastRunAt" class="faint">{{ formatAgo(status.lastRunAt, control.now.value) }}</span>
      </div>
      <div class="tblwrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>hostname</th>
              <th>type</th>
              <th>state</th>
              <th>address</th>
              <th>detail</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="record in status.records" :key="`${record.host}|${record.type}`">
              <td class="id">
                {{ record.host }}
              </td>
              <td class="dim">
                {{ record.type }}
              </td>
              <td>
                <span class="chip" :class="RECORD_CHIP[record.state].chip">{{ RECORD_CHIP[record.state].label }}</span>
              </td>
              <td class="mono dim">
                {{ record.ip ?? '—' }}
              </td>
              <td class="dim">
                {{ record.message ?? '—' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </template>
</template>
