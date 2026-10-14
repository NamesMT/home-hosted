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
import TransText from '@/components/ui/TransText.vue'
import { t } from '@/i18n'
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

/**
 * The ports are required numbers, and a cleared `NumberField` reports `NaN`. Written
 * through, that made the client's own `proxyPatchSchema` throw "httpPort must be a number
 * (was NaN)" before any request — no hint, and every pending proxy edit lost with it.
 * Keep the last valid value while the box is empty.
 */
function keepPort(value: number | null, key: 'httpPort' | 'httpsPort'): void {
  if (value === null || Number.isNaN(value))
    return
  if (value >= 1 && value <= 65535)
    form.value[key] = Math.trunc(value)
}
</script>

<template>
  <FieldGroup
    :title="t('proxy.listener.title')"
    :description="t('proxy.listener.description')"
  >
    <template #actions>
      <ToneBadge v-if="fallback" tone="info">
        {{ t('proxy.listener.unprivilegedPorts') }}
      </ToneBadge>
    </template>

    <ToggleSwitch
      v-model="form.enabled"
      :label="t('proxy.listener.run')"
      :hint="t('proxy.listener.runHint')"
      wide
    />

    <NumberField
      :model-value="form.httpPort"
      :label="t('proxy.listener.httpPort')"
      :min="1"
      :max="65535"
      :hint="t('proxy.listener.httpPortHint')"
      @update:model-value="value => keepPort(value, 'httpPort')"
    />
    <NumberField
      :model-value="form.httpsPort"
      :label="t('proxy.listener.httpsPort')"
      :min="1"
      :max="65535"
      :hint="t('proxy.listener.httpsPortHint')"
      @update:model-value="value => keepPort(value, 'httpsPort')"
    />

    <div class="flex flex-wrap items-center gap-2 sm:col-span-2">
      <AppButton size="xs" variant="secondary" @click="useFallback">
        {{ t('proxy.listener.useFallback', { http: UNPRIVILEGED_HTTP_PORT, https: UNPRIVILEGED_HTTPS_PORT }) }}
      </AppButton>
      <AppButton size="xs" variant="ghost" @click="useStandard">
        {{ t('proxy.listener.useStandard') }}
      </AppButton>
      <span v-if="fallback" class="text-2xs text-faint">
        {{ t('proxy.listener.forwardHint') }}
      </span>
    </div>

    <div v-if="privileged" class="sm:col-span-2">
      <Notice tone="warn" :title="t('proxy.listener.privilegedTitle')">
        <TransText
          k="proxy.listener.privilegedBody"
          :params="{ http: UNPRIVILEGED_HTTP_PORT, https: UNPRIVILEGED_HTTPS_PORT }"
        >
          <!-- Both the command and its copy button stay inside the sentence: the button is a
               control, not a word, and moving it past the full stop changes the line. -->
          <template #how>
            <template v-if="setcap">
              <code class="rounded bg-black/10 px-1 py-0.5 font-mono dark:bg-white/10">{{ setcap }}</code>
              <CopyButton :value="setcap" :label="t('proxy.engine.copyCommand')" class="ml-1 align-middle" />
            </template>
            <span v-else>
              <TransText k="proxy.listener.privilegedWithSetcap">
                <template #command><code class="rounded bg-black/10 px-1 py-0.5 font-mono dark:bg-white/10">setcap</code></template>
              </TransText>
            </span>
          </template>
        </TransText>
      </Notice>
    </div>

    <TextField
      v-model="form.email"
      :label="t('proxy.listener.email')"
      :placeholder="t('proxy.listener.emailPlaceholder')"
      :hint="t('proxy.listener.emailHint')"
      wide
    />

    <div v-if="props.emailHost !== null" class="sm:col-span-2">
      <Notice tone="warn" :title="t('proxy.listener.emailNeededTitle')">
        {{ t('proxy.listener.emailNeededBody', { host: props.emailHost }) }}
      </Notice>
    </div>

    <ToggleSwitch
      v-model="form.staging"
      :label="t('proxy.listener.staging')"
      :hint="t('proxy.listener.stagingHint')"
      wide
    />

    <ToggleSwitch
      v-model="form.dns01"
      :label="t('proxy.listener.dns01')"
      :hint="t('proxy.listener.dns01Hint')"
      wide
    />

    <TextField
      v-if="form.dns01"
      v-model="form.resolvers"
      :label="t('proxy.listener.resolvers')"
      :placeholder="t('proxy.listener.resolversPlaceholder')"
      :hint="t('proxy.listener.resolversHint')"
      spellcheck="false"
      wide
    />

    <div v-if="form.dns01 && usableAccounts.length === 0" class="sm:col-span-2">
      <Notice tone="warn" :title="t('proxy.listener.noAccountTitle')">
        {{ t('proxy.listener.noAccountBody') }}
      </Notice>
    </div>

    <div v-else-if="form.dns01 && usableAccounts.length > 1" class="sm:col-span-2">
      <Notice tone="info" :title="t('proxy.listener.manyAccountsTitle')">
        {{ t('proxy.listener.manyAccountsBody') }}
      </Notice>
    </div>

    <p v-if="form.dns01" class="text-2xs leading-4 text-faint sm:col-span-2">
      {{ t('proxy.listener.accountNote') }}
    </p>

    <p class="text-2xs leading-4 text-faint sm:col-span-2">
      {{ t('proxy.listener.pendingNote') }}
    </p>
  </FieldGroup>
</template>
