<script setup lang="ts">
import type { DestinationStatusView } from '@shared/contracts'
import type { DestinationForm } from '@/components/settings/settingsForm'
import { errorMessage } from '@shared/error-message'
import { computed, ref } from 'vue'
import ConfirmButton from '@/components/settings/ConfirmButton.vue'
import Notice from '@/components/settings/Notice.vue'
import NotificationPolicyFields from '@/components/settings/NotificationPolicyFields.vue'
import AppButton from '@/components/ui/AppButton.vue'
import FieldGroup from '@/components/ui/FieldGroup.vue'
import SelectField from '@/components/ui/SelectField.vue'
import TextAreaField from '@/components/ui/TextAreaField.vue'
import TextField from '@/components/ui/TextField.vue'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import { useControlPlane } from '@/composables/useControlPlane'
import { useWorkspaces } from '@/composables/useWorkspaces'
import { t } from '@/i18n'
import * as api from '@/lib/api'
import { formatAgo } from '@/lib/format'

/**
 * Every destination, as one list.
 *
 * Telegram and a webhook differ in three fields and in nothing else that matters here: both are
 * something events go to, both have an `enabled` switch, both may follow the general block or
 * carry their own policy. Two sections made the shared policy look like a Telegram property, which
 * is the confusion this replaces.
 *
 * A Telegram destination's bot token is a secret, so it is saved through its own endpoint keyed by
 * the destination id — never as part of the settings patch.
 */
const props = defineProps<{
  statuses: DestinationStatusView[]
  dirty: boolean
}>()

const emit = defineEmits<{ reset: [] }>()

const destinations = defineModel<DestinationForm[]>('destinations', { required: true })

const control = useControlPlane()
const workspace = useWorkspaces()

/** Per-row transient state: a token being typed, and the row's own message. */
const tokenInputs = ref<Record<string, string>>({})
const tokenMessages = ref<Record<string, string>>({})
const busy = ref<string | null>(null)
const error = ref<string | null>(null)

const rows = computed(() => new Map(props.statuses.map(status => [status.id, status])))

function uniqueId(base: string, kind: DestinationForm['kind']): string {
  const existing = new Set(destinations.value.map(entry => entry.id))
  const seed = base.length > 0 ? base : kind
  if (!existing.has(seed))
    return seed
  let suffix = 2
  while (existing.has(`${seed}-${suffix}`))
    suffix += 1
  return `${seed}-${suffix}`
}

/** The schema defaults for a new row, so it inherits until somebody says otherwise. */
function blank(kind: DestinationForm['kind']): DestinationForm {
  return {
    id: uniqueId(kind, kind),
    kind,
    enabled: true,
    // A destination created here opts **into** inheritance: that is the point of the general block.
    useOwnSettings: false,
    chatId: '',
    tokenSet: false,
    url: '',
    method: 'POST',
    format: 'json',
    headers: '',
    policy: {
      onCrash: true,
      onUnhealthy: true,
      onForcedRestart: true,
      onRecovered: false,
      onHost: true,
      onDdns: true,
      cooldownMs: 120_000,
    },
  }
}

function add(kind: DestinationForm['kind']): void {
  destinations.value = [...destinations.value, blank(kind)]
}

function remove(id: string): void {
  destinations.value = destinations.value.filter(entry => entry.id !== id)
}

function lastSend(row: DestinationStatusView | undefined): string {
  // Both are optional on the wire: a panel that has never sent one, or a newer one that has not
  // published an outcome yet, is a row with nothing to show rather than an error.
  if (row === undefined || row.lastResult === null || row.lastResult === undefined)
    return ''
  return t('settings.destination.lastSend', {
    result: row.lastResult,
    when: row.lastResultAt === null || row.lastResultAt === undefined ? '' : formatAgo(row.lastResultAt, Date.now()),
  })
}

/** The shapes worth offering, so a person does not have to know a service's contract by heart. */
const presets = computed(() => [
  {
    id: 'ntfy',
    label: t('settings.webhook.presetNtfy'),
    // ntfy takes the message as the plain body and reads the title from a header.
    apply: (form: DestinationForm): void => {
      form.format = 'text'
      form.headers = 'Title: home-hosted\nPriority: default'
    },
  },
  {
    id: 'discord',
    label: t('settings.webhook.presetDiscord'),
    apply: (form: DestinationForm): void => { form.format = 'json'; form.headers = '' },
  },
  {
    id: 'slack',
    label: t('settings.webhook.presetSlack'),
    apply: (form: DestinationForm): void => { form.format = 'json'; form.headers = '' },
  },
])

async function saveToken(form: DestinationForm): Promise<void> {
  const token = (tokenInputs.value[form.id] ?? '').trim()
  if (token.length === 0)
    return
  busy.value = form.id
  error.value = null
  try {
    const result = await api.saveTelegramToken(workspace.activeId.value, form.id, token)
    tokenInputs.value[form.id] = ''
    tokenMessages.value[form.id] = result.username === null
      ? t('settings.telegram.tokenSaved')
      : t('settings.telegram.tokenSavedFor', { username: result.username })
    control.refresh()
  }
  catch (caught) {
    error.value = errorMessage(caught)
  }
  finally {
    busy.value = null
  }
}

async function removeToken(form: DestinationForm): Promise<void> {
  busy.value = form.id
  error.value = null
  try {
    await api.clearTelegramToken(workspace.activeId.value, form.id)
    tokenMessages.value[form.id] = t('settings.telegram.tokenRemoved')
    control.refresh()
  }
  catch (caught) {
    error.value = errorMessage(caught)
  }
  finally {
    busy.value = null
  }
}

async function detectChats(form: DestinationForm): Promise<void> {
  busy.value = form.id
  error.value = null
  try {
    const { chats } = await api.detectTelegramChats(workspace.activeId.value, form.id, {
      botToken: (tokenInputs.value[form.id] ?? '').trim() || undefined,
    })
    if (chats.length === 0)
      tokenMessages.value[form.id] = t('settings.telegram.noChats')
    else
      form.chatId = String(chats[0]!.id)
  }
  catch (caught) {
    error.value = errorMessage(caught)
  }
  finally {
    busy.value = null
  }
}

async function sendTest(form: DestinationForm): Promise<void> {
  busy.value = form.id
  error.value = null
  try {
    if (form.kind === 'telegram') {
      await api.sendTelegramTest(workspace.activeId.value, form.id, { chatId: form.chatId || undefined })
    }
    else {
      // The draft travels whole, so an unsaved URL and headers are what gets tested.
      await api.testWebhook(workspace.activeId.value, {
        target: {
          url: form.url,
          method: form.method,
          format: form.format,
          headers: form.headers,
          enabled: form.enabled,
          cooldownMs: form.policy.cooldownMs,
          onCrash: form.policy.onCrash,
          onUnhealthy: form.policy.onUnhealthy,
          onForcedRestart: form.policy.onForcedRestart,
          onRecovered: form.policy.onRecovered,
          onHost: form.policy.onHost,
          onDdns: form.policy.onDdns,
        },
        id: form.id,
      })
    }
    tokenMessages.value[form.id] = t('settings.destination.testSent')
    control.refresh()
  }
  catch (caught) {
    error.value = errorMessage(caught)
  }
  finally {
    busy.value = null
  }
}

function tokenPlaceholder(form: DestinationForm): string {
  return form.tokenSet
    ? t('settings.telegram.tokenSavedPlaceholder')
    : t('settings.telegram.tokenPlaceholder')
}
</script>

<template>
  <FieldGroup
    :title="t('settings.destination.title')"
    :description="t('settings.destination.description')"
    :columns="1"
  >
    <template #actions>
      <div class="flex flex-wrap items-center gap-1.5">
        <AppButton size="xs" variant="ghost" :disabled="!props.dirty" @click="emit('reset')">
          {{ t('common.reset') }}
        </AppButton>
        <AppButton size="xs" variant="secondary" @click="add('telegram')">
          {{ t('settings.destination.addTelegram') }}
        </AppButton>
        <AppButton size="xs" variant="primary" @click="add('webhook')">
          {{ t('settings.destination.addWebhook') }}
        </AppButton>
      </div>
    </template>

    <p v-if="destinations.length === 0" class="text-xs text-muted">
      {{ t('settings.destination.empty') }}
    </p>

    <div
      v-for="form in destinations"
      :key="form.id"
      class="flex min-w-0 flex-col gap-2 rounded-control border border-line bg-page/60 p-2.5"
    >
      <div class="flex items-center gap-2">
        <ToggleSwitch v-model="form.enabled" :label="form.kind === 'telegram' ? t('settings.telegram.title') : t('settings.webhook.title')" />
        <span class="min-w-0 flex-1 truncate font-mono text-2xs text-muted">{{ form.id }}</span>
        <ConfirmButton
          :label="t('settings.destination.remove')"
          :question="t('settings.destination.removeQuestion', { name: form.id })"
          :body="t('settings.destination.removeBody')"
          @confirm="remove(form.id)"
        />
      </div>

      <!-- Telegram: the chat, and its own bot token. -->
      <template v-if="form.kind === 'telegram'">
        <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <TextField
            v-model="form.chatId"
            :label="t('settings.destination.chatId')"
            :hint="t('settings.destination.chatIdHint')"
            :placeholder="t('settings.telegram.chatIdPlaceholder')"
          />
          <div class="flex items-end gap-1.5">
            <AppButton size="xs" variant="ghost" :disabled="busy === form.id" @click="detectChats(form)">
              {{ t('settings.destination.detectChats') }}
            </AppButton>
          </div>
        </div>

        <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <TextField
            v-model="tokenInputs[form.id]"
            :label="t('settings.destination.botToken')"
            :placeholder="tokenPlaceholder(form)"
            :hint="t('settings.telegram.tokenNote')"
          />
          <div class="flex items-end gap-1.5">
            <AppButton
              size="xs"
              :disabled="busy === form.id || (tokenInputs[form.id] ?? '').trim().length === 0"
              @click="saveToken(form)"
            >
              {{ t('settings.destination.saveToken') }}
            </AppButton>
            <ConfirmButton
              v-if="form.tokenSet"
              :label="t('settings.telegram.removeToken')"
              :question="t('settings.telegram.removeTokenTitle')"
              :body="t('settings.telegram.removeTokenHint')"
              @confirm="removeToken(form)"
            />
          </div>
        </div>
        <span class="text-2xs text-muted">
          {{ form.tokenSet ? t('settings.destination.tokenSet') : t('settings.destination.noToken') }}
        </span>
      </template>

      <!-- Webhook: URL, method, body format, headers. -->
      <template v-else>
        <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <TextField v-model="form.url" class="sm:col-span-2" :label="t('settings.webhook.url')" :placeholder="t('settings.webhook.urlPlaceholder')" />
          <SelectField
            v-model="form.method"
            :label="t('settings.webhook.method')"
            :options="[{ value: 'POST', label: 'POST' }, { value: 'PUT', label: 'PUT' }]"
          />
          <SelectField
            v-model="form.format"
            :label="t('settings.webhook.format')"
            :options="[{ value: 'json', label: t('settings.webhook.formatJson') }, { value: 'text', label: t('settings.webhook.formatText') }]"
            :hint="t('settings.webhook.formatHint')"
          />
        </div>
        <!-- A textarea: one `Name: value` per line, so Enter must not submit the form. -->
        <TextAreaField
          v-model="form.headers"
          :label="t('settings.webhook.headers')"
          :hint="t('settings.webhook.headersHint')"
          placeholder="Authorization: Bearer …"
          :rows="2"
          mono
        />
        <div class="flex flex-wrap items-center gap-1.5">
          <span class="text-2xs font-medium uppercase tracking-wide text-muted">{{ t('settings.webhook.presets') }}</span>
          <AppButton
            v-for="preset in presets"
            :key="preset.id"
            size="xs"
            variant="ghost"
            @click="preset.apply(form)"
          >
            {{ preset.label }}
          </AppButton>
        </div>
      </template>

      <!--
        One switch, then this destination's own policy only when it carries one. Off shows nothing:
        the general block is the section directly above, so echoing its values per row is noise.
      -->
      <ToggleSwitch
        v-model="form.useOwnSettings"
        :label="t('settings.destination.ownSettings')"
        :hint="t('settings.destination.ownSettingsHint')"
      />
      <div v-if="form.useOwnSettings" class="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <NotificationPolicyFields v-model="form.policy" />
      </div>

      <div class="flex flex-wrap items-center gap-1.5">
        <AppButton size="xs" :disabled="busy === form.id" @click="sendTest(form)">
          {{ busy === form.id ? t('common.sending') : t('settings.destination.sendTest') }}
        </AppButton>
        <span v-if="tokenMessages[form.id]" class="text-2xs text-ok">{{ tokenMessages[form.id] }}</span>
        <span v-if="lastSend(rows.get(form.id))" class="text-2xs text-muted">{{ lastSend(rows.get(form.id)) }}</span>
      </div>
    </div>

    <Notice v-if="error !== null" tone="danger" :title="t('views.settings.saveFailed')">
      {{ error }}
    </Notice>
  </FieldGroup>
</template>
