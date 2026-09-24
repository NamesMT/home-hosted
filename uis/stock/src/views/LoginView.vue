<script setup lang="ts">
import { Eye, EyeOff, LogIn, ShieldAlert, ShieldCheck, ShieldOff } from 'lucide-vue-next'
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppButton from '@/components/ui/AppButton.vue'
import ToneBadge from '@/components/ui/ToneBadge.vue'
import { useControlPlane } from '@/composables/useControlPlane'
import { useSession } from '@/composables/useSession'
import { cn } from '@/lib/cn'
import { inputClass, labelClass } from '@/lib/ui'

const route = useRoute()
const router = useRouter()
const control = useControlPlane()
const { session, error, login, refresh } = useSession()

const password = ref('')
const submitting = ref(false)
const revealed = ref(false)

const firstRun = computed(() => session.value?.passwordSet === false)
const authOff = computed(() => session.value !== null && !session.value.authRequired)
const usingDefault = computed(() => session.value?.usingDefaultPassword === true && session.value.defaultPassword !== null)
const exposed = computed(() => control.control.value?.auth.exposed === true)
const panelUrl = computed(() => control.control.value?.url ?? '—')

const headline = computed(() => {
  if (firstRun.value)
    return 'This panel has no password yet'
  if (authOff.value)
    return 'Authentication is turned off'
  return 'Sign in to continue'
})

const subtitle = computed(() => {
  if (firstRun.value)
    return 'Anything on this machine can reach it. Set a password right after you are in.'
  if (authOff.value)
    return 'The panel only listens on loopback, which is the only thing protecting it right now.'
  return 'The control panel is protected. Enter the password to continue.'
})

async function submit(): Promise<void> {
  submitting.value = true
  try {
    if (await login(password.value)) {
      password.value = ''
      const next = typeof route.query.next === 'string' ? route.query.next : '/'
      await router.push(next)
    }
  }
  finally {
    submitting.value = false
  }
}

async function continueWithoutPassword(): Promise<void> {
  await refresh()
  await router.push('/')
}

onMounted(async () => {
  if (session.value === null)
    await refresh()
})
</script>

<template>
  <div class="relative flex min-h-dvh items-center justify-center overflow-hidden bg-page px-4 py-10">
    <div class="bg-instrument pointer-events-none absolute inset-0 opacity-60" />
    <div class="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_15%,var(--page)_78%)]" />

    <div class="hh-enter relative w-full max-w-md">
      <div class="mb-6 flex items-center gap-3">
        <span class="grid size-11 shrink-0 place-items-center rounded-panel border border-accent/30 bg-accent-soft text-accent">
          <svg viewBox="0 0 24 24" class="size-6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
            <path d="M4 15.5a8 8 0 1 1 16 0" />
            <path d="M12 15.5 15.6 10.2" />
            <circle cx="12" cy="15.5" r="1.3" fill="currentColor" stroke="none" />
          </svg>
        </span>
        <div>
          <p class="text-lg font-semibold tracking-tight text-ink">
            home-hosted
          </p>
          <p class="text-xs text-muted">
            Process supervisor control panel
          </p>
        </div>
      </div>

      <section class="rounded-panel border border-line bg-panel/95 p-5 shadow-float backdrop-blur-sm">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <h1 class="text-base font-semibold text-ink">
              {{ headline }}
            </h1>
            <p class="mt-1 text-xs leading-relaxed text-muted">
              {{ subtitle }}
            </p>
          </div>
          <ToneBadge v-if="exposed" tone="warn" dot>
            Exposed
          </ToneBadge>
        </div>

        <form v-if="!authOff" class="mt-5 space-y-3" @submit.prevent="submit">
          <div class="flex flex-col gap-1.5">
            <label for="hh-password" :class="labelClass">Password</label>
            <div class="relative">
              <input
                id="hh-password"
                v-model="password"
                :type="revealed ? 'text' : 'password'"
                autocomplete="current-password"
                autofocus
                required
                :class="cn(inputClass, 'pr-9')"
              >
              <button
                type="button"
                class="absolute right-1 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-control text-faint transition-colors duration-150 hover:text-ink"
                :aria-label="revealed ? 'Hide password' : 'Show password'"
                @click="revealed = !revealed"
              >
                <EyeOff v-if="revealed" class="size-3.5" />
                <Eye v-else class="size-3.5" />
              </button>
            </div>
          </div>

          <p v-if="error" class="rounded-control border border-danger/25 bg-danger-soft px-2.5 py-2 text-xs text-danger">
            {{ error }}
          </p>

          <AppButton type="submit" variant="primary" size="md" block :loading="submitting">
            <LogIn class="size-3.5" />
            Sign in
          </AppButton>
        </form>

        <div v-else class="mt-5">
          <AppButton variant="primary" size="md" block @click="continueWithoutPassword">
            Open the dashboard
          </AppButton>
        </div>

        <div class="mt-4 space-y-2">
          <div v-if="usingDefault" class="flex items-start gap-2 rounded-control border border-warn/25 bg-warn-soft px-2.5 py-2">
            <ShieldAlert class="mt-0.5 size-3.5 shrink-0 text-warn" />
            <p class="text-2xs leading-4 text-warn">
              Still on the default password
              <code class="ml-1 rounded bg-black/10 px-1 py-0.5 font-mono dark:bg-white/10">{{ session?.defaultPassword }}</code>.
              Change it under Settings — binding beyond 127.0.0.1 stays refused until you do.
            </p>
          </div>

          <div v-else-if="firstRun" class="flex items-start gap-2 rounded-control border border-warn/25 bg-warn-soft px-2.5 py-2">
            <ShieldOff class="mt-0.5 size-3.5 shrink-0 text-warn" />
            <p class="text-2xs leading-4 text-warn">
              No password is set. Open Settings from this machine to add one, or run
              <code class="rounded bg-black/10 px-1 py-0.5 font-mono dark:bg-white/10">pnpm run auth:set-password</code>.
            </p>
          </div>

          <div v-else class="flex items-start gap-2 rounded-control border border-line-soft bg-panel-2 px-2.5 py-2">
            <ShieldCheck class="mt-0.5 size-3.5 shrink-0 text-ok" />
            <p class="text-2xs leading-4 text-muted">
              Sessions last {{ Math.round((session?.sessionTtlMs ?? 0) / 86_400_000) }} days. Signing out clears this browser only.
            </p>
          </div>
        </div>
      </section>

      <p class="mt-4 flex items-center justify-center gap-2 text-2xs text-faint">
        <span class="font-mono">{{ panelUrl }}</span>
        <span aria-hidden="true">·</span>
        <span>served from this machine</span>
      </p>
    </div>
  </div>
</template>
