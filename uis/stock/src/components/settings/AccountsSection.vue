<script setup lang="ts">
import type { AccountRow } from '@shared/api-client'
import { computed, onMounted, ref } from 'vue'
import ConfirmButton from '@/components/settings/ConfirmButton.vue'
import Notice from '@/components/settings/Notice.vue'
import AppButton from '@/components/ui/AppButton.vue'
import CopyButton from '@/components/ui/CopyButton.vue'
import FieldGroup from '@/components/ui/FieldGroup.vue'
import TextField from '@/components/ui/TextField.vue'
import { t } from '@/i18n'
import * as api from '@/lib/api'
import { formatDateTime } from '@/lib/format'

/**
 * The panel's **accounts**: one credential signs in to the panel and authenticates the API.
 *
 * This is what replaced the password section and the token table. A row is one account — its id, the
 * scopes it holds, whether it is disabled, and where it may act — and creating one shows its secret
 * exactly once, because only a hash is stored.
 *
 * **Two things are refused by design**, and the refusal is what makes the page safe: you cannot
 * revoke the account you are signed in as (that is a mistake, not an attack), and you cannot revoke
 * the last account that can sign in (that would leave the panel with no way in). Both are answered
 * with a sentence that says so, not a greyed-out button that does not explain itself.
 */
const accounts = ref<AccountRow[]>([])
const loading = ref(true)
const error = ref<string | null>(null)
const busy = ref(false)

/** The create form. */
const creating = ref(false)
const id = ref('')
const label = ref('')
const scopes = ref<string[]>(['read'])
const workspaces = ref('')
/** The minted secret, held only while the dialog is open. */
const minted = ref<{ id: string, secret: string } | null>(null)

/**
 * The scopes a person may grant, with the copy for each.
 *
 * Which of them a **workspace limit cannot narrow** comes from the panel (`scopes` on the accounts
 * answer), not from a list here: `proxy` and `admin` are panel-wide, and two UIs deciding that for
 * themselves is how the asterisk would come to mean two different things. Until that answer arrives
 * the mark is simply absent, which is honest — it is not a claim that every scope is narrowable.
 */
const SCOPE_OPTIONS = [
  { value: 'read', label: t('settings.accounts.scopeRead'), hint: t('settings.accounts.scopeReadHint') },
  { value: 'lifecycle', label: t('settings.accounts.scopeLifecycle'), hint: t('settings.accounts.scopeLifecycleHint') },
  { value: 'config', label: t('settings.accounts.scopeConfig'), hint: t('settings.accounts.scopeConfigHint') },
  { value: 'proxy', label: t('settings.accounts.scopeProxy'), hint: t('settings.accounts.scopeProxyHint') },
  { value: 'admin', label: t('settings.accounts.scopeAdmin'), hint: t('settings.accounts.scopeAdminHint') },
]

/** The scopes the panel says a workspace limit cannot narrow, so the UI can mark them `*`. */
const panelWide = ref<Set<string>>(new Set())

/** `admin*` — the asterisk the note below the list explains. */
function scopeMark(scope: string): string {
  return panelWide.value.has(scope) ? `${scope}*` : scope
}

async function refresh(): Promise<void> {
  try {
    const answer = await api.listAccounts()
    accounts.value = answer.accounts
    // A panel that predates the catalogue answers without it; the asterisk is then simply absent.
    panelWide.value = new Set((answer.scopes ?? []).filter(entry => !entry.workspaceLimited).map(entry => entry.scope))
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
    // Held only while this dialog is open: the panel cannot show it again.
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

/**
 * The shared timestamp helper — ISO, in the host's timezone, like every other date in the panel.
 *
 * A local `Intl.DateTimeFormat(undefined, …)` used to be here, and it followed the **browser**, which
 * is not the panel's language: with the UI set to 日本語 this one column still rendered
 * `Nov 16, 2026, 12:57 AM` while every other timestamp read `2026年11月17日 04:48:03` — measured in
 * Chromium on `/global/settings`. Dates are no longer localised at all (see `formatDateIso`): every
 * surface reads `YYYY-MM-DD HH:MM:SS`, so this column cannot drift from its neighbours again.
 */
function when(ms: number | undefined): string {
  if (ms === undefined)
    return t('settings.accounts.neverUsed')
  return formatDateTime(ms)
}

const canCreate = computed(() => id.value.trim().length > 0 && scopes.value.length > 0)
</script>

<template>
  <FieldGroup
    :title="t('settings.accounts.title')"
    :description="t('settings.accounts.description')"
    :columns="2"
  >
    <div class="sm:col-span-2">
      <Notice v-if="minted !== null" tone="warn" :title="t('settings.accounts.shownOnce')">
        <p class="mt-1 text-2xs text-muted">
          {{ t('settings.accounts.shownOnceDetail', { id: minted.id }) }}
        </p>
        <div class="mt-1 flex min-w-0 items-center gap-1.5 rounded-control border border-line bg-page/60 px-2.5 py-1.5">
          <code class="min-w-0 flex-1 truncate font-mono text-xs">{{ minted.secret }}</code>
          <CopyButton :value="minted.secret" />
        </div>
        <!--
          The header a script sends. Split so the interpolation is not read as copy: the prefix is a
          protocol literal, which no catalog translates, and the value is data.
        -->
        <p class="mt-1 text-2xs text-faint">
          <code class="font-mono">Authorization: Bearer {{ minted.id }}:{{ minted.secret }}</code>
        </p>
        <div class="mt-2">
          <AppButton size="xs" variant="ghost" @click="minted = null">
            {{ t('common.close') }}
          </AppButton>
        </div>
      </Notice>

      <p v-if="loading" class="text-xs text-muted">
        {{ t('settings.accounts.loading') }}
      </p>
      <!--
        The table scrolls in its own box: at 320 px its five columns want 346 px and, unwrapped,
        they grew the page scroller to 377 px — so `revoke` (329–377) sat past the right edge of a
        320 px window and the whole page scrolled sideways instead of the table. `RouteTable`
        wraps its table the same way.
      -->
      <div v-else-if="accounts.length > 0" class="overflow-x-auto scroll-hint-x">
        <table class="w-full text-left text-xs">
          <thead>
            <tr class="border-b border-line-soft text-2xs text-faint">
              <th class="py-1.5 pr-2 font-medium">
                {{ t('settings.accounts.id') }}
              </th>
              <th class="py-1.5 pr-2 font-medium">
                {{ t('settings.accounts.scopes') }}
              </th>
              <th class="py-1.5 pr-2 font-medium">
                {{ t('settings.accounts.workspaces') }}
              </th>
              <th class="py-1.5 pr-2 font-medium">
                {{ t('settings.accounts.lastUsed') }}
              </th>
              <th class="py-1.5 font-medium">
                <span class="sr-only">{{ t('settings.accounts.actions') }}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="account in accounts" :key="account.id" class="border-b border-line-soft/60">
              <td class="py-1.5 pr-2">
                <span class="font-mono">{{ account.id }}</span>
                <span v-if="account.label !== account.id" class="ml-1.5 text-faint">{{ account.label }}</span>
                <span v-if="account.isDefault" class="ml-1.5 rounded-full bg-warn-soft px-1.5 py-px text-2xs text-warn">
                  {{ t('settings.accounts.firstRun') }}
                </span>
                <span v-if="!account.enabled" class="ml-1.5 rounded-full bg-line px-1.5 py-px text-2xs text-muted">
                  {{ t('settings.accounts.disabled') }}
                </span>
              </td>
              <td class="py-1.5 pr-2 font-mono text-2xs">
                {{ account.scopes.map(scopeMark).join(', ') }}
              </td>
              <td class="py-1.5 pr-2 text-2xs">
                {{ account.workspaces === undefined ? t('settings.accounts.allWorkspaces') : account.workspaces.join(', ') }}
              </td>
              <td class="py-1.5 pr-2 text-2xs text-faint">
                {{ when(account.lastUsedAt) }}
              </td>
              <td class="py-1.5 text-right">
                <div class="flex justify-end gap-1">
                  <!--
                  Disabling ends that account's sessions, so it is a destructive act and confirms —
                  the repo's rule. **Enabling** is not: it hands access back and needs no ceremony.
                -->
                  <ConfirmButton
                    v-if="account.enabled"
                    :label="t('settings.accounts.disable')"
                    :confirm-label="t('settings.accounts.disable')"
                    :title="t('settings.accounts.disableTitle')"
                    :hint="t('settings.accounts.disableHint')"
                    variant="ghost"
                    size="xs"
                    :disabled="busy"
                    @confirm="toggleEnabled(account)"
                  />
                  <AppButton v-else size="xs" variant="ghost" :disabled="busy" @click="toggleEnabled(account)">
                    {{ t('settings.accounts.enable') }}
                  </AppButton>
                  <ConfirmButton
                    :label="t('settings.accounts.revoke')"
                    :confirm-label="t('settings.accounts.revoke')"
                    :title="t('settings.accounts.revokeTitle')"
                    :hint="t('settings.accounts.revokeHint')"
                    variant="ghost"
                    size="xs"
                    :disabled="busy"
                    @confirm="revoke(account)"
                  />
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="text-xs text-muted">
        {{ t('settings.accounts.empty') }}
      </p>

      <div v-if="creating" class="mt-3 space-y-2 rounded-control border border-line-soft p-2.5">
        <TextField v-model="id" :label="t('settings.accounts.id')" :placeholder="t('settings.accounts.idPlaceholder')" :hint="t('settings.accounts.idHint')" />
        <TextField v-model="label" :label="t('settings.accounts.label')" :placeholder="t('settings.accounts.labelPlaceholder')" />
        <div>
          <p class="mb-1 text-2xs font-medium text-muted">
            {{ t('settings.accounts.scopes') }}
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
                <span class="font-mono text-ink">{{ scopeMark(option.value) }}</span>
                <span class="text-faint"> — {{ option.hint }}</span>
              </span>
            </label>
          </div>
          <!-- One note for the whole list: repeating it beside each marked scope would be noise. -->
          <p v-if="panelWide.size > 0" class="mt-1.5 text-2xs leading-4 text-faint">
            {{ t('settings.accounts.panelWideNote') }}
          </p>
        </div>
        <TextField
          v-model="workspaces"
          :label="t('settings.accounts.workspaceLimit')"
          :placeholder="t('settings.accounts.workspacePlaceholder')"
          :hint="t('settings.accounts.workspaceHint')"
        />
        <div class="flex gap-1.5">
          <AppButton size="xs" variant="primary" :loading="busy" :disabled="!canCreate" @click="create">
            {{ t('settings.accounts.create') }}
          </AppButton>
          <AppButton size="xs" variant="ghost" @click="creating = false">
            {{ t('common.cancel') }}
          </AppButton>
        </div>
      </div>
      <div v-else class="mt-3">
        <AppButton size="xs" variant="secondary" @click="creating = true">
          {{ t('settings.accounts.create') }}
        </AppButton>
      </div>

      <p v-if="error" class="mt-1 text-2xs text-danger">
        {{ error }}
      </p>
    </div>
  </FieldGroup>
</template>
