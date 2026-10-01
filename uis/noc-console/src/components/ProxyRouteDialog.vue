<script setup lang="ts">
import type { ProxyDnsAccountView } from '@shared/contracts'
import type { ProxyWorkspace, RouteDraft, RouteErrors } from '@/lib/proxy'
import { computed, nextTick, onScopeDispose, ref, toRaw, watch } from 'vue'
import { dnsAccountOptions, isPublicHost, newRouteDraft, slugifyRouteId, TARGET_OPTIONS, TLS_OPTIONS, uniqueRouteId, validateRouteDraft } from '@/lib/proxy'

/** One route, edited in the console's own sheet. Nothing is saved here. */
const props = defineProps<{
  open: boolean
  /** The route being edited; `null` adds a new one. */
  draft: RouteDraft | null
  others: RouteDraft[]
  workspaces: ProxyWorkspace[]
  /** Every DNS account the proxy may name, across workspaces. */
  dnsAccounts: ProxyDnsAccountView[]
}>()

const emit = defineEmits<{ close: [], save: [route: RouteDraft] }>()

const form = ref<RouteDraft>(newRouteDraft())
const errors = ref<RouteErrors>({})
const hostField = ref<HTMLInputElement | null>(null)

const editing = computed(() => props.draft !== null)
const serverOptions = computed(() => (props.workspaces.find(entry => entry.id === form.value.workspace)?.servers ?? []))

const tlsHint = computed(() => {
  if (form.value.tls === 'off')
    return 'plain http — no certificate for this hostname'
  if (form.value.tls === 'manual')
    return 'serves the pair uploaded in the certificate pane'
  if (form.value.host.trim().length === 0)
    return 'a public name gets an ACME certificate, a local name the engine\u2019s own CA'
  return isPublicHost(form.value.host)
    ? 'public — the engine asks a CA, so an ACME e-mail is needed'
    : 'local — the engine signs it with its own locally-trusted CA'
})

/** The account picker is only meaningful for a name the engine would get a certificate for. */
const wantsDns = computed(() => form.value.tls === 'auto' && isPublicHost(form.value.host))
const accountOptions = computed(() => dnsAccountOptions(props.dnsAccounts))
const chosenAccount = computed(() => props.dnsAccounts.find(entry => `${entry.workspace}/${entry.account}` === form.value.dnsAccount))
const accountHint = computed(() => {
  if (chosenAccount.value === undefined)
    return 'dns-01 writes the challenge record here; empty uses the only account that can answer'
  if (!chosenAccount.value.writesTxt)
    return `a ${chosenAccount.value.provider} account cannot write TXT records`
  if (!chosenAccount.value.hasCredentials)
    return `no credentials are stored for this ${chosenAccount.value.provider} account yet`
  return `the challenge is written through this ${chosenAccount.value.provider} account`
})

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape')
    emit('close')
}

watch(() => props.open, async (open) => {
  if (!open) {
    window.removeEventListener('keydown', onKey)
    return
  }
  window.addEventListener('keydown', onKey)
  form.value = props.draft === null ? newRouteDraft() : structuredClone(toRaw(props.draft))
  if (form.value.workspace.length === 0)
    form.value.workspace = props.workspaces[0]?.id ?? ''
  errors.value = {}
  await nextTick()
  hostField.value?.focus()
})

watch(() => form.value.workspace, () => {
  if (!serverOptions.value.some(server => server.id === form.value.server))
    form.value.server = serverOptions.value[0]?.id ?? ''
})

onScopeDispose(() => window.removeEventListener('keydown', onKey))

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

  const found = validateRouteDraft(candidate, { others: props.others, workspaces: props.workspaces })
  errors.value = found
  if (Object.keys(found).length > 0)
    return

  emit('save', candidate)
  emit('close')
}
</script>

<template>
  <div v-if="props.open" class="overlay" @click.self="emit('close')">
    <div class="overlay__panel overlay__panel--sheet dialog" role="dialog" aria-label="route">
      <div class="overlay__head">
        <span class="overlay__title">{{ editing ? 'edit route' : 'add route' }}</span>
        <span class="view__spacer" />
        <span class="faint">a hostname, an upstream, a certificate</span>
        <kbd class="kbd">esc</kbd>
      </div>

      <form class="sheet__form" @submit.prevent="submit">
        <div class="overlay__body">
          <div class="grid">
            <label class="field grid__full">
              <span class="field__label">hostname</span>
              <input ref="hostField" v-model="form.host" placeholder="gitea.example.com" spellcheck="false" required>
              <span v-if="errors.host" class="field__hint danger">{{ errors.host }}</span>
            </label>

            <label class="field">
              <span class="field__label">path prefix</span>
              <input v-model="form.path" placeholder="/optional" spellcheck="false">
              <span v-if="errors.path" class="field__hint danger">{{ errors.path }}</span>
              <span v-else class="field__hint">empty serves the whole host</span>
            </label>

            <label class="field">
              <span class="field__label">tls</span>
              <select v-model="form.tls">
                <option v-for="option in TLS_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</option>
              </select>
              <span class="field__hint">{{ tlsHint }}</span>
            </label>

            <label v-if="wantsDns" class="field">
              <span class="field__label">dns account</span>
              <select v-model="form.dnsAccount">
                <option v-for="option in accountOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
              </select>
              <span class="field__hint">{{ accountHint }}</span>
            </label>

            <label class="field">
              <span class="field__label">target</span>
              <select v-model="form.target">
                <option v-for="option in TARGET_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</option>
              </select>
            </label>
          </div>

          <div v-if="form.target === 'server'" class="grid">
            <label class="field">
              <span class="field__label">workspace</span>
              <select v-model="form.workspace">
                <option v-for="workspace in props.workspaces" :key="workspace.id" :value="workspace.id">{{ workspace.label }}</option>
              </select>
              <span v-if="errors.workspace" class="field__hint danger">{{ errors.workspace }}</span>
            </label>

            <label class="field">
              <span class="field__label">server</span>
              <select v-model="form.server" :disabled="serverOptions.length === 0">
                <option v-for="server in serverOptions" :key="server.id" :value="server.id">{{ server.id }}</option>
              </select>
              <span v-if="errors.server" class="field__hint danger">{{ errors.server }}</span>
              <span v-else-if="serverOptions.length === 0" class="field__hint danger">this workspace has no servers</span>
              <span v-else class="field__hint">a stopped server reads “no upstream” until it runs</span>
            </label>
          </div>

          <div v-if="form.target === 'external'" class="grid">
            <label class="field grid__full">
              <span class="field__label">upstream</span>
              <input v-model="form.url" placeholder="http://10.0.0.5:8080" spellcheck="false">
              <span v-if="errors.url" class="field__hint danger">{{ errors.url }}</span>
              <span v-else class="field__hint">a literal address including the port; a scheme is optional</span>
            </label>
          </div>

          <p v-if="form.target === 'panel'" class="note note--warn">
            Serving the control panel needs authentication on and a password that is not the default — the
            panel refuses the save otherwise.
          </p>

          <p v-if="errors.form" class="note note--error">
            {{ errors.form }}
          </p>
        </div>

        <div class="group sheet__foot">
          <div class="actions">
            <button type="button" class="btn btn--sm" @click="emit('close')">
              cancel
            </button>
            <button type="submit" class="btn btn--sm btn--primary">
              {{ editing ? 'save route' : 'add route' }}
            </button>
          </div>
        </div>
      </form>
    </div>
  </div>
</template>
