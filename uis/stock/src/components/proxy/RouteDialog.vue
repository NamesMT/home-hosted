<script setup lang="ts">
import type { ProxyWorkspace, RouteDraft, RouteErrors } from '@/lib/proxy'
import { computed, ref, watch } from 'vue'
import Notice from '@/components/settings/Notice.vue'
import AppButton from '@/components/ui/AppButton.vue'
import Modal from '@/components/ui/Modal.vue'
import SelectField from '@/components/ui/SelectField.vue'
import TextField from '@/components/ui/TextField.vue'
import { isPublicHost, newRouteDraft, slugifyRouteId, TARGET_OPTIONS, TLS_OPTIONS, uniqueRouteId, validateRouteDraft } from '@/lib/proxy'

/** One route, edited in a dialog. Nothing is saved here — the page owns the Save. */
const props = defineProps<{
  /** The route being edited; `null` adds a new one. */
  draft: RouteDraft | null
  others: RouteDraft[]
  workspaces: ProxyWorkspace[]
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

const tlsHint = computed(() => {
  if (form.value.tls === 'off')
    return 'Plain HTTP: no certificate is served for this hostname.'
  if (form.value.tls === 'manual')
    return 'Serves the certificate pair uploaded below.'
  if (form.value.host.trim().length === 0)
    return 'A public hostname gets an ACME certificate; a local-only name gets the engine\u2019s own CA.'
  return isPublicHost(form.value.host)
    ? 'A public hostname, so the engine asks a CA for a certificate — an ACME account e-mail is needed.'
    : 'A local-only name, so the engine signs it with its own locally-trusted CA.'
})

watch(open, (isOpen) => {
  if (!isOpen)
    return
  form.value = props.draft === null ? newRouteDraft() : structuredClone(props.draft)
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

  const found = validateRouteDraft(candidate, { others: props.others, workspaces: props.workspaces })
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
    :title="editing ? 'Edit route' : 'Add route'"
    description="A hostname, what it forwards to, and how it is served over TLS."
    width="w-[min(92vw,34rem)]"
  >
    <div class="space-y-3">
      <TextField
        v-model="form.host"
        label="Hostname"
        placeholder="gitea.example.com"
        autocomplete="off"
        spellcheck="false"
        :error="errors.host"
        wide
      />
      <TextField
        v-model="form.path"
        label="Path prefix"
        placeholder="/optional"
        hint="Empty serves the whole host."
        spellcheck="false"
        :error="errors.path"
        wide
      />
      <SelectField v-model="form.target" label="Target" :options="TARGET_OPTIONS" />
      <SelectField v-model="form.tls" label="TLS" :options="TLS_OPTIONS" :hint="tlsHint" />

      <template v-if="form.target === 'server'">
        <SelectField
          v-model="form.workspace"
          label="Workspace"
          :options="props.workspaces.map(workspace => ({ value: workspace.id, label: workspace.label }))"
          :error="errors.workspace"
        />
        <SelectField
          v-model="form.server"
          label="Server"
          :options="serverOptions"
          :disabled="serverOptions.length === 0"
          :error="errors.server ?? (serverOptions.length === 0 ? 'this workspace has no servers' : null)"
        />
        <p class="text-2xs leading-4 text-faint sm:col-span-2">
          A server that is stopped is not routed: the row shows “No upstream” until it runs again.
        </p>
      </template>

      <TextField
        v-if="form.target === 'external'"
        v-model="form.url"
        label="Upstream"
        placeholder="http://10.0.0.5:8080"
        hint="A literal address, including the port. A scheme is optional."
        spellcheck="false"
        :error="errors.url"
        wide
      />

      <p v-if="form.target === 'panel'" class="text-2xs leading-4 text-warn sm:col-span-2">
        Serving the control panel needs authentication on and a password that is not the default —
        the panel refuses the save otherwise.
      </p>

      <Notice v-if="errors.form" tone="danger">
        {{ errors.form }}
      </Notice>
    </div>

    <template #footer>
      <AppButton size="sm" variant="ghost" @click="open = false">
        Cancel
      </AppButton>
      <AppButton size="sm" variant="primary" @click="submit">
        {{ editing ? 'Save route' : 'Add route' }}
      </AppButton>
    </template>
  </Modal>
</template>
