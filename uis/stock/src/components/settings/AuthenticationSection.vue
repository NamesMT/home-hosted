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
import { useSession } from '@/composables/useSession'

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
    passwordMessage.value = 'Password updated. Other sessions were signed out.'
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
  else passwordMessage.value = 'Password cleared and authentication disabled.'
}
</script>

<template>
  <FieldGroup
    title="Access policy"
    description="Authentication applies whether the panel is on loopback or exposed to the network."
  >
    <template #actions>
      <AppButton size="xs" variant="ghost" :disabled="!props.dirty" @click="emit('reset')">
        Reset
      </AppButton>
    </template>

    <ToggleSwitch
      v-model="auth.enabled"
      label="Require a password"
      hint="Every request needs a signed-in session."
      class="sm:col-span-2"
    />
    <NumberField v-model="sessionTtlMs" label="Session lifetime (ms)" :min="60000" hint="604800000 is one week." />
    <SelectField
      v-model="auth.cookieSecure"
      label="Cookie Secure"
      :options="[
        { value: 'auto', label: 'Auto — only over HTTPS' },
        { value: 'always', label: 'Always' },
        { value: 'never', label: 'Never — plain HTTP' },
      ]"
    />
    <ToggleSwitch
      v-model="auth.trustProxy"
      label="Behind a trusted reverse proxy"
      hint="Trust x-forwarded-* headers for the client address and protocol."
      class="sm:col-span-2"
    />
    <NumberField v-model="maxLoginAttempts" label="Max login attempts" :min="1" hint="Failures before a temporary lockout." />
    <NumberField v-model="lockoutMs" label="Lockout (ms)" :min="1000" />
  </FieldGroup>

  <div class="space-y-2">
    <Notice
      :tone="apiTokenSet ? 'info' : 'neutral'"
      :title="apiTokenSet ? 'An API token is set' : 'No API token'"
    >
      <template v-if="apiTokenSet">
        Scripts can call the API with <code>Authorization: Bearer …</code> instead of signing in.
      </template>
      <template v-else>
        For shell scripts and agents, generate one with <code>home-hosted set-token --generate</code>.
      </template>
    </Notice>
    <Notice v-if="usingDefault" tone="warn" title="The default password is still in use">
      Set your own password below. Binding beyond <code>127.0.0.1</code> stays refused until you do.
    </Notice>
    <Notice v-if="blockedReason" tone="danger" title="This listener is being refused">
      {{ blockedReason }}
    </Notice>
    <Notice v-else-if="enabledWithoutPassword" tone="warn" title="Authentication is on but no password is set">
      Nothing is actually required yet, and binding beyond <code>127.0.0.1</code> stays refused until a password exists.
    </Notice>
    <Notice v-else-if="exposed" tone="warn" title="Reachable beyond 127.0.0.1">
      Keep the password strong, or put a TLS-terminating proxy in front of the panel.
    </Notice>
  </div>

  <form class="mt-3" @submit.prevent="submitPassword">
    <FieldGroup
      :title="passwordSet ? 'Change password' : 'Set a password'"
      description="Stored as a scrypt hash in the secrets file, never in the config."
    >
      <TextField
        v-if="passwordSet"
        v-model="currentPassword"
        type="password"
        autocomplete="current-password"
        label="Current password"
      />
      <TextField v-model="newPassword" type="password" autocomplete="new-password" label="New password" />
      <TextField
        v-model="confirmPassword"
        type="password"
        autocomplete="new-password"
        label="Repeat new password"
        :error="mismatch ? 'The two passwords do not match.' : null"
      />

      <div class="flex flex-wrap items-center gap-2 sm:col-span-2">
        <AppButton type="submit" variant="primary" :disabled="!canSubmit" :loading="passwordSaving">
          {{ passwordSet ? 'Update password' : 'Set password and enable auth' }}
        </AppButton>
        <ConfirmButton
          v-if="passwordSet"
          label="Clear password"
          confirm-label="Confirm clear"
          confirm-variant="danger"
          :disabled="passwordSaving"
          @confirm="clearPasswordValue"
        />
      </div>

      <template v-if="short || passwordError || passwordMessage">
        <Notice v-if="short" tone="warn" title="That is a short password" class="sm:col-span-2">
          It is allowed, but longer is the only thing standing between the network and this panel.
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
