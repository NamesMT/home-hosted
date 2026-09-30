<script setup lang="ts">
import type { ProxyCertificateView, ProxyView } from '@shared/contracts'
import type { ListenerDraft, ProxyAction, ProxyWorkspace, RouteDraft } from '@/lib/proxy'
import { computed, onMounted, ref, watch } from 'vue'
import ConfirmButton from '@/components/ConfirmButton.vue'
import ProxyCertificateDialog from '@/components/ProxyCertificateDialog.vue'
import ProxyRouteDialog from '@/components/ProxyRouteDialog.vue'
import { useControlPlane } from '@/composables/useControlPlane'
import { flash } from '@/composables/useUi'
import * as api from '@/lib/api'
import {
  certificateTitle,
  changedKeys,
  cloneListenerDraft,
  cloneRoutes,
  firstPublicHost,
  formatBytes,
  isPrivilegedPort,
  proxyPatch,
  requiresEmail,
  ROUTE_STATUS_META,
  routeCertificate,
  routesPatch,
  RUN_STATE_META,
  targetSummary,
  tlsSummary,
  toProxyRoutes,
  UNPRIVILEGED_HTTP_PORT,
  UNPRIVILEGED_HTTPS_PORT,
  usesFallbackPorts,
} from '@/lib/proxy'

/**
 * The reverse proxy: panel-wide, because one engine exposes every workspace.
 *
 * The policy — whether it runs, the ports, the ACME account and the route table —
 * is written by this page's save. The engine binary and its lifecycle are actions
 * of their own. Live state rides the panel's state stream; a panel that does not
 * carry the field yet is read once from `/api/proxy`.
 */
const control = useControlPlane()

const fetched = ref<ProxyView | null>(null)
const loadError = ref<string | null>(null)
const actionError = ref<string | null>(null)
const saveError = ref<string | null>(null)
const saveMessage = ref<string | null>(null)
const saving = ref(false)
const busy = ref<ProxyAction | null>(null)

const form = ref<ListenerDraft>({ enabled: false, httpPort: 80, httpsPort: 443, email: '', staging: false })
const routes = ref<RouteDraft[]>([])

const dialogOpen = ref(false)
const editing = ref<RouteDraft | null>(null)

/** The live frame wins; the fetched view is what a panel without the field leaves us. */
const view = computed<ProxyView | null>(() => control.proxy.value ?? fetched.value)
const config = computed(() => view.value?.config ?? null)
const engine = computed(() => view.value?.engine ?? null)
const status = computed(() => view.value?.status ?? null)
const stateMeta = computed(() => (status.value === null ? null : RUN_STATE_META[status.value.state]))
const enginePath = computed(() => engine.value?.path ?? null)
const fallbackPorts = computed(() => usesFallbackPorts(form.value))
const privileged = computed(() => isPrivilegedPort(form.value.httpPort) || isPrivilegedPort(form.value.httpsPort))
const setcap = computed(() => (enginePath.value === null ? null : `sudo setcap 'cap_net_bind_service=+ep' ${enginePath.value}`))
const workspaces = computed<ProxyWorkspace[]>(() => control.workspaces.value.map(workspace => ({
  id: workspace.id,
  label: workspace.label,
  servers: workspace.servers.map(server => ({ id: server.id })),
})))

const emailHost = computed(() => (requiresEmail(form.value, routes.value) ? firstPublicHost(routes.value) : null))
const routesChanged = computed(() => config.value !== null && routesPatch(config.value.routes, routes.value) !== null)
const changed = computed(() => (config.value === null ? 0 : changedKeys(config.value, form.value, routes.value)))

/**
 * A route in error blocks every save, because the panel validates the whole config
 * a patch would produce. Once the table has been edited the save is let through and
 * the panel answers with the reason — a stale live view must never lock the page.
 */
const blocked = computed(() => {
  if (routesChanged.value)
    return []
  return (view.value?.routes ?? []).filter(entry => entry.status === 'error').map(entry => entry.message ?? `${entry.route.host} cannot be routed`)
})

const snapshots: { listener?: unknown, routes?: unknown } = {}

/** The console's copy of the per-block guard: JSON compare, keyed per block. */
function blockEdited(snapshot: unknown, current: unknown): boolean {
  return snapshot !== undefined && JSON.stringify(snapshot) !== JSON.stringify(current)
}

function syncFromLive(): void {
  const current = config.value
  if (current === null)
    return

  if (!blockEdited(snapshots.listener, { ...form.value })) {
    form.value = cloneListenerDraft(current)
    snapshots.listener = { ...form.value }
  }

  if (!blockEdited(snapshots.routes, toProxyRoutes(routes.value))) {
    routes.value = cloneRoutes(current.routes)
    snapshots.routes = toProxyRoutes(routes.value)
  }
}

watch(view, syncFromLive, { immediate: true })

const rows = computed(() => routes.value.map((route) => {
  const entry = view.value?.routes.find(candidate => candidate.route.id === route.id) ?? null
  return {
    route,
    entry,
    meta: entry === null ? null : ROUTE_STATUS_META[entry.status],
    target: targetSummary(route, workspaces.value),
    tls: tlsSummary(route),
    certificate: entry === null ? null : routeCertificate(entry),
  }
}))

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
  install: 'engine installed',
  start: 'engine starting',
  stop: 'engine stopping',
  apply: 'configuration applied',
  revert: 'configuration reverted',
}

async function act(action: ProxyAction): Promise<void> {
  if (busy.value !== null)
    return
  busy.value = action
  actionError.value = null
  try {
    fetched.value = await CALLS[action]()
    flash(ACTION_LABELS[action])
    await control.refresh()
  }
  catch (caught) {
    actionError.value = caught instanceof Error ? caught.message : String(caught)
    flash(actionError.value, 'error')
  }
  finally {
    busy.value = null
  }
}

async function save(): Promise<void> {
  const current = config.value
  const patch = current === null ? null : proxyPatch(current, form.value, routes.value)
  if (patch === null || saving.value || blocked.value.length > 0)
    return

  saving.value = true
  saveError.value = null
  saveMessage.value = null
  try {
    fetched.value = await api.patchProxy(patch)
    // Re-read the frame before re-filling, so the copy comes from what was saved.
    await control.refresh()
    saveMessage.value = 'settings saved'
    flash('reverse proxy saved')
    delete snapshots.listener
    delete snapshots.routes
    syncFromLive()
  }
  catch (caught) {
    saveError.value = caught instanceof Error ? caught.message : String(caught)
    flash(saveError.value, 'error')
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

function useFallback(): void {
  form.value.httpPort = UNPRIVILEGED_HTTP_PORT
  form.value.httpsPort = UNPRIVILEGED_HTTPS_PORT
}

function useStandard(): void {
  form.value.httpPort = 80
  form.value.httpsPort = 443
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

const certDialogOpen = ref(false)
const certBusy = ref(false)
const certError = ref<string | null>(null)

const certificates = computed(() => view.value?.certificates ?? [])
const takenCertificateIds = computed(() => certificates.value.map(entry => entry.id))

async function runCertificate(action: () => Promise<ProxyView>, done: string): Promise<boolean> {
  certBusy.value = true
  certError.value = null
  try {
    fetched.value = await action()
    flash(done)
    await control.refresh()
    return true
  }
  catch (caught) {
    certError.value = caught instanceof Error ? caught.message : String(caught)
    flash(certError.value, 'error')
    return false
  }
  finally {
    certBusy.value = false
  }
}

async function addCertificate(payload: { id: string, label: string, certificate: string, privateKey: string }): Promise<void> {
  const stored = await runCertificate(
    () => api.uploadProxyCertificate(payload.id, payload.label, payload.certificate, payload.privateKey),
    `“${payload.label}” stored`,
  )
  if (stored) {
    certDialogOpen.value = false
    certError.value = null
  }
}

function removeCertificate(certificate: ProxyCertificateView): void {
  void runCertificate(() => api.clearProxyCertificate(certificate.id), `“${certificateTitle(certificate)}” removed`)
}
</script>

<template>
  <div class="view">
    <header class="view__head">
      <span class="view__title">reverse proxy</span>
      <span class="view__count">panel-wide · one engine for every workspace</span>
      <span v-if="stateMeta" class="chip" :class="stateMeta.chip">{{ stateMeta.label }}</span>
      <span class="view__spacer" />
      <button type="button" class="btn btn--sm btn--ghost changelink" :disabled="changed === 0" @click="discard">
        <span class="mono">{{ changed }}</span> field{{ changed === 1 ? '' : 's' }} changed
      </button>
      <button type="button" class="btn btn--sm btn--primary" :disabled="changed === 0 || saving || blocked.length > 0" @click="save">
        save
      </button>
    </header>

    <div class="view__body">
      <p v-if="loadError" class="banner banner--error">
        {{ loadError }}
      </p>
      <p v-else-if="view === null" class="note">
        reading the reverse proxy…
      </p>

      <template v-else>
        <p v-if="blocked.length > 0" class="banner banner--error">
          {{ blocked.join(' · ') }}
        </p>
        <p v-else-if="saveError" class="banner banner--error">
          {{ saveError }}
        </p>
        <p v-else-if="saveMessage" class="note note--ok">
          {{ saveMessage }}
        </p>
        <p v-if="actionError" class="banner banner--error">
          {{ actionError }}
        </p>

        <section class="pane">
          <div class="pane__head">
            <span class="pane__title">engine</span>
            <span class="view__spacer" />
            <span v-if="engine?.version" class="mono faint">{{ engine.version }}</span>
            <span v-if="status?.pid" class="faint">pid <span class="mono">{{ status.pid }}</span></span>
          </div>
          <div class="pane__body">
            <p v-if="engine?.error" class="note note--error">
              {{ engine.error }}
            </p>

            <p v-if="engine && !engine.installed" class="note">
              no engine installed — installing downloads the pinned {{ engine.id }} build the panel
              supervises (about 46 MB, once)
            </p>

            <div v-else-if="engine" class="detailbox">
              <div class="detailbox__row">
                <span class="detailbox__k">version</span>
                <span class="detailbox__v mono">{{ engine.version ?? 'not probed yet' }}</span>
              </div>
              <div class="detailbox__row">
                <span class="detailbox__k">source</span>
                <span class="detailbox__v">{{ engine.source === 'custom' ? 'a path configured by hand' : 'downloaded by the panel' }}</span>
              </div>
              <div v-if="engine.bytes !== null" class="detailbox__row">
                <span class="detailbox__k">size</span>
                <span class="detailbox__v mono">{{ formatBytes(engine.bytes) }}</span>
              </div>
              <div v-if="engine.sha256" class="detailbox__row">
                <span class="detailbox__k">sha-256</span>
                <span class="detailbox__v mono truncate">{{ engine.sha256 }}</span>
              </div>
              <div v-if="engine.path" class="detailbox__row">
                <span class="detailbox__k">binary</span>
                <span class="detailbox__v mono truncate">{{ engine.path }}</span>
              </div>
              <div class="detailbox__row">
                <span class="detailbox__k">listens</span>
                <span class="detailbox__v mono">{{ status && status.urls.length > 0 ? status.urls.join(' · ') : '—' }}</span>
              </div>
              <div class="detailbox__row">
                <span class="detailbox__k">certificates</span>
                <span class="detailbox__v">
                  {{ status?.certExpiryDays === null || status?.certExpiryDays === undefined
                    ? 'no public certificate yet'
                    : `soonest expires in ${status.certExpiryDays} days` }}
                </span>
              </div>
              <div class="detailbox__row">
                <span class="detailbox__k">engine</span>
                <span class="detailbox__v">
                  <a class="changelink" :href="view.engines[0]?.docsUrl" target="_blank" rel="noreferrer">documentation</a>
                  <span v-if="view.engines[0]?.dns01 === false" class="faint"> · DNS-01 not available</span>
                  <span v-if="view.engines[0]?.tcp === false" class="faint"> · TCP/UDP not available</span>
                </span>
              </div>
            </div>

            <p v-if="status?.lastError" class="note note--error">
              {{ status.lastError }}
            </p>

            <p v-if="setcap" class="note">
              a privileged port needs this once on linux: <code>{{ setcap }}</code>
            </p>

            <div class="actions actions--start">
              <button
                v-if="!engine?.installed"
                type="button"
                class="btn btn--sm btn--primary"
                :disabled="busy !== null"
                @click="act('install')"
              >
                install engine
              </button>
              <template v-else>
                <button type="button" class="btn btn--sm btn--primary" :disabled="busy !== null || status?.state === 'running'" @click="act('start')">
                  start
                </button>
                <button type="button" class="btn btn--sm" :disabled="busy !== null || status?.state === 'off' || status?.state === 'stopped'" @click="act('stop')">
                  stop
                </button>
                <button type="button" class="btn btn--sm" :disabled="busy !== null || status?.state !== 'running'" @click="act('apply')">
                  apply config
                </button>
                <button type="button" class="btn btn--sm btn--ghost" :disabled="busy !== null || status?.state !== 'running'" title="go back to the configuration that applied before the last one" @click="act('revert')">
                  revert
                </button>
                <button type="button" class="btn btn--sm btn--ghost" :disabled="busy !== null" @click="act('install')">
                  update engine
                </button>
              </template>
            </div>
          </div>
        </section>

        <section class="pane">
          <div class="pane__head">
            <span class="pane__title">listener &amp; certificates</span>
            <span class="view__spacer" />
            <span v-if="fallbackPorts" class="chip chip--neutral">unprivileged ports</span>
          </div>
          <div class="pane__body">
            <div class="group">
              <div class="grid">
                <label class="field field--check grid__full">
                  <input v-model="form.enabled" type="checkbox">
                  <span class="field__label">run the reverse proxy</span>
                  <span class="field__hint">saved with save; the engine is started or stopped to match</span>
                </label>

                <label class="field">
                  <span class="field__label">http port</span>
                  <input v-model.number="form.httpPort" inputmode="numeric" type="number" min="1" max="65535">
                  <span class="field__hint">acme http-01 and the redirect to https</span>
                </label>

                <label class="field">
                  <span class="field__label">https port</span>
                  <input v-model.number="form.httpsPort" inputmode="numeric" type="number" min="1" max="65535">
                  <span class="field__hint">where certificates are served</span>
                </label>

                <label class="field grid__full">
                  <span class="field__label">acme account e-mail</span>
                  <input v-model="form.email" placeholder="you@example.com" spellcheck="false">
                  <span class="field__hint">a local-only name gets the engine's own CA and needs none</span>
                </label>

                <label class="field field--check grid__full">
                  <input v-model="form.staging" type="checkbox">
                  <span class="field__label">use the acme staging endpoint</span>
                  <span class="field__hint">untrusted certificates, no rate-limit burn</span>
                </label>
              </div>

              <p class="field__hint">
                a public name whose certificate is still being issued is reachable meanwhile — https serves a
                temporary untrusted certificate, and plain http a page naming the ports to forward
              </p>

              <div class="actions actions--start">
                <button type="button" class="btn btn--sm" @click="useFallback">
                  use {{ UNPRIVILEGED_HTTP_PORT }} / {{ UNPRIVILEGED_HTTPS_PORT }}
                </button>
                <button type="button" class="btn btn--sm btn--ghost" @click="useStandard">
                  use 80 / 443
                </button>
              </div>

              <p v-if="privileged" class="note note--warn">
                a port below 1024 needs a privileged bind. grant it once with
                <code v-if="setcap">{{ setcap }}</code><code v-else>setcap</code>
                and restart the engine, or keep {{ UNPRIVILEGED_HTTP_PORT }}/{{ UNPRIVILEGED_HTTPS_PORT }} and forward
                80/443 from your router.
              </p>

              <p v-if="emailHost !== null" class="note note--warn">
                “{{ emailHost }}” is a public hostname, so the engine asks a CA for a certificate and the
                account address is required.
              </p>
            </div>
          </div>
        </section>

        <section class="pane">
          <div class="pane__head">
            <span class="pane__title">routes</span>
            <span class="view__spacer" />
            <span class="faint">{{ rows.length }} route{{ rows.length === 1 ? '' : 's' }}</span>
            <button type="button" class="btn btn--xs" @click="openAdd">
              add route
            </button>
          </div>
          <div class="pane__body">
            <div v-if="rows.length > 0" class="tblwrap">
              <table class="tbl">
                <thead>
                  <tr>
                    <th>host</th>
                    <th>target</th>
                    <th>upstream</th>
                    <th>tls</th>
                    <th>state</th>
                    <th>on</th>
                    <th class="tbl__actions">
                      act
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in rows" :key="row.route.key" :class="{ 'is-dim': !row.route.enabled }">
                    <td>
                      <span class="id">{{ row.route.host || 'no hostname yet' }}</span>
                      <span v-if="row.route.path" class="accent">{{ row.route.path }}</span>
                      <span class="faint mono"> {{ row.route.id }}</span>
                    </td>
                    <td class="dim">
                      {{ row.target }}
                    </td>
                    <td class="mono dim">
                      {{ row.entry?.upstream ?? '—' }}
                    </td>
                    <td class="dim">
                      {{ row.tls }}
                      <span v-if="row.certificate" class="chip" :class="row.certificate.chip">{{ row.certificate.label }}</span>
                      <span
                        v-if="row.certificate?.message"
                        class="faint"
                        :class="{ danger: row.certificate.danger, warn: row.certificate.warn }"
                      >
                        {{ row.certificate.message }}
                      </span>
                    </td>
                    <td>
                      <span v-if="row.meta" class="chip" :class="row.meta.chip">{{ row.meta.label }}</span>
                      <span v-else class="chip chip--neutral">not applied</span>
                      <span v-if="row.entry?.message" class="faint" :class="{ danger: row.entry.status === 'error', warn: row.entry.status !== 'error' }">
                        {{ row.entry.message }}
                      </span>
                    </td>
                    <td>
                      <input v-model="row.route.enabled" type="checkbox" :title="`route ${row.route.host || row.route.id}`">
                    </td>
                    <td class="tbl__actions">
                      <span class="rowbtns">
                        <button type="button" class="btn btn--xs btn--icon" title="edit route" @click="openEdit(row.route)">
                          e
                        </button>
                        <button type="button" class="btn btn--xs btn--icon" title="remove route" @click="removeRoute(row.route)">
                          x
                        </button>
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <p v-else class="empty">
              no routes yet — add one to expose a server through a domain
            </p>

            <p class="field__hint">
              rows are a draft: save writes the whole list. removing one needs no confirmation, and a
              server that is stopped reads “no upstream” until it runs again.
            </p>
          </div>
        </section>

        <section class="pane">
          <div class="pane__head">
            <span class="pane__title">uploaded certificates</span>
            <span class="view__spacer" />
            <span class="faint">{{ certificates.length }} pair{{ certificates.length === 1 ? '' : 's' }}</span>
            <button type="button" class="btn btn--xs" :disabled="certBusy" @click="certDialogOpen = true">
              add certificate
            </button>
          </div>
          <div class="pane__body">
            <p v-if="certError" class="note note--error">
              {{ certError }}
            </p>

            <div v-if="certificates.length > 0" class="stack">
              <div v-for="certificate in certificates" :key="certificate.id" class="detailbox">
                <div class="detailbox__row">
                  <span class="detailbox__k">{{ certificateTitle(certificate) }}</span>
                  <span class="detailbox__v mono truncate">{{ certificate.id }}</span>
                </div>

                <p v-if="certificate.error" class="note note--error">
                  {{ certificate.error }}
                </p>
                <template v-else>
                  <div class="detailbox__row">
                    <span class="detailbox__k">subject</span>
                    <span class="detailbox__v mono truncate">{{ certificate.subject ?? '—' }}</span>
                  </div>
                  <div class="detailbox__row">
                    <span class="detailbox__k">issuer</span>
                    <span class="detailbox__v mono truncate">{{ certificate.issuer ?? '—' }}</span>
                  </div>
                  <div class="detailbox__row">
                    <span class="detailbox__k">valid until</span>
                    <span class="detailbox__v mono">
                      {{ certificate.validTo ? certificate.validTo.slice(0, 10) : '—' }}
                      <span
                        v-if="certificate.daysRemaining !== null"
                        class="faint"
                        :class="{ warn: certificate.daysRemaining < 14 }"
                      >({{ certificate.daysRemaining }} days)</span>
                    </span>
                  </div>
                  <div class="detailbox__row">
                    <span class="detailbox__k">covers</span>
                    <span class="detailbox__v mono truncate">
                      {{ certificate.hosts.length > 0 ? certificate.hosts.join(', ') : 'no hostnames in its SANs' }}
                    </span>
                  </div>
                </template>

                <div class="actions actions--start">
                  <ConfirmButton
                    label="remove"
                    confirm-label="confirm remove"
                    tone="danger"
                    :disabled="certBusy"
                    @confirm="removeCertificate(certificate)"
                  />
                </div>
              </div>
            </div>

            <p v-else class="empty">
              no certificate uploaded — a route set to “uploaded certificate” needs a pair covering its
              hostname, or the engine has nothing to serve for it
            </p>
          </div>
        </section>
      </template>
    </div>

    <ProxyRouteDialog
      :open="dialogOpen"
      :draft="editing"
      :others="routes.filter(route => route.key !== editing?.key)"
      :workspaces="workspaces"
      @close="dialogOpen = false"
      @save="applyRoute"
    />

    <ProxyCertificateDialog
      :open="certDialogOpen"
      :taken="takenCertificateIds"
      :busy="certBusy"
      :error="certError"
      @close="certDialogOpen = false"
      @submit="addCertificate"
    />
  </div>
</template>
