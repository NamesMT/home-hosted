<script setup lang="ts">
import type { ProxyDnsAccountView } from '@shared/contracts'
import type { ProxyWorkspace, RouteDraft, RouteErrors } from '@/lib/proxy'
import { computed, ref, toRaw, watch } from 'vue'
import Notice from '@/components/settings/Notice.vue'
import AppButton from '@/components/ui/AppButton.vue'
import Modal from '@/components/ui/Modal.vue'
import SelectField from '@/components/ui/SelectField.vue'
import TextField from '@/components/ui/TextField.vue'
import { t } from '@/i18n'
import { dnsAccountOptions, isPublicHost, newRouteDraft, ROUTE_ERROR_MESSAGES, slugifyRouteId, TARGET_OPTIONS, TLS_OPTIONS, uniqueRouteId, validateRouteDraft } from '@/lib/proxy'

/** One route, edited in a dialog. Nothing is saved here — the page owns the Save. */
const props = defineProps<{
  /** The route being edited; `null` adds a new one. */
  draft: RouteDraft | null
  others: RouteDraft[]
  workspaces: ProxyWorkspace[]
  /** Every DNS account the proxy may name, across workspaces. */
  dnsAccounts: ProxyDnsAccountView[]
}>()

const emit = defineEmits<{ save: [route: RouteDraft] }>()

const open = defineModel<boolean>('open', { default: false })

const form = ref<RouteDraft>(newRouteDraft())
const errors = ref<RouteErrors>({})

const editing = computed(() => props.draft !== null)
const serverOptions = computed(() => {
  const workspace = props.workspaces.find(entry => entry.id === form.value.workspace)
  return (workspace?.servers ?? []).map(server => ({ value: server.id, label: server.id }))
})

/** The options carry a catalog key; the picker renders the words. */
const targetOptions = computed(() => TARGET_OPTIONS.map(option => ({ value: option.value, label: t(option.labelKey) })))
const tlsOptions = computed(() => TLS_OPTIONS.map(option => ({ value: option.value, label: t(option.labelKey) })))

const tlsHint = computed(() => {
  if (form.value.tls === 'off')
    return t('proxy.tls.hintOff')
  if (form.value.tls === 'manual')
    return t('proxy.tls.hintManual')
  if (form.value.host.trim().length === 0)
    return t('proxy.tls.hintEmpty')
  return isPublicHost(form.value.host)
    ? t('proxy.tls.hintPublic')
    : t('proxy.tls.hintLocal')
})

/** The account picker is only meaningful for a name the engine would get a certificate for. */
const wantsDns = computed(() => form.value.tls === 'auto' && isPublicHost(form.value.host))
const accountOptions = computed(() => dnsAccountOptions(props.dnsAccounts))
const chosenAccount = computed(() => props.dnsAccounts.find(entry => `${entry.workspace}/${entry.account}` === form.value.dnsAccount))
const accountHint = computed(() => {
  if (chosenAccount.value === undefined) {
    return form.value.dnsAccount.length > 0
      ? t('proxy.account.gone')
      : t('proxy.account.emptyHint')
  }
  if (!chosenAccount.value.writesTxt)
    return t('proxy.account.cannotWrite', { provider: chosenAccount.value.provider })
  if (!chosenAccount.value.hasCredentials)
    return t('proxy.account.noCredentialsYet', { provider: chosenAccount.value.provider })
  return t('proxy.account.through', { provider: chosenAccount.value.provider })
})

watch(open, (isOpen) => {
  if (!isOpen)
    return
  form.value = props.draft === null ? newRouteDraft() : structuredClone(toRaw(props.draft))
  if (form.value.workspace.length === 0)
    form.value.workspace = props.workspaces[0]?.id ?? ''
  errors.value = {}
})

watch(() => form.value.workspace, () => {
  if (!serverOptions.value.some(option => option.value === form.value.server))
    form.value.server = serverOptions.value[0]?.value ?? ''
})

function submit(): void {
  const host = form.value.host.trim().toLowerCase()
  const candidate: RouteDraft = {
    ...form.value,
    host,
    id: uniqueRouteId(slugifyRouteId(host), props.others.map(route => route.id)),
    workspace: form.value.target === 'server' ? form.value.workspace : '',
    server: form.value.target === 'server' ? form.value.server : '',
    url: form.value.target === 'external' ? form.value.url.trim() : '',
  }

  const found = validateRouteDraft(candidate, { others: props.others, workspaces: props.workspaces, messages: ROUTE_ERROR_MESSAGES })
  errors.value = found
  if (Object.keys(found).length > 0)
    return

  emit('save', candidate)
  open.value = false
}
</script>

<template>
  <Modal
    v-model:open="open"
    :title="editing ? t('proxy.routeDialog.titleEdit') : t('proxy.routeDialog.titleAdd')"
    :description="t('proxy.routeDialog.description')"
    width="w-[min(92vw,34rem)]"
  >
    <div class="space-y-3">
      <TextField
        v-model="form.host"
        :label="t('proxy.routeDialog.hostname')"
        :placeholder="t('proxy.routeDialog.hostnamePlaceholder')"
        autocomplete="off"
        spellcheck="false"
        :error="errors.host"
        wide
      />
      <TextField
        v-model="form.path"
        :label="t('proxy.routeDialog.path')"
        :placeholder="t('proxy.routeDialog.pathPlaceholder')"
        :hint="t('proxy.routeDialog.pathHint')"
        spellcheck="false"
        :error="errors.path"
        wide
      />
      <SelectField v-model="form.target" :label="t('proxy.routeDialog.target')" :options="targetOptions" />
      <SelectField v-model="form.tls" :label="t('proxy.routeDialog.tls')" :options="tlsOptions" :hint="tlsHint" />

      <SelectField
        v-if="wantsDns"
        v-model="form.dnsAccount"
        :label="t('proxy.routeDialog.dnsAccount')"
        :options="accountOptions"
        :hint="accountHint"
      />
      <p v-else-if="form.tls === 'auto'" class="text-2xs leading-4 text-faint sm:col-span-2">
        {{ t('proxy.routeDialog.localNote') }}
      </p>

      <template v-if="form.target === 'server'">
        <SelectField
          v-model="form.workspace"
          :label="t('proxy.routeDialog.workspace')"
          :options="props.workspaces.map(workspace => ({ value: workspace.id, label: workspace.label }))"
          :error="errors.workspace"
        />
        <SelectField
          v-model="form.server"
          :label="t('proxy.routeDialog.server')"
          :options="serverOptions"
          :disabled="serverOptions.length === 0"
          :error="errors.server ?? (serverOptions.length === 0 ? t('proxy.routeDialog.noServers') : null)"
        />
        <p class="text-2xs leading-4 text-faint sm:col-span-2">
          {{ t('proxy.routeDialog.stoppedNote') }}
        </p>
      </template>

      <TextField
        v-if="form.target === 'external'"
        v-model="form.url"
        :label="t('proxy.routeDialog.upstream')"
        :placeholder="t('proxy.routeDialog.upstreamPlaceholder')"
        :hint="t('proxy.routeDialog.upstreamHint')"
        spellcheck="false"
        :error="errors.url"
        wide
      />

      <p v-if="form.target === 'panel'" class="text-2xs leading-4 text-warn sm:col-span-2">
        {{ t('proxy.routeDialog.panelNote') }}
      </p>

      <Notice v-if="errors.form" tone="danger">
        {{ errors.form }}
      </Notice>
    </div>

    <template #footer>
      <AppButton size="sm" variant="ghost" @click="open = false">
        {{ t('common.cancel') }}
      </AppButton>
      <AppButton size="sm" variant="primary" @click="submit">
        {{ editing ? t('proxy.routeDialog.save') : t('proxy.routes.add') }}
      </AppButton>
    </template>
  </Modal>
</template>
