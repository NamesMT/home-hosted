<script setup lang="ts">
import type { TelegramStatus } from '@shared/contracts'
import type { TelegramForm } from '@/components/settings/settingsForm'
import { errorMessage } from '@shared/error-message'
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
import { useWorkspaces } from '@/composables/useWorkspaces'
import { t } from '@/i18n'
import * as api from '@/lib/api'
import { formatAgo } from '@/lib/format'

const props = defineProps<{
  status: TelegramStatus | null
  dirty: boolean
}>()

const emit = defineEmits<{ reset: [] }>()

const telegram = defineModel<TelegramForm>('telegram', { required: true })

const control = useControlPlane()
const workspace = useWorkspaces()

const cooldownMs = numberModel(() => telegram.value.cooldownMs, value => (telegram.value.cooldownMs = value), 120_000)

const tokenInput = ref('')
const tokenMessage = ref<string | null>(null)
const tokenError = ref<string | null>(null)
const detectedChats = ref<Array<{ id: number | string, title: string }>>([])
const busy = ref(false)

const tokenSet = computed(() => props.status?.tokenSet === true)
const lastResult = computed(() => props.status?.lastResult ?? null)
const lastResultAt = computed(() => props.status?.lastResultAt ?? null)
const tokenPlaceholder = computed(() => (tokenSet.value ? t('settings.telegram.tokenSavedPlaceholder') : t('settings.telegram.tokenPlaceholder')))

async function saveToken(): Promise<void> {
  busy.value = true
  tokenError.value = null
  tokenMessage.value = null
  try {
    const result = await api.saveTelegramToken(workspace.activeId.value, tokenInput.value.trim())
    tokenInput.value = ''
    tokenMessage.value = result.username
      ? t('settings.telegram.tokenSavedFor', { username: result.username })
      : t('settings.telegram.tokenSaved')
    await control.refresh()
  }
  catch (caught) {
    tokenError.value = errorMessage(caught)
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
    await api.clearTelegramToken(workspace.activeId.value)
    tokenMessage.value = t('settings.telegram.tokenRemoved')
    await control.refresh()
  }
  catch (caught) {
    tokenError.value = errorMessage(caught)
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
    const result = await api.detectTelegramChats(workspace.activeId.value, override.length > 0 ? { botToken: override } : {})
    detectedChats.value = result.chats
    if (result.chats.length === 0)
      tokenError.value = t('settings.telegram.noChats')
  }
  catch (caught) {
    tokenError.value = errorMessage(caught)
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
    const result = await api.sendTelegramTest(workspace.activeId.value, {
      chatId: telegram.value.chatId.length > 0 ? telegram.value.chatId : undefined,
      ...(override.length > 0 ? { botToken: override } : {}),
    })
    if (result.ok)
      tokenMessage.value = t('settings.telegram.testSent')
    else tokenError.value = result.error ?? t('settings.telegram.testFailed')
    await control.refresh()
  }
  catch (caught) {
    tokenError.value = errorMessage(caught)
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <FieldGroup
    :title="t('settings.telegram.title')"
    :description="t('settings.telegram.description')"
  >
    <template #actions>
      <AppButton size="xs" variant="ghost" :disabled="!props.dirty" @click="emit('reset')">
        {{ t('common.reset') }}
      </AppButton>
    </template>

    <ToggleSwitch
      v-model="telegram.enabled"
      :label="t('settings.telegram.enabled')"
      :hint="t('settings.telegram.enabledHint')"
      wide
    />
    <TextField
      v-model="telegram.chatId"
      :label="t('settings.telegram.chatId')"
      :placeholder="t('settings.telegram.chatIdPlaceholder')"
      :hint="t('settings.telegram.chatIdHint')"
    />
    <NumberField v-model="cooldownMs" :label="t('settings.telegram.cooldown')" :min="0" :hint="t('settings.telegram.cooldownHint')" />

    <ToggleSwitch v-model="telegram.onCrash" :label="t('settings.telegram.onCrash')" />
    <ToggleSwitch v-model="telegram.onUnhealthy" :label="t('settings.telegram.onUnhealthy')" />
    <ToggleSwitch v-model="telegram.onForcedRestart" :label="t('settings.telegram.onForcedRestart')" />
    <ToggleSwitch v-model="telegram.onRecovered" :label="t('settings.telegram.onRecovered')" />
    <ToggleSwitch
      v-model="telegram.onHost"
      :label="t('settings.telegram.onHost')"
      :hint="t('settings.telegram.onHostHint')"
      wide
    />
    <ToggleSwitch
      v-model="telegram.onDdns"
      :label="t('settings.telegram.onDdns')"
      :hint="t('settings.telegram.onDdnsHint')"
      wide
    />

    <div class="flex items-center gap-2 border-t border-line-soft pt-3 sm:col-span-2">
      <span class="text-xs font-medium text-muted">{{ t('settings.telegram.botToken') }}</span>
      <ToneBadge :tone="tokenSet ? 'ok' : 'warn'" dot>
        {{ tokenSet ? t('settings.telegram.tokenSet') : t('settings.telegram.noToken') }}
      </ToneBadge>
      <span class="text-2xs text-faint">{{ t('settings.telegram.tokenNote') }}</span>
    </div>

    <TextField
      v-model="tokenInput"
      type="password"
      autocomplete="off"
      :label="t('settings.telegram.botToken')"
      :placeholder="tokenPlaceholder"
      wide
    />

    <div class="flex flex-wrap items-center gap-2 sm:col-span-2">
      <AppButton variant="primary" :disabled="busy || tokenInput.trim().length === 0" :loading="busy && tokenInput.trim().length > 0" @click="saveToken">
        {{ t('settings.telegram.saveToken') }}
      </AppButton>
      <AppButton variant="secondary" :disabled="busy" @click="detectChats">
        {{ t('settings.telegram.detectChats') }}
      </AppButton>
      <AppButton variant="secondary" :disabled="busy" @click="sendTest">
        {{ t('settings.telegram.sendTest') }}
      </AppButton>
      <ConfirmButton
        v-if="tokenSet"
        :label="t('settings.telegram.removeToken')"
        :confirm-label="t('settings.telegram.removeTokenConfirm')"
        confirm-variant="danger"
        :title="t('settings.telegram.removeTokenTitle')"
        :hint="t('settings.telegram.removeTokenHint')"
        :disabled="busy"
        @confirm="removeToken"
      />
    </div>

    <div v-if="detectedChats.length > 0" class="sm:col-span-2">
      <p class="mb-1.5 text-xs text-muted">
        {{ t('settings.telegram.chatsSeen') }}
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
        {{ t('settings.telegram.lastSend', { result: lastResult }) }}{{ lastResultAt ? ` · ${formatAgo(lastResultAt, control.now.value)}` : '' }}
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
