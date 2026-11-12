<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import ConfirmButton from '@/components/ConfirmButton.vue'
import * as api from '@/lib/api'

/**
 * The named, scoped API tokens: a table, a create form, and a revoke.
 *
 * The scopes are explained where they are chosen, because that is the whole decision: a monitor that
 * only reads must not be handed a credential that can start servers. The value is displayed **once**,
 * at creation — the panel keeps a hash, so there is nothing to show later, and the table never asks.
 */
interface TokenRow {
  id: string
  name: string
  scopes: string[]
  workspaces?: string[]
  createdAt: number
  lastUsedAt?: number
}

const tokens = ref<TokenRow[]>([])
const loading = ref(true)
const error = ref<string | null>(null)
const busy = ref(false)

const creating = ref(false)
const name = ref('')
const scopes = ref<string[]>(['read'])
const workspaces = ref('')
const minted = ref<string | null>(null)

const SCOPE_HINTS: Record<string, string> = {
  read: 'every GET — state, logs, metrics',
  lifecycle: 'start, stop, restart, free a port, clear logs',
  config: 'server, workspace and settings writes, and backups',
  admin: 'everything, including tokens, the password and UI install',
}

async function refresh(): Promise<void> {
  try {
    tokens.value = (await api.listApiTokens()).tokens
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

async function mint(): Promise<void> {
  if (name.value.trim().length === 0 || scopes.value.length === 0)
    return
  busy.value = true
  error.value = null
  try {
    const limited = workspaces.value.split(',').map(entry => entry.trim()).filter(entry => entry.length > 0)
    const created = await api.createApiToken({
      name: name.value.trim(),
      scopes: scopes.value,
      ...(limited.length === 0 ? {} : { workspaces: limited }),
    })
    minted.value = created.token
    creating.value = false
    name.value = ''
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

async function revoke(id: string): Promise<void> {
  busy.value = true
  error.value = null
  try {
    await api.revokeNamedApiToken(id)
    await refresh()
  }
  catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  }
  finally {
    busy.value = false
  }
}

/** `Intl`, per the UI rules — never a hand-assembled date. */
function when(ms: number | undefined): string {
  if (ms === undefined)
    return 'never used'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(ms)
}

const scopeKeys = computed(() => Object.keys(SCOPE_HINTS))
</script>

<template>
  <div class="group">
    <h4 class="group__title">
      API tokens
    </h4>
    <p class="faint" style="font-size: 11px">
      each has its own scopes, so a monitor that only reads does not hold a credential that can start
      servers. The value is shown once — the panel keeps only a hash.
    </p>

    <label v-if="minted" class="field">
      <span class="field__label">new token — copy it now, it is shown once</span>
      <input :value="minted" readonly spellcheck="false" @focus="($event.target as HTMLInputElement).select()">
    </label>
    <div v-if="minted" class="actions">
      <button type="button" class="btn btn--sm" @click="minted = null">
        done
      </button>
    </div>

    <p v-if="loading" class="faint" style="font-size: 11px">
      loading…
    </p>
    <table v-else-if="tokens.length" class="tbl">
      <thead>
        <tr>
          <th>name</th>
          <th>scopes</th>
          <th>workspaces</th>
          <th>last used</th>
          <th><span class="sr-only">actions</span></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="token in tokens" :key="token.id">
          <td>
            <span class="mono">{{ token.id }}</span>
            <span v-if="token.name !== token.id" class="faint"> {{ token.name }}</span>
          </td>
          <td class="mono">
            {{ token.scopes.join(', ') }}
          </td>
          <td>{{ token.workspaces === undefined ? 'every workspace' : token.workspaces.join(', ') }}</td>
          <td class="faint">
            {{ when(token.lastUsedAt) }}
          </td>
          <td class="actions">
            <ConfirmButton
              label="revoke"
              confirm-label="confirm revoke"
              tone="danger"
              title="Revoke this token?"
              hint="It stops working immediately and cannot be restored — issue a new one instead."
              :disabled="busy"
              @confirm="revoke(token.id)"
            />
          </td>
        </tr>
      </tbody>
    </table>
    <p v-else class="faint" style="font-size: 11px">
      no named tokens yet — the panel-wide token above is the one scripts use
    </p>

    <div v-if="creating" class="group">
      <label class="field">
        <span class="field__label">name</span>
        <input v-model="name" placeholder="monitor">
      </label>
      <div class="field">
        <span class="field__label">scopes</span>
        <label v-for="scope in scopeKeys" :key="scope" class="field field--check">
          <input type="checkbox" :checked="scopes.includes(scope)" @change="toggleScope(scope)">
          <span class="field__label">
            <span class="mono">{{ scope }}</span>
            <em class="dim">— {{ SCOPE_HINTS[scope] }}</em>
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
        <button
          type="button"
          class="btn btn--sm btn--primary"
          :disabled="busy || name.trim().length === 0 || scopes.length === 0"
          @click="mint"
        >
          create token
        </button>
      </div>
    </div>
    <div v-else class="actions">
      <button type="button" class="btn btn--sm" @click="creating = true">
        create token
      </button>
    </div>

    <p v-if="error" class="note note--error">
      {{ error }}
    </p>
  </div>
</template>
