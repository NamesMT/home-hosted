<script setup lang="ts">
import type { ControlView } from '@shared/contracts'
import type { AuthForm } from '@/components/settings/settingsForm'
import { computed, ref } from 'vue'
import ConfirmButton from '@/components/settings/ConfirmButton.vue'
import Notice from '@/components/settings/Notice.vue'
import { numberModel } from '@/components/settings/settingsForm'
import AppButton from '@/components/ui/AppButton.vue'
import FieldGroup from '@/components/ui/FieldGroup.vue'
import NumberField from '@/components/ui/NumberField.vue'
import SelectField from '@/components/ui/SelectField.vue'
import TextField from '@/components/ui/TextField.vue'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import TransText from '@/components/ui/TransText.vue'
import { useSession } from '@/composables/useSession'
import { t } from '@/i18n'

const props = defineProps<{
  view: ControlView | null
  dirty: boolean
}>()

const emit = defineEmits<{ reset: [] }>()

const auth = defineModel<AuthForm>('auth', { required: true })

const sessionTtlMs = numberModel(() => auth.value.sessionTtlMs, value => (auth.value.sessionTtlMs = value), 604_800_000)
const maxLoginAttempts = numberModel(() => auth.value.maxLoginAttempts, value => (auth.value.maxLoginAttempts = value), 5)
const lockoutMs = numberModel(() => auth.value.lockoutMs, value => (auth.value.lockoutMs = value), 60_000)

const passwordSet = computed(() => props.view?.auth.passwordSet === true)
const apiTokenSet = computed(() => props.view?.auth.apiTokenSet === true)
const blockedReason = computed(() => props.view?.auth.blockedReason ?? null)
const exposed = computed(() => props.view?.auth.exposed === true)
const usingDefault = computed(() => props.view?.auth.usingDefaultPassword === true)
const enabledWithoutPassword = computed(() => auth.value.enabled && !passwordSet.value)

// The password is a secret with its own endpoints (`POST`/`DELETE /api/auth/password`)
// rather than part of the settings patch, but it belongs to this section: the
// policy and the credential are one decision.
const { setPassword, clearPassword } = useSession()
const currentPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const passwordMessage = ref<string | null>(null)
const passwordError = ref<string | null>(null)
const passwordSaving = ref(false)

const mismatch = computed(() => confirmPassword.value.length > 0 && confirmPassword.value !== newPassword.value)
const short = computed(() => newPassword.value.length > 0 && newPassword.value.length < 8)
const canSubmit = computed(() => newPassword.value.length > 0 && !mismatch.value && (!passwordSet.value || currentPassword.value.length > 0))

async function submitPassword(): Promise<void> {
  if (!canSubmit.value || passwordSaving.value)
    return
  passwordSaving.value = true
  passwordError.value = null
  passwordMessage.value = null
  try {
    const failure = await setPassword(passwordSet.value ? currentPassword.value : undefined, newPassword.value)
    if (failure !== null) {
      passwordError.value = failure
      return
    }
    currentPassword.value = ''
    newPassword.value = ''
    confirmPassword.value = ''
    passwordMessage.value = t('settings.auth.passwordUpdated')
  }
  finally {
    passwordSaving.value = false
  }
}

async function clearPasswordValue(): Promise<void> {
  passwordError.value = null
  passwordMessage.value = null
  const failure = await clearPassword()
  if (failure !== null)
    passwordError.value = failure
  else passwordMessage.value = t('settings.auth.passwordCleared')
}
</script>

<template>
  <FieldGroup
    :title="t('settings.auth.policyTitle')"
    :description="t('settings.auth.policyDescription')"
  >
    <template #actions>
      <AppButton size="xs" variant="ghost" :disabled="!props.dirty" @click="emit('reset')">
        {{ t('common.reset') }}
      </AppButton>
    </template>

    <ToggleSwitch
      v-model="auth.enabled"
      :label="t('settings.auth.requirePassword')"
      :hint="t('settings.auth.requirePasswordHint')"
      class="sm:col-span-2"
    />
    <NumberField v-model="sessionTtlMs" :label="t('settings.auth.sessionLifetime')" :min="60000" :hint="t('settings.auth.sessionLifetimeHint')" />
    <SelectField
      v-model="auth.cookieSecure"
      :label="t('settings.auth.cookieSecure')"
      :options="[
        { value: 'auto', label: t('settings.auth.cookieSecureAuto') },
        { value: 'always', label: t('settings.auth.cookieSecureAlways') },
        { value: 'never', label: t('settings.auth.cookieSecureNever') },
      ]"
    />
    <SelectField
      v-model="auth.trustProxy"
      :label="t('settings.auth.trustProxy')"
      :options="[
        { value: 'off', label: t('settings.auth.trustProxyOff') },
        { value: 'loopback', label: t('settings.auth.trustProxyLoopback') },
        { value: 'any', label: t('settings.auth.trustProxyAny') },
      ]"
      :hint="t('settings.auth.trustProxyHint')"
      class="sm:col-span-2"
    />
    <NumberField v-model="maxLoginAttempts" :label="t('settings.auth.maxLoginAttempts')" :min="1" :hint="t('settings.auth.maxLoginAttemptsHint')" />
    <NumberField v-model="lockoutMs" :label="t('settings.auth.lockout')" :min="1000" />
  </FieldGroup>

  <div class="space-y-2">
    <Notice
      :tone="apiTokenSet ? 'info' : 'neutral'"
      :title="apiTokenSet ? t('settings.auth.apiTokenSet') : t('settings.auth.apiTokenMissing')"
    >
      <TransText v-if="apiTokenSet" k="settings.auth.apiTokenNote">
        <template #code>
          <code>Authorization: Bearer …</code>
        </template>
      </TransText>
      <TransText v-else k="settings.auth.noTokenNote">
        <template #command>
          <code>home-hosted set-token --generate</code>
        </template>
      </TransText>
    </Notice>
    <Notice v-if="usingDefault" tone="warn" :title="t('settings.auth.defaultPasswordTitle')">
      <TransText k="settings.auth.defaultPasswordText">
        <template #address>
          <code>127.0.0.1</code>
        </template>
      </TransText>
    </Notice>
    <Notice v-if="blockedReason" tone="danger" :title="t('settings.auth.blockedTitle')">
      {{ blockedReason }}
    </Notice>
    <Notice v-else-if="enabledWithoutPassword" tone="warn" :title="t('settings.auth.noPasswordTitle')">
      <TransText k="settings.auth.noPasswordText">
        <template #address>
          <code>127.0.0.1</code>
        </template>
      </TransText>
    </Notice>
    <Notice v-else-if="exposed" tone="warn" :title="t('settings.auth.exposedTitle')">
      {{ t('settings.auth.exposedText') }}
    </Notice>
  </div>

  <form class="mt-3" @submit.prevent="submitPassword">
    <FieldGroup
      :title="passwordSet ? t('settings.auth.changePassword') : t('settings.auth.setPassword')"
      :description="t('settings.auth.passwordDescription')"
    >
      <TextField
        v-if="passwordSet"
        v-model="currentPassword"
        type="password"
        autocomplete="current-password"
        :label="t('settings.auth.currentPassword')"
      />
      <TextField v-model="newPassword" type="password" autocomplete="new-password" :label="t('settings.auth.newPassword')" />
      <TextField
        v-model="confirmPassword"
        type="password"
        autocomplete="new-password"
        :label="t('settings.auth.repeatPassword')"
        :error="mismatch ? t('settings.auth.passwordMismatch') : null"
      />

      <div class="flex flex-wrap items-center gap-2 sm:col-span-2">
        <AppButton type="submit" variant="primary" :disabled="!canSubmit" :loading="passwordSaving">
          {{ passwordSet ? t('settings.auth.updatePassword') : t('settings.auth.setPasswordAndEnable') }}
        </AppButton>
        <ConfirmButton
          v-if="passwordSet"
          :label="t('settings.auth.clearPassword')"
          :confirm-label="t('settings.auth.clearPasswordConfirm')"
          confirm-variant="danger"
          :title="t('settings.auth.clearPasswordTitle')"
          :hint="t('settings.auth.clearPasswordHint')"
          :disabled="passwordSaving"
          @confirm="clearPasswordValue"
        />
      </div>

      <template v-if="short || passwordError || passwordMessage">
        <Notice v-if="short" tone="warn" :title="t('settings.auth.shortPasswordTitle')" class="sm:col-span-2">
          {{ t('settings.auth.shortPasswordText') }}
        </Notice>
        <Notice v-if="passwordError" tone="danger" class="sm:col-span-2">
          {{ passwordError }}
        </Notice>
        <Notice v-if="passwordMessage" tone="ok" class="sm:col-span-2">
          {{ passwordMessage }}
        </Notice>
      </template>
    </FieldGroup>
  </form>
</template>
