<script setup lang="ts">
import type { TelegramStatus } from '@shared/contracts'
import type { TelegramForm } from '@/components/settings/settingsForm'
import { computed, ref } from 'vue'
import ConfirmButton from '@/components/settings/ConfirmButton.vue'
import Notice from '@/components/settings/Notice.vue'
import { numberModel } from '@/components/settings/settingsForm'
import AppButton from '@/components/ui/AppButton.vue'
import FieldGroup from '@/components/ui/FieldGroup.vue'
import NumberField from '@/components/ui/NumberField.vue'
import TextField from '@/components/ui/TextField.vue'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import ToneBadge from '@/components/ui/ToneBadge.vue'
import { useControlPlane } from '@/composables/useControlPlane'
import * as api from '@/lib/api'
import { formatAgo } from '@/lib/format'

const props = defineProps<{
  status: TelegramStatus | null
  dirty: boolean
}>()

const emit = defineEmits<{ reset: [] }>()

const telegram = defineModel<TelegramForm>('telegram', { required: true })

const control = useControlPlane()

const cooldownMs = numberModel(() => telegram.value.cooldownMs, value => (telegram.value.cooldownMs = value), 120_000)

const tokenInput = ref('')
const tokenMessage = ref<string | null>(null)
const tokenError = ref<string | null>(null)
const detectedChats = ref<Array<{ id: number | string, title: string }>>([])
const busy = ref(false)

const tokenSet = computed(() => props.status?.tokenSet === true)
const lastResult = computed(() => props.status?.lastResult ?? null)
const lastResultAt = computed(() => props.status?.lastResultAt ?? null)
const tokenPlaceholder = computed(() => (tokenSet.value ? 'Saved — type a new token to replace it' : '123456789:AA…'))

async function saveToken(): Promise<void> {
  busy.value = true
  tokenError.value = null
  tokenMessage.value = null
  try {
    const result = await api.saveTelegramToken(tokenInput.value.trim())
    tokenInput.value = ''
    tokenMessage.value = `Token saved${result.username ? ` for @${result.username}` : ''}.`
    await control.refresh()
  }
  catch (caught) {
    tokenError.value = caught instanceof Error ? caught.message : String(caught)
  }
  finally {
    busy.value = false
  }
}

async function removeToken(): Promise<void> {
  busy.value = true
  tokenError.value = null
  tokenMessage.value = null
  try {
    await api.clearTelegramToken()
    tokenMessage.value = 'Token removed.'
    await control.refresh()
  }
  catch (caught) {
    tokenError.value = caught instanceof Error ? caught.message : String(caught)
  }
  finally {
    busy.value = false
  }
}

async function detectChats(): Promise<void> {
  busy.value = true
  tokenError.value = null
  tokenMessage.value = null
  try {
    const override = tokenInput.value.trim()
    const result = await api.detectTelegramChats(override.length > 0 ? { botToken: override } : {})
    detectedChats.value = result.chats
    if (result.chats.length === 0)
      tokenError.value = 'No chats found. Send /start to the bot first, then detect again.'
  }
  catch (caught) {
    tokenError.value = caught instanceof Error ? caught.message : String(caught)
  }
  finally {
    busy.value = false
  }
}

async function sendTest(): Promise<void> {
  busy.value = true
  tokenError.value = null
  tokenMessage.value = null
  try {
    const override = tokenInput.value.trim()
    const result = await api.sendTelegramTest({
      chatId: telegram.value.chatId.length > 0 ? telegram.value.chatId : undefined,
      ...(override.length > 0 ? { botToken: override } : {}),
    })
    if (result.ok)
      tokenMessage.value = 'Test message sent.'
    else tokenError.value = result.error ?? 'The test message failed.'
    await control.refresh()
  }
  catch (caught) {
    tokenError.value = caught instanceof Error ? caught.message : String(caught)
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <FieldGroup
    title="Telegram"
    description="Policy lives in the config; the bot token is a secret and never comes back from the server."
  >
    <template #actions>
      <AppButton size="xs" variant="ghost" :disabled="!props.dirty" @click="emit('reset')">
        Reset
      </AppButton>
    </template>

    <ToggleSwitch
      v-model="telegram.enabled"
      label="Send notifications"
      hint="One message per event, throttled by the cooldown below."
      wide
    />
    <TextField
      v-model="telegram.chatId"
      label="Chat id"
      placeholder="123456789 or @channel"
      hint="Use Detect chats to fill this from the bot's updates."
    />
    <NumberField v-model="cooldownMs" label="Cooldown per event (ms)" :min="0" hint="Per server and reason, so a flapping server cannot spam." />

    <ToggleSwitch v-model="telegram.onCrash" label="Retries exhausted" />
    <ToggleSwitch v-model="telegram.onUnhealthy" label="Port unhealthy" />
    <ToggleSwitch v-model="telegram.onForcedRestart" label="Forced restart" />
    <ToggleSwitch v-model="telegram.onRecovered" label="Recovered" />
    <ToggleSwitch
      v-model="telegram.onHost"
      label="Host vitals breached"
      hint="Disk, memory, swap, load and CPU temperature, per the thresholds under Host vitals."
      wide
    />

    <div class="flex items-center gap-2 border-t border-line-soft pt-3 sm:col-span-2">
      <span class="text-xs font-medium text-muted">Bot token</span>
      <ToneBadge :tone="tokenSet ? 'ok' : 'warn'" dot>
        {{ tokenSet ? 'token set' : 'no token' }}
      </ToneBadge>
      <span class="text-2xs text-faint">From @BotFather — a secret, never in servers.config.json.</span>
    </div>

    <TextField
      v-model="tokenInput"
      type="password"
      autocomplete="off"
      label="Bot token"
      :placeholder="tokenPlaceholder"
      wide
    />

    <div class="flex flex-wrap items-center gap-2 sm:col-span-2">
      <AppButton variant="primary" :disabled="busy || tokenInput.trim().length === 0" :loading="busy && tokenInput.trim().length > 0" @click="saveToken">
        Save token
      </AppButton>
      <AppButton variant="secondary" :disabled="busy" @click="detectChats">
        Detect chats
      </AppButton>
      <AppButton variant="secondary" :disabled="busy" @click="sendTest">
        Send test
      </AppButton>
      <ConfirmButton
        v-if="tokenSet"
        label="Remove token"
        confirm-label="Confirm remove"
        confirm-variant="danger"
        :disabled="busy"
        @confirm="removeToken"
      />
    </div>

    <div v-if="detectedChats.length > 0" class="sm:col-span-2">
      <p class="mb-1.5 text-xs text-muted">
        Chats the bot has seen:
      </p>
      <div class="flex flex-wrap gap-1.5">
        <AppButton
          v-for="chat in detectedChats"
          :key="String(chat.id)"
          size="xs"
          variant="secondary"
          @click="telegram.chatId = String(chat.id)"
        >
          {{ chat.title }} ({{ chat.id }})
        </AppButton>
      </div>
    </div>

    <div v-if="lastResult" class="sm:col-span-2">
      <p class="text-2xs leading-4 text-faint">
        Last send: {{ lastResult }}{{ lastResultAt ? ` · ${formatAgo(lastResultAt, control.now.value)}` : '' }}
      </p>
    </div>

    <div v-if="tokenError || tokenMessage" class="space-y-2 sm:col-span-2">
      <Notice v-if="tokenError" tone="danger">
        {{ tokenError }}
      </Notice>
      <Notice v-if="tokenMessage" tone="ok">
        {{ tokenMessage }}
      </Notice>
    </div>
  </FieldGroup>
</template>
