<script setup lang="ts">
import type { ProxyDnsAccountView } from '@shared/contracts'
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
  /** Every DNS account the proxy may name, so DNS-01 can say when none can answer. */
  dnsAccounts: ProxyDnsAccountView[]
}>()

const form = defineModel<ListenerDraft>('form', { required: true })

/** Accounts that could actually answer a challenge: credentials, and a TXT write. */
const usableAccounts = computed(() => props.dnsAccounts.filter(account => account.writesTxt && account.hasCredentials))
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
        <code v-if="setcap" class="rounded bg-black/10 px-1 py-0.5 font-mono dark:bg-white/10">{{ setcap }}</code>
        <span v-else>with <code class="rounded bg-black/10 px-1 py-0.5 font-mono dark:bg-white/10">setcap</code> on the engine binary</span>
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

    <ToggleSwitch
      v-model="form.dns01"
      label="Answer challenges with DNS-01"
      hint="The panel writes the challenge record through a route's DNS account, so no inbound port is needed to get a certificate."
      wide
    />

    <TextField
      v-if="form.dns01"
      v-model="form.resolvers"
      label="Check the record against"
      placeholder="1.1.1.1, 8.8.8.8"
      hint="Nameservers the engine reads the record from; empty uses its own. Needed where split-horizon DNS shows it a different view."
      spellcheck="false"
      wide
    />

    <div v-if="form.dns01 && usableAccounts.length === 0" class="sm:col-span-2">
      <Notice tone="warn" title="No DNS account can answer a challenge">
        DNS-01 is on, but no account has credentials it can use. Add one under
        Workspace Settings → Dynamic DNS, or public names stay on the port challenges and
        wait for a CA that cannot reach them.
      </Notice>
    </div>

    <div v-else-if="form.dns01 && usableAccounts.length > 1" class="sm:col-span-2">
      <Notice tone="info" title="Each public route has to pick an account">
        More than one account can answer, so “Automatic” cannot choose. Pick one per route,
        or those names stay on the port challenges.
      </Notice>
    </div>

    <p v-if="form.dns01" class="text-2xs leading-4 text-faint sm:col-span-2">
      Each route picks its own account, so names in different zones each get the right one. A route
      left on “Automatic” uses the only account the table names. A name no account answers stays on
      the port challenges.
    </p>

    <p class="text-2xs leading-4 text-faint sm:col-span-2">
      A public name whose certificate is still being issued is reachable in the meantime — over HTTPS with a
      temporary untrusted certificate, or over plain HTTP with a page naming the ports to forward.
    </p>
  </FieldGroup>
</template>
