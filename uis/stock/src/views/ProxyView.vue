<script setup lang="ts">
import type { ProxyView } from '@shared/contracts'
import type { ListenerDraft, ProxyAction, ProxyWorkspace, RouteDraft } from '@/lib/proxy'
import { computed, onMounted, ref, watch } from 'vue'
import EnginePanel from '@/components/proxy/EnginePanel.vue'
import ListenerPanel from '@/components/proxy/ListenerPanel.vue'
import RouteDialog from '@/components/proxy/RouteDialog.vue'
import RouteTable from '@/components/proxy/RouteTable.vue'
import TlsPanel from '@/components/proxy/TlsPanel.vue'
import Notice from '@/components/settings/Notice.vue'
import { isBlockEdited } from '@/components/settings/settingsForm'
import AppButton from '@/components/ui/AppButton.vue'
import { useControlPlane } from '@/composables/useControlPlane'
import { useToasts } from '@/composables/useToasts'
import * as api from '@/lib/api'
import {
  cloneListenerDraft,
  cloneRoutes,
  firstPublicHost,
  proxyPatch,
  requiresEmail,
  routesPatch,
  toProxyRoutes,
} from '@/lib/proxy'

/**
 * The reverse proxy: panel-wide, because one engine exposes every workspace.
 *
 * The policy — whether it runs, the ports, the ACME account and the route table —
 * is written by this page's Save. The engine binary and its lifecycle are actions
 * of their own. Live state rides the panel's state stream; a panel that does not
 * carry the field yet is read once from `/api/proxy`.
 */
const control = useControlPlane()
const toasts = useToasts()

const fetched = ref<ProxyView | null>(null)
const loadError = ref<string | null>(null)
const actionError = ref<string | null>(null)
const saving = ref(false)
const busy = ref<ProxyAction | null>(null)

const form = ref<ListenerDraft>({ enabled: false, httpPort: 80, httpsPort: 443, email: '', staging: false })
const routes = ref<RouteDraft[]>([])

const dialogOpen = ref(false)
const editing = ref<RouteDraft | null>(null)

/** The live frame wins; the fetched view is what a panel without the field leaves us. */
const view = computed<ProxyView | null>(() => control.proxy.value ?? fetched.value)
const config = computed(() => view.value?.config ?? null)
const enginePath = computed(() => view.value?.engine.path ?? null)
const workspaces = computed<ProxyWorkspace[]>(() => control.workspaces.value.map(workspace => ({
  id: workspace.id,
  label: workspace.label,
  servers: workspace.servers.map(server => ({ id: server.id })),
})))

const emailHost = computed(() => (requiresEmail(form.value, routes.value) ? firstPublicHost(routes.value) : null))
const routesChanged = computed(() => config.value !== null && routesPatch(config.value.routes, routes.value) !== null)
const changedCount = computed(() => {
  if (config.value === null)
    return 0
  const patch = proxyPatch(config.value, form.value, routes.value)
  if (patch === null)
    return 0
  const listenerKeys = Object.keys(patch).filter(key => key !== 'routes').length
  return listenerKeys + (patch.routes === undefined ? 0 : 1)
})

/**
 * A route in error blocks every save, because the panel validates the whole
 * config a patch would produce. Once the table has been edited the save is let
 * through and the panel answers with the reason — a stale live view must never
 * lock the page out of its own fix.
 */
const liveProblems = computed(() => (view.value?.routes ?? []).filter(entry => entry.status === 'error'))
const blockedReasons = computed(() => (routesChanged.value ? [] : liveProblems.value.map(entry => entry.message ?? `${entry.route.host} cannot be routed`)))

const snapshots: { listener?: unknown, routes?: unknown } = {}

function syncFromLive(): void {
  const current = config.value
  if (current === null)
    return

  if (!isBlockEdited(snapshots.listener, { ...form.value })) {
    Object.assign(form.value, cloneListenerDraft(current))
    snapshots.listener = { ...form.value }
  }

  const wire = toProxyRoutes(routes.value)
  if (!isBlockEdited(snapshots.routes, wire)) {
    routes.value = cloneRoutes(current.routes)
    snapshots.routes = toProxyRoutes(routes.value)
  }
}

watch(view, syncFromLive, { immediate: true })

async function load(): Promise<void> {
  loadError.value = null
  try {
    fetched.value = await api.fetchProxy()
  }
  catch (caught) {
    loadError.value = caught instanceof Error ? caught.message : String(caught)
  }
}

onMounted(() => {
  // The frame is the normal source; this is the panel that predates the field.
  if (control.proxy.value === null)
    void load()
})

const CALLS: Record<ProxyAction, () => Promise<ProxyView>> = {
  install: () => api.installProxyEngine(),
  start: api.startProxy,
  stop: api.stopProxy,
  apply: api.applyProxy,
  revert: api.revertProxy,
}

const ACTION_LABELS: Record<ProxyAction, string> = {
  install: 'Engine installed',
  start: 'Engine starting',
  stop: 'Engine stopping',
  apply: 'Configuration applied',
  revert: 'Configuration reverted',
}

async function act(action: ProxyAction): Promise<void> {
  if (busy.value !== null)
    return
  busy.value = action
  actionError.value = null
  try {
    fetched.value = await CALLS[action]()
    toasts.success(ACTION_LABELS[action])
    await control.refresh()
  }
  catch (caught) {
    actionError.value = caught instanceof Error ? caught.message : String(caught)
  }
  finally {
    busy.value = null
  }
}

const saveError = ref<string | null>(null)
const saveMessage = ref<string | null>(null)

async function save(): Promise<void> {
  const current = config.value
  const patch = current === null ? null : proxyPatch(current, form.value, routes.value)
  if (patch === null || saving.value || blockedReasons.value.length > 0)
    return

  saving.value = true
  saveError.value = null
  saveMessage.value = null
  try {
    fetched.value = await api.patchProxy(patch)
    // Re-read the frame before re-filling the form, so the copy comes from what
    // was saved rather than from the frame that was still in flight.
    await control.refresh()
    saveMessage.value = 'Settings saved.'
    toasts.success('Settings saved')
    delete snapshots.listener
    delete snapshots.routes
    syncFromLive()
  }
  catch (caught) {
    saveError.value = caught instanceof Error ? caught.message : String(caught)
  }
  finally {
    saving.value = false
  }
}

function discard(): void {
  saveError.value = null
  saveMessage.value = null
  delete snapshots.listener
  delete snapshots.routes
  syncFromLive()
}

function openAdd(): void {
  editing.value = null
  dialogOpen.value = true
}

function openEdit(route: RouteDraft): void {
  editing.value = route
  dialogOpen.value = true
}

function applyRoute(next: RouteDraft): void {
  routes.value = editing.value === null
    ? [...routes.value, next]
    : routes.value.map(route => (route.key === editing.value?.key ? next : route))
  editing.value = null
}

function removeRoute(route: RouteDraft): void {
  routes.value = routes.value.filter(entry => entry.key !== route.key)
}

function toggleRoute(route: RouteDraft, enabled: boolean): void {
  route.enabled = enabled
}

async function applyTlsView(next: ProxyView): Promise<void> {
  fetched.value = next
  // The frame is preferred over this fallback, so re-read it: a certificate is
  // not a settings write, and nothing else would push a fresh frame.
  await control.refresh()
}
</script>

<template>
  <div class="min-h-full">
    <div class="mx-auto w-full max-w-5xl px-4 pb-6 pt-5 sm:px-6">
      <header class="mb-5">
        <h1 class="text-xl font-semibold tracking-tight text-ink">
          Reverse Proxy
        </h1>
        <p class="mt-1 text-xs text-muted">
          Expose your servers through domains, with certificates the engine obtains and renews on its own.
          Panel-wide: a route may point at any workspace's servers.
        </p>
      </header>

      <Notice v-if="loadError" tone="danger" title="The reverse proxy could not be read" class="mb-4">
        {{ loadError }}
      </Notice>

      <Notice v-if="view === null && loadError === null" tone="info" class="mb-4">
        Reading the reverse proxy…
      </Notice>

      <div v-if="view !== null" class="space-y-6">
        <EnginePanel :view="view" :busy="busy" @act="act" />

        <Notice v-if="actionError" tone="danger">
          {{ actionError }}
        </Notice>

        <ListenerPanel
          v-model:form="form"
          :engine-path="enginePath"
          :email-host="emailHost"
        />

        <RouteTable
          :routes="routes"
          :views="view.routes"
          :workspaces="workspaces"
          :disabled="saving"
          @add="openAdd"
          @edit="openEdit"
          @remove="removeRoute"
          @toggle="toggleRoute"
        />

        <TlsPanel :tls="view.tls" @changed="applyTlsView" />
      </div>
    </div>

    <div v-if="view !== null" class="sticky bottom-0 z-30 border-t border-line bg-panel/95 backdrop-blur">
      <div class="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
        <div class="min-w-0 flex-1">
          <p class="text-xs text-muted">
            <template v-if="changedCount > 0">
              <span class="font-mono tabular-nums text-ink">{{ changedCount }}</span>
              field{{ changedCount === 1 ? '' : 's' }} changed
            </template>
            <template v-else>
              No unsaved changes
            </template>
          </p>
          <p v-if="blockedReasons.length > 0" class="mt-0.5 text-xs text-danger">
            {{ blockedReasons.join(' · ') }}
          </p>
          <p v-else-if="saveError" class="mt-0.5 text-xs text-danger">
            {{ saveError }}
          </p>
          <p v-else-if="saveMessage" class="mt-0.5 text-xs text-ok">
            {{ saveMessage }}
          </p>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <AppButton variant="ghost" :disabled="changedCount === 0 || saving" @click="discard">
            Discard changes
          </AppButton>
          <AppButton
            variant="primary"
            :disabled="changedCount === 0 || blockedReasons.length > 0"
            :loading="saving"
            @click="save"
          >
            Save settings
          </AppButton>
        </div>
      </div>
    </div>

    <RouteDialog
      v-model:open="dialogOpen"
      :draft="editing"
      :others="routes.filter(route => route.key !== editing?.key)"
      :workspaces="workspaces"
      @save="applyRoute"
    />
  </div>
</template>
