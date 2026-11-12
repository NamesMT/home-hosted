<script setup lang="ts">
import { onMounted, ref } from 'vue'
import ConfirmButton from '@/components/settings/ConfirmButton.vue'
import Notice from '@/components/settings/Notice.vue'
import AppButton from '@/components/ui/AppButton.vue'
import CopyButton from '@/components/ui/CopyButton.vue'
import FieldGroup from '@/components/ui/FieldGroup.vue'
import TextField from '@/components/ui/TextField.vue'
import { t } from '@/i18n'
import * as api from '@/lib/api'

/**
 * The named, scoped API tokens: a table, a create dialog that shows the value once, and a revoke.
 *
 * The scopes are explained where a person picks them, because choosing one is the whole decision: a
 * monitor that only reads must not be handed a credential that can start servers. A token limited to
 * some workspaces is shown with its limit, since "why did this 403?" is answered by that column.
 *
 * **The value is displayed once, at creation.** The panel stores a hash, so there is nothing to show
 * a second time — and the table never asks for one.
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

/** The create form. */
const creating = ref(false)
const name = ref('')
const scopes = ref<string[]>(['read'])
const workspaces = ref('')
/** The minted value, held only until the dialog closes or the person leaves. */
const minted = ref<string | null>(null)

const SCOPE_OPTIONS = [
  { value: 'read', label: t('settings.tokens.scopeRead'), hint: t('settings.tokens.scopeReadHint') },
  { value: 'lifecycle', label: t('settings.tokens.scopeLifecycle'), hint: t('settings.tokens.scopeLifecycleHint') },
  { value: 'config', label: t('settings.tokens.scopeConfig'), hint: t('settings.tokens.scopeConfigHint') },
  { value: 'admin', label: t('settings.tokens.scopeAdmin'), hint: t('settings.tokens.scopeAdminHint') },
]

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
    // Held in `minted` for exactly as long as this dialog is open: the panel cannot show it again.
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

/** `dateStyle: 'medium'` through `Intl`, per the UI rules — never a hand-assembled date. */
function when(ms: number | undefined): string {
  if (ms === undefined)
    return t('settings.tokens.NeverUsed')
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(ms)
}
</script>

<template>
  <FieldGroup
    :title="t('settings.tokens.sTitle')"
    :description="t('settings.tokens.sDescription')"
    :columns="2"
  >
    <div class="sm:col-span-2">
      <div v-if="minted !== null" class="mb-3">
        <Notice tone="warn" :title="t('settings.tokens.ShownOnce')">
          <div class="mt-1 flex min-w-0 items-center gap-1.5 rounded-control border border-line bg-page/60 px-2.5 py-1.5">
            <code class="min-w-0 flex-1 truncate font-mono text-xs">{{ minted }}</code>
            <CopyButton :value="minted" />
          </div>
          <div class="mt-2">
            <AppButton size="xs" variant="ghost" @click="minted = null">
              {{ t('common.close') }}
            </AppButton>
          </div>
        </Notice>
      </div>

      <p v-if="loading" class="text-xs text-muted">
        {{ t('settings.tokens.sLoading') }}
      </p>
      <p v-else-if="tokens.length === 0" class="text-xs text-muted">
        {{ t('settings.tokens.sEmpty') }}
      </p>
      <table v-else class="w-full text-left text-xs">
        <thead>
          <tr class="border-b border-line-soft text-2xs text-faint">
            <th class="py-1.5 pr-2 font-medium">
              {{ t('settings.tokens.Name') }}
            </th>
            <th class="py-1.5 pr-2 font-medium">
              {{ t('settings.tokens.Scopes') }}
            </th>
            <th class="py-1.5 pr-2 font-medium">
              {{ t('settings.tokens.Workspaces') }}
            </th>
            <th class="py-1.5 pr-2 font-medium">
              {{ t('settings.tokens.LastUsed') }}
            </th>
            <th class="py-1.5 font-medium">
              <span class="sr-only">{{ t('settings.tokens.Actions') }}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="token in tokens" :key="token.id" class="border-b border-line-soft/60">
            <td class="py-1.5 pr-2">
              <span class="font-mono">{{ token.id }}</span>
              <span v-if="token.name !== token.id" class="ml-1.5 text-faint">{{ token.name }}</span>
            </td>
            <td class="py-1.5 pr-2 font-mono text-2xs">
              {{ token.scopes.join(', ') }}
            </td>
            <td class="py-1.5 pr-2 text-2xs">
              {{ token.workspaces === undefined ? t('settings.tokens.AllWorkspaces') : token.workspaces.join(', ') }}
            </td>
            <td class="py-1.5 pr-2 text-2xs text-faint">
              {{ when(token.lastUsedAt) }}
            </td>
            <td class="py-1.5 text-right">
              <ConfirmButton
                :label="t('settings.tokens.revokeToken')"
                :confirm-label="t('settings.tokens.revokeToken')"
                :title="t('settings.tokens.revokeTokenTitle')"
                :hint="t('settings.tokens.revokeTokenHint')"
                variant="ghost"
                size="xs"
                :disabled="busy"
                @confirm="revoke(token.id)"
              />
            </td>
          </tr>
        </tbody>
      </table>

      <div v-if="creating" class="mt-3 space-y-2 rounded-control border border-line-soft p-2.5">
        <TextField v-model="name" :label="t('settings.tokens.Name')" :placeholder="t('settings.tokens.NamePlaceholder')" />
        <div>
          <p class="mb-1 text-2xs font-medium text-muted">
            {{ t('settings.tokens.Scopes') }}
          </p>
          <div class="flex flex-col gap-1.5">
            <label v-for="option in SCOPE_OPTIONS" :key="option.value" class="flex cursor-pointer items-start gap-2 text-2xs">
              <input
                type="checkbox"
                :checked="scopes.includes(option.value)"
                class="mt-0.5"
                @change="toggleScope(option.value)"
              >
              <span>
                <span class="font-mono text-ink">{{ option.value }}</span>
                <span class="text-faint"> — {{ option.hint }}</span>
              </span>
            </label>
          </div>
        </div>
        <TextField
          v-model="workspaces"
          :label="t('settings.tokens.WorkspaceLimit')"
          :placeholder="t('settings.tokens.WorkspacePlaceholder')"
          :hint="t('settings.tokens.WorkspaceHint')"
        />
        <div class="flex gap-1.5">
          <AppButton size="xs" variant="primary" :loading="busy" :disabled="name.trim().length === 0 || scopes.length === 0" @click="mint">
            {{ t('settings.tokens.Create') }}
          </AppButton>
          <AppButton size="xs" variant="ghost" @click="creating = false; minted = null">
            {{ t('common.cancel') }}
          </AppButton>
        </div>
      </div>
      <div v-else class="mt-3">
        <AppButton size="xs" variant="secondary" @click="creating = true">
          {{ t('settings.tokens.Create') }}
        </AppButton>
      </div>

      <p v-if="error" class="mt-1 text-2xs text-danger">
        {{ error }}
      </p>
    </div>
  </FieldGroup>
</template>
