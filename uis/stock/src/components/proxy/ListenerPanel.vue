<script setup lang="ts">
import type { ListenerDraft } from '@/lib/proxy'
import { computed } from 'vue'
import Notice from '@/components/settings/Notice.vue'
import AppButton from '@/components/ui/AppButton.vue'
import CopyButton from '@/components/ui/CopyButton.vue'
import FieldGroup from '@/components/ui/FieldGroup.vue'
import NumberField from '@/components/ui/NumberField.vue'
import TextField from '@/components/ui/TextField.vue'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import ToneBadge from '@/components/ui/ToneBadge.vue'
import { isPrivilegedPort, UNPRIVILEGED_HTTP_PORT, UNPRIVILEGED_HTTPS_PORT, usesFallbackPorts } from '@/lib/proxy'

/**
 * The listener policy: whether the engine runs, the ports it serves on and the
 * ACME account. All of it is saved by the page's Save, and the panel starts,
 * stops or reloads the engine to match.
 */
const props = defineProps<{
  /** The first public hostname that would need the e-mail, if any. */
  emailHost: string | null
  /** The installed engine's path, for the `setcap` line. */
  enginePath: string | null
}>()

const form = defineModel<ListenerDraft>('form', { required: true })

const fallback = computed(() => usesFallbackPorts(form.value))
const setcap = computed(() => (props.enginePath === null ? null : `sudo setcap 'cap_net_bind_service=+ep' ${props.enginePath}`))
const privileged = computed(() => isPrivilegedPort(form.value.httpPort) || isPrivilegedPort(form.value.httpsPort))

function useFallback(): void {
  form.value.httpPort = UNPRIVILEGED_HTTP_PORT
  form.value.httpsPort = UNPRIVILEGED_HTTPS_PORT
}

function useStandard(): void {
  form.value.httpPort = 80
  form.value.httpsPort = 443
}
</script>

<template>
  <FieldGroup
    title="Listener & certificates"
    description="Where the proxy listens. 80 and 443 are what a router forwards and what an ACME challenge expects; a port below 1024 needs a privileged bind."
  >
    <template #actions>
      <ToneBadge v-if="fallback" tone="info">
        unprivileged ports
      </ToneBadge>
    </template>

    <ToggleSwitch
      v-model="form.enabled"
      label="Run the reverse proxy"
      hint="Saved with Save settings; the panel starts or stops the engine to match."
      wide
    />

    <NumberField v-model="form.httpPort" label="HTTP port" :min="1" :max="65535" hint="ACME HTTP-01 challenges and the redirect to HTTPS." />
    <NumberField v-model="form.httpsPort" label="HTTPS port" :min="1" :max="65535" hint="Where certificates are served." />

    <div class="flex flex-wrap items-center gap-2 sm:col-span-2">
      <AppButton size="xs" variant="secondary" @click="useFallback">
        Use {{ UNPRIVILEGED_HTTP_PORT }} / {{ UNPRIVILEGED_HTTPS_PORT }}
      </AppButton>
      <AppButton size="xs" variant="ghost" @click="useStandard">
        Use 80 / 443
      </AppButton>
      <span v-if="fallback" class="text-2xs text-faint">
        Running unprivileged — forward 80 and 443 to these ports on your router.
      </span>
    </div>

    <div v-if="privileged" class="sm:col-span-2">
      <Notice tone="warn" title="A port below 1024 needs a privileged bind">
        Running the panel as your own user cannot bind 80 or 443 without permission. Either grant it
        once
        <span v-if="setcap" class="font-mono">{{ setcap }}</span>
        <span v-else>with <span class="font-mono">setcap</span> on the engine binary</span>
        <CopyButton v-if="setcap" :value="setcap" label="Copy the command" class="ml-1 align-middle" />
        and restart the engine, or keep {{ UNPRIVILEGED_HTTP_PORT }}/{{ UNPRIVILEGED_HTTPS_PORT }} and forward
        80/443 from your router. On Windows the port is free to bind, but something else may hold it.
      </Notice>
    </div>

    <TextField
      v-model="form.email"
      label="ACME account e-mail"
      placeholder="you@example.com"
      hint="Let's Encrypt uses it to warn you about an expiring certificate. A local-only name gets the engine's own CA and needs none."
      wide
    />

    <div v-if="props.emailHost !== null" class="sm:col-span-2">
      <Notice tone="warn" title="An e-mail is needed for automatic HTTPS">
        “{{ props.emailHost }}” is a public hostname, so the engine asks a CA for a certificate and the
        account address is required. Fill it in, switch the route's TLS off, or turn on the staging
        endpoint while you try things out.
      </Notice>
    </div>

    <ToggleSwitch
      v-model="form.staging"
      label="Use the ACME staging endpoint"
      hint="Untrusted certificates and no rate-limit burn while you try things out."
      wide
    />

    <p class="text-2xs leading-4 text-faint sm:col-span-2">
      A public name whose certificate is still being issued is reachable in the meantime — over HTTPS with a
      temporary untrusted certificate, or over plain HTTP with a page naming the ports to forward.
    </p>
  </FieldGroup>
</template>
