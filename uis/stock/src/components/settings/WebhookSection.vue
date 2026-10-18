<script setup lang="ts">
import type { WebhookStatus } from '@shared/contracts'
import type { WebhookForm } from '@/components/settings/settingsForm'
import { errorMessage } from '@shared/error-message'
import { computed, ref } from 'vue'
import ConfirmButton from '@/components/settings/ConfirmButton.vue'
import { numberModel } from '@/components/settings/settingsForm'
import AppButton from '@/components/ui/AppButton.vue'
import FieldGroup from '@/components/ui/FieldGroup.vue'
import NumberField from '@/components/ui/NumberField.vue'
import SelectField from '@/components/ui/SelectField.vue'
import TextField from '@/components/ui/TextField.vue'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import { useControlPlane } from '@/composables/useControlPlane'
import { useWorkspaces } from '@/composables/useWorkspaces'
import { t } from '@/i18n'
import * as api from '@/lib/api'
import { formatAgo } from '@/lib/format'

/**
 * The general outbound transport, as a list.
 *
 * A target carries its own URL, method, body format and headers, which is what lets the same
 * form configure ntfy (plain body, `Title:`/`Priority:` headers), Discord or Slack (JSON), and
 * a bearer-token endpoint (`Authorization:`). The page names those three as presets so the
 * common cases do not require knowing the contract by heart.
 */
const props = defineProps<{
  statuses: WebhookStatus[]
  dirty: boolean
}>()

const emit = defineEmits<{ reset: [] }>()

const webhooks = defineModel<WebhookForm[]>('webhooks', { required: true })

const control = useControlPlane()
const workspace = useWorkspaces()

const busy = ref<string | null>(null)
const message = ref<string | null>(null)
const error = ref<string | null>(null)

/** Results by id: a draft has no row, and adding one must not shift every later row's line. */
const rowById = computed(() => new Map(props.statuses.map(status => [status.id, status])))

/** A stable id from a label, so a person never has to invent one. */
function idFrom(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return slug.length > 0 ? slug : `hook-${Date.now().toString(36)}`
}

function add(): void {
  const existing = new Set(webhooks.value.map(form => form.id))
  let id = idFrom(t('settings.webhook.newTarget'))
  let suffix = 2
  while (existing.has(id))
    id = `${idFrom(t('settings.webhook.newTarget'))}-${suffix++}`

  webhooks.value = [...webhooks.value, {
    id,
    url: '',
    enabled: true,
    method: 'POST',
    format: 'json',
    headers: '',
    cooldownMs: 120_000,
    onCrash: true,
    onUnhealthy: true,
    onForcedRestart: true,
    onRecovered: false,
    onHost: true,
    onDdns: true,
  }]
}

function remove(id: string): void {
  webhooks.value = webhooks.value.filter(form => form.id !== id)
}

/** The form's own copy, so the row's `cooldownMs` is a number field that writes back. */
function cooldown(form: WebhookForm) {
  return numberModel(() => form.cooldownMs, (value) => { form.cooldownMs = value }, 120_000)
}

/**
 * The three shapes worth offering, so a person does not have to know a service's contract.
 *
 * Each fills the fields that service needs and leaves the rest alone. `ntfy` is the one that
 * needs `format: text` and the title header — the reason the webhook transport has those two
 * fields at all.
 */
const presets = computed(() => [
  {
    id: 'ntfy',
    label: t('settings.webhook.presetNtfy'),
    apply: (form: WebhookForm): void => {
      form.format = 'text'
      form.headers = `Title: home-hosted\nPriority: default`
    },
  },
  {
    id: 'discord',
    label: t('settings.webhook.presetDiscord'),
    apply: (form: WebhookForm): void => {
      form.format = 'json'
      // Discord reads `content`, which the payload always carries.
      form.headers = ''
    },
  },
  {
    id: 'slack',
    label: t('settings.webhook.presetSlack'),
    apply: (form: WebhookForm): void => {
      form.format = 'json'
      form.headers = ''
    },
  },
])

/** The "last send" line for one row, or an empty string while it has never sent. */
function lastSend(row: WebhookStatus | undefined): string {
  if (row === undefined || row.lastResult === null)
    return ''
  return t('settings.webhook.lastSend', {
    result: row.lastResult,
    when: row.lastResultAt === null ? '' : formatAgo(row.lastResultAt, Date.now()),
  })
}

async function sendTest(form: WebhookForm): Promise<void> {
  busy.value = form.id
  message.value = null
  error.value = null
  try {
    // The draft travels whole, so an unsaved URL and headers are what gets tested.
    await api.testWebhook(workspace.activeId.value, {
      target: {
        url: form.url,
        method: form.method,
        format: form.format,
        headers: form.headers,
        // The policy fields are not used by a test; they come from the target's own values.
        enabled: form.enabled,
        cooldownMs: form.cooldownMs,
        onCrash: form.onCrash,
        onUnhealthy: form.onUnhealthy,
        onForcedRestart: form.onForcedRestart,
        onRecovered: form.onRecovered,
        onHost: form.onHost,
        onDdns: form.onDdns,
      },
      id: form.id,
    })
    message.value = t('settings.webhook.testSent')
    control.refresh()
  }
  catch (caught) {
    error.value = errorMessage(caught)
  }
  finally {
    busy.value = null
  }
}
</script>

<template>
  <div class="space-y-3">
    <FieldGroup
      :title="t('settings.webhook.title')"
      :description="t('settings.webhook.description')"
    >
      <template #actions>
        <div class="flex items-center gap-1.5">
          <AppButton size="xs" variant="ghost" :disabled="!props.dirty" @click="emit('reset')">
            {{ t('common.reset') }}
          </AppButton>
          <AppButton size="xs" variant="primary" @click="add">
            {{ t('settings.webhook.add') }}
          </AppButton>
        </div>
      </template>

      <p v-if="webhooks.length === 0" class="text-xs text-muted sm:col-span-2">
        {{ t('settings.webhook.empty') }}
      </p>

      <div v-for="hook in webhooks" :key="hook.id" class="flex min-w-0 flex-col gap-2 rounded-control border border-line bg-page/60 p-2.5 sm:col-span-2">
        <div class="flex items-center gap-2">
          <ToggleSwitch v-model="hook.enabled" :label="hook.id" />
          <span class="flex-1" />
          <ConfirmButton
            :label="t('common.remove')"
            :question="t('settings.webhook.removeQuestion', { name: hook.id })"
            :body="t('settings.webhook.removeBody')"
            @confirm="remove(hook.id)"
          />
        </div>

        <div class="grid gap-2 sm:grid-cols-3">
          <TextField v-model="hook.url" class="sm:col-span-2" :label="t('settings.webhook.url')" :placeholder="t('settings.webhook.urlPlaceholder')" />
          <SelectField
            v-model="hook.method"
            :label="t('settings.webhook.method')"
            :options="[
              { value: 'POST', label: 'POST' },
              { value: 'PUT', label: 'PUT' },
            ]"
          />
          <SelectField
            v-model="hook.format"
            :label="t('settings.webhook.format')"
            :options="[
              { value: 'json', label: t('settings.webhook.formatJson') },
              { value: 'text', label: t('settings.webhook.formatText') },
            ]"
            :hint="t('settings.webhook.formatHint')"
          />
          <NumberField :model-value="hook.cooldownMs" :label="t('settings.webhook.cooldown')" :min="0" :hint="t('settings.webhook.cooldownHint')" @update:model-value="cooldown(hook).value = $event" />
        </div>

        <TextField
          v-model="hook.headers"
          :label="t('settings.webhook.headers')"
          placeholder="Authorization: Bearer …"
          :hint="t('settings.webhook.headersHint')"
          multiline
        />

        <div class="flex flex-wrap items-center gap-1.5">
          <span class="text-2xs font-medium uppercase tracking-wide text-muted">{{ t('settings.webhook.presets') }}</span>
          <AppButton
            v-for="preset in presets"
            :key="preset.id"
            size="xs"
            variant="ghost"
            @click="preset.apply(hook)"
          >
            {{ preset.label }}
          </AppButton>
          <span class="flex-1" />
          <AppButton size="xs" :disabled="busy === hook.id || hook.url.length === 0" @click="sendTest(hook)">
            {{ busy === hook.id ? t('common.sending') : t('settings.webhook.sendTest') }}
          </AppButton>
        </div>

        <p v-if="rowById.get(hook.id)?.lastResult != null" class="text-2xs text-muted">
          {{ lastSend(rowById.get(hook.id)) }}
        </p>
      </div>

      <p v-if="message !== null" class="text-xs text-ok sm:col-span-2">
        {{ message }}
      </p>
      <p v-if="error !== null" class="text-xs text-danger sm:col-span-2">
        {{ error }}
      </p>
    </FieldGroup>
  </div>
</template>
