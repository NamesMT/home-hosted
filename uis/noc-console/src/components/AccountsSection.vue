<script setup lang="ts">
import type { AccountRow } from '@shared/api-client'
import { computed, onMounted, ref } from 'vue'
import ConfirmButton from '@/components/ConfirmButton.vue'
import * as api from '@/lib/api'
import { formatDateTime } from '@/lib/format'

/**
 * The panel's accounts: one credential signs in to the panel and authenticates the API.
 *
 * This replaced the password block and the token table. A row is one account — id, scopes, whether
 * it is disabled, where it may act — and creating one shows its secret exactly once, because only a
 * hash is stored.
 *
 * Two refusals make the page safe, and both come back as a sentence: you cannot revoke the account
 * you are signed in as, and you cannot revoke the last one that can sign in.
 */
const accounts = ref<AccountRow[]>([])
const loading = ref(true)
const error = ref<string | null>(null)
const busy = ref(false)

const creating = ref(false)
const id = ref('')
const label = ref('')
const scopes = ref<string[]>(['read'])
const workspaces = ref('')
const minted = ref<{ id: string, secret: string } | null>(null)

const SCOPE_HINTS: Record<string, string> = {
  read: 'every GET — state, logs, metrics',
  lifecycle: 'start, stop, restart, free a port, clear logs',
  config: 'server, workspace and settings writes, and backups',
  admin: 'everything, including managing accounts',
}

async function refresh(): Promise<void> {
  try {
    accounts.value = (await api.listAccounts()).accounts
    error.value = null
  }
  catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  }
  finally {
    loading.value = false
  }
}

onMounted(refresh)

function toggleScope(value: string): void {
  scopes.value = scopes.value.includes(value)
    ? scopes.value.filter(scope => scope !== value)
    : [...scopes.value, value]
}

async function create(): Promise<void> {
  if (id.value.trim().length === 0 || scopes.value.length === 0)
    return
  busy.value = true
  error.value = null
  try {
    const limited = workspaces.value.split(',').map(entry => entry.trim()).filter(entry => entry.length > 0)
    const created = await api.createAccount({
      id: id.value.trim(),
      ...(label.value.trim().length === 0 ? {} : { label: label.value.trim() }),
      scopes: scopes.value,
      ...(limited.length === 0 ? {} : { workspaces: limited }),
    })
    minted.value = { id: created.account.id, secret: created.secret }
    creating.value = false
    id.value = ''
    label.value = ''
    scopes.value = ['read']
    workspaces.value = ''
    await refresh()
  }
  catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  }
  finally {
    busy.value = false
  }
}

async function revoke(account: AccountRow): Promise<void> {
  busy.value = true
  error.value = null
  try {
    await api.revokeAccount(account.id)
    await refresh()
  }
  catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  }
  finally {
    busy.value = false
  }
}

async function toggleEnabled(account: AccountRow): Promise<void> {
  busy.value = true
  error.value = null
  try {
    await api.updateAccount(account.id, { enabled: !account.enabled })
    await refresh()
  }
  catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  }
  finally {
    busy.value = false
  }
}

/** The shared spelling: `YYYY-MM-DD HH:MM:SS`, like every other timestamp in the panel. */
function when(ms: number | undefined): string {
  if (ms === undefined)
    return 'never used'
  return formatDateTime(ms)
}

const scopeKeys = computed(() => Object.keys(SCOPE_HINTS))
const canCreate = computed(() => id.value.trim().length > 0 && scopes.value.length > 0)
</script>

<template>
  <div class="group">
    <h4 class="group__title">
      accounts
    </h4>
    <p class="faint" style="font-size: 11px">
      one account signs in to the panel and authenticates the API. A secret is shown once — only a
      hash is stored.
    </p>

    <div v-if="minted" class="note">
      <p class="field__label">
        new secret — copy it now, it is shown once
      </p>
      <input :value="minted.secret" readonly spellcheck="false" @focus="($event.target as HTMLInputElement).select()">
      <p class="faint mono" style="font-size: 11px">
        Authorization: Bearer {{ minted.id }}:{{ minted.secret }}
      </p>
      <div class="actions">
        <button type="button" class="btn btn--sm" @click="minted = null">
          done
        </button>
      </div>
    </div>

    <p v-if="loading" class="faint" style="font-size: 11px">
      loading…
    </p>
    <table v-else-if="accounts.length" class="tbl">
      <thead>
        <tr>
          <th class="tbl__keep">
            id
          </th>
          <th>scopes</th>
          <th>workspaces</th>
          <th>last used</th>
          <th class="tbl__actions">
            <span class="sr-only">actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="account in accounts" :key="account.id">
          <td class="tbl__keep">
            <span class="mono">{{ account.id }}</span>
            <span v-if="account.label !== account.id" class="faint label">{{ account.label }}</span>
            <span v-if="account.isDefault" class="chip chip--warn">first-run</span>
            <span v-if="!account.enabled" class="chip">disabled</span>
          </td>
          <td class="mono">
            {{ account.scopes.join(', ') }}
          </td>
          <td>{{ account.workspaces === undefined ? 'every workspace' : account.workspaces.join(', ') }}</td>
          <td class="faint">
            {{ when(account.lastUsedAt) }}
          </td>
          <td class="tbl__actions">
            <span class="actions">
              <!-- Disabling ends that account's sessions, so it confirms; enabling does not. -->
              <ConfirmButton
                v-if="account.enabled"
                label="disable"
                confirm-label="confirm disable"
                tone="danger"
                title="Disable this account?"
                hint="Its sessions end immediately and its secret stops working until you enable it again."
                :disabled="busy"
                @confirm="toggleEnabled(account)"
              />
              <button v-else type="button" class="btn btn--sm btn--ghost" :disabled="busy" @click="toggleEnabled(account)">
                enable
              </button>
              <ConfirmButton
                label="revoke"
                confirm-label="confirm revoke"
                tone="danger"
                title="Revoke this account?"
                hint="Its sessions end immediately and the secret stops working. This cannot be undone."
                :disabled="busy"
                @confirm="revoke(account)"
              />
            </span>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-else class="faint" style="font-size: 11px">
      no accounts yet
    </p>

    <div v-if="creating" class="group">
      <label class="field">
        <span class="field__label">account id</span>
        <input v-model="id" placeholder="admin" autocapitalize="none" spellcheck="false">
        <span class="field__hint">lowercase letters, digits, - and _, at most 40 characters — this is what you type to sign in</span>
      </label>
      <label class="field">
        <span class="field__label">label</span>
        <input v-model="label" placeholder="the deploy bot">
      </label>
      <div class="field">
        <span class="field__label">scopes</span>
        <label v-for="scope in scopeKeys" :key="scope" class="field field--check">
          <input type="checkbox" :checked="scopes.includes(scope)" @change="toggleScope(scope)">
          <span class="field__label">
            <span class="mono">{{ scope }}</span>
            <em class="dim label">— {{ SCOPE_HINTS[scope] }}</em>
          </span>
        </label>
      </div>
      <label class="field">
        <span class="field__label">limit to workspaces</span>
        <input v-model="workspaces" placeholder="default, staging">
        <span class="field__hint">comma-separated ids; empty means every workspace</span>
      </label>
      <div class="actions">
        <button type="button" class="btn btn--sm" @click="creating = false">
          cancel
        </button>
        <button type="button" class="btn btn--sm btn--primary" :disabled="busy || !canCreate" @click="create">
          create account
        </button>
      </div>
    </div>
    <div v-else class="actions">
      <button type="button" class="btn btn--sm" @click="creating = true">
        create account
      </button>
    </div>

    <p v-if="error" class="note note--error">
      {{ error }}
    </p>
  </div>
</template>
