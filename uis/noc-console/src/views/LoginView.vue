<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useControlPlane } from '@/composables/useControlPlane'
import { useSession } from '@/composables/useSession'

const route = useRoute()
const router = useRouter()
const control = useControlPlane()
const { session, error, login } = useSession()

const password = ref('')
const submitting = ref(false)

const firstRun = computed(() => session.value?.passwordSet === false)
const defaultPassword = computed(() => (session.value?.usingDefaultPassword === true ? session.value.defaultPassword : null))
const noAuth = computed(() => session.value !== null && !session.value.authRequired)
const exposed = computed(() => control.control.value?.auth.exposed === true)
const blockedReason = computed(() => control.control.value?.auth.blockedReason ?? null)
const controlUrl = computed(() => control.control.value?.url ?? '')

async function submit(): Promise<void> {
  submitting.value = true
  try {
    if (await login(password.value)) {
      password.value = ''
      await control.refresh()
      /*
       * The guard sends an unauthenticated visitor here with `?next=<page>`, and every workspace
       * page needs a `:workspaceId` — pushing `{ name: 'servers' }` made vue-router throw
       * "Missing required param workspaceId", so the sign-in succeeded and left the person on
       * the login screen. `/` is the panel-wide overview and the guard rewrites it to the
       * workspace the frame names, so it is the only destination that needs no id.
       */
      const next = typeof route.query.next === 'string' ? route.query.next : '/'
      await router.push(next)
    }
  }
  finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="view login">
    <div class="login__panel">
      <div class="login__head">
        <span class="brand__mark" />
        <span class="overlay__title">home-hosted</span>
        <span class="view__spacer" />
        <span class="chip chip--accent">sign in</span>
      </div>

      <form class="login__body" @submit.prevent="submit">
        <p v-if="firstRun" class="note note--warn">
          No password is set, so nothing protects this panel. Set one under Settings, or run
          <code>home-hosted set-password</code> on the machine itself.
        </p>
        <p v-else-if="noAuth" class="note note--warn">
          Authentication is off or has no password to check — the panel is not asking for one.
        </p>

        <p v-if="defaultPassword" class="note note--warn">
          The panel is still using the default password <code>{{ defaultPassword }}</code>.
          Change it under Settings once you are in.
        </p>

        <p v-if="blockedReason" class="note note--error">
          {{ blockedReason }}
        </p>
        <p v-else-if="exposed" class="note note--warn">
          This panel is reachable beyond <code>127.0.0.1</code>. Keep the password strong, or
          put a TLS-terminating proxy in front of it.
        </p>

        <label class="field">
          <span class="field__label">password</span>
          <input
            v-model="password"
            type="password"
            autocomplete="current-password"
            autofocus
            placeholder="panel password"
            required
          >
        </label>

        <button type="submit" class="btn btn--primary" :disabled="submitting || password.length === 0">
          {{ submitting ? 'signing in…' : 'sign in' }}
        </button>

        <p v-if="error" class="note note--error">
          {{ error }}
        </p>
      </form>

      <div class="login__foot">
        <span v-if="exposed" class="chip chip--warn">exposed</span>
        <code class="truncate">{{ controlUrl || 'control panel' }}</code>
      </div>
    </div>
  </div>
</template>
