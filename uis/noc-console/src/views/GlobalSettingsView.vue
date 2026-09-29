<script setup lang="ts">
import type { AuthStatus, BackupsView, ControlView, SettingsPatch } from '@shared/contracts'
import type { Patch } from '@shared/patch-diff'
import type { BackupFile, BackupPathEntry, SettingsSaveResult, SettingsView } from '@/lib/api'
import { countLeaves, describeChanges, diffFields } from '@shared/patch-diff'
import { computed, onMounted, reactive, ref, watch } from 'vue'
import BackupDialog from '@/components/BackupDialog.vue'
import ConfirmButton from '@/components/ConfirmButton.vue'
import RestoreDialog from '@/components/RestoreDialog.vue'
import { useControlPlane } from '@/composables/useControlPlane'
import { useSession } from '@/composables/useSession'
import { changesOpen } from '@/composables/useUi'
import * as api from '@/lib/api'
import { waitForEndpoint } from '@/lib/endpoint'
import { formatBytes, formatDateTime } from '@/lib/format'

/**
 * The panel-wide groups: listener, authentication, TLS, host vitals and backups.
 * Server defaults, log retention, notifications and DDNS belong to a workspace
 * and live on the workspace settings page.
 */
const control = useControlPlane()
const sessionApi = useSession()

const state = computed(() => control.appState.value)
const controlView = computed<ControlView | null>(() => control.control.value)
const workspaces = computed(() => control.workspaces.value)

/** The panel's own *config* (not the derived view) drives the host/backups forms. */
const settings = ref<SettingsView | null>(null)
const settingsMessage = ref<string | null>(null)
const settingsError = ref<string | null>(null)
const saving = ref(false)

const form = reactive({
  control: {
    label: 'NOC console',
    port: 3999,
    host: 'local' as string,
    openBrowser: false,
    tlsEnabled: false,
  },
  host: {
    enabled: true,
    intervalMs: 15000,
    diskPaths: '.',
    diskUsedPercent: 90,
    memoryUsedPercent: 90,
    swapUsedPercent: 50,
    loadPerCpu: 2,
    tempCelsius: 85,
  },
  backups: {
    enabled: true,
    keep: 5,
    includePaths: '',
  },
  auth: {
    enabled: false,
    sessionTtlMs: 604800000,
    cookieSecure: 'auto' as AuthStatus['cookieSecure'],
    trustProxy: false,
    maxLoginAttempts: 5,
    lockoutMs: 60000,
  },
})

function splitList(value: string): string[] {
  return value.split(',').map(entry => entry.trim()).filter(entry => entry.length > 0)
}

function joinList(values: readonly string[]): string {
  return values.join(', ')
}

/** Only the config-facing fields of the auth status; the rest is derived. */
function authConfig(status: AuthStatus): Record<string, unknown> {
  return {
    enabled: status.enabled,
    sessionTtlMs: status.sessionTtlMs,
    cookieSecure: status.cookieSecure,
    trustProxy: status.trustProxy,
    maxLoginAttempts: status.maxLoginAttempts,
    lockoutMs: status.lockoutMs,
  }
}

async function loadSettings(): Promise<void> {
  try {
    settings.value = await api.fetchSettings()
    applySettings()
  }
  catch (caught) {
    settingsError.value = caught instanceof Error ? caught.message : String(caught)
  }
}

type FormBlock = 'control' | 'auth' | 'host' | 'backups'
type FormSnapshots = Partial<Record<FormBlock, unknown>>

function fillControl(): boolean {
  const view = controlView.value
  if (!view)
    return false
  Object.assign(form.control, {
    label: view.label,
    port: view.port,
    host: view.host,
    openBrowser: view.openBrowser,
    tlsEnabled: view.tls.enabled,
  })
  return true
}

function fillAuth(): boolean {
  const view = controlView.value
  if (!view)
    return false
  Object.assign(form.auth, authConfig(view.auth))
  return true
}

function fillHost(): boolean {
  const configured = settings.value
  if (!configured)
    return false
  Object.assign(form.host, { ...configured.host, diskPaths: joinList(configured.host.diskPaths) })
  return true
}

function fillBackups(): boolean {
  const configured = settings.value
  if (!configured)
    return false
  Object.assign(form.backups, {
    enabled: configured.backups.enabled,
    keep: configured.backups.keep,
    includePaths: joinList(configured.backups.includePaths),
  })
  return true
}

const FILLERS: Record<FormBlock, () => boolean> = {
  control: fillControl,
  auth: fillAuth,
  host: fillHost,
  backups: fillBackups,
}

/** What each block held when it was last filled; absent means "never filled". */
const snapshots: FormSnapshots = {}

function blockSnapshot(block: FormBlock): unknown {
  switch (block) {
    case 'control': return { ...form.control }
    case 'auth': return { ...form.auth }
    case 'host': return { ...form.host }
    case 'backups': return { ...form.backups }
  }
}

/**
 * True when a block was filled from live state and edited since, so the next
 * frame must leave it alone. A block that was never filled is always free: the
 * schema defaults differ from the live config (`auth.enabled`, `backups.enabled`)
 * and would otherwise look like a pending edit that blocks its own first fill.
 */
function isBlockEdited(block: FormBlock): boolean {
  const snapshot = snapshots[block]
  return snapshot !== undefined && JSON.stringify(snapshot) !== JSON.stringify(blockSnapshot(block))
}

function remember(block: FormBlock): void {
  snapshots[block] = blockSnapshot(block)
}

function forgetSnapshots(): void {
  for (const key of Object.keys(snapshots))
    delete snapshots[key as FormBlock]
}

/** Fills each block from its own source unless the user is editing that block. */
function syncFromLive(): void {
  for (const block of Object.keys(FILLERS) as FormBlock[]) {
    if (isBlockEdited(block))
      continue
    if (FILLERS[block]())
      remember(block)
  }
}

/** The unconditional fill: on mount and just after a successful save. */
function applySettings(): void {
  for (const block of Object.keys(FILLERS) as FormBlock[]) {
    if (FILLERS[block]())
      remember(block)
  }
}

onMounted(loadSettings)

watch([controlView, settings, state], () => {
  syncFromLive()
}, { immediate: true })

const PRESET_BINDS = ['local', 'lan']

const bindMode = computed<string>({
  get: () => (PRESET_BINDS.includes(form.control.host) ? form.control.host : 'custom'),
  set: (mode) => {
    if (mode !== 'custom') {
      form.control.host = mode
      return
    }
    if (!PRESET_BINDS.includes(form.control.host))
      return
    const live = controlView.value?.bindHost ?? ''
    const specific = live !== '' && live !== '0.0.0.0' && live !== '127.0.0.1'
    form.control.host = specific ? live : '127.0.0.1'
  },
})

const hostOptions = computed(() => {
  const options = [
    { value: 'local', label: 'local — 127.0.0.1 (this machine only)' },
    { value: 'lan', label: 'lan — 0.0.0.0 (every interface)' },
  ]
  if (bindMode.value === 'custom')
    options.push({ value: 'custom', label: 'custom — a specific address' })
  return options
})

const liveAddress = computed(() => controlView.value?.url ?? '—')
const tlsAddress = computed(() => {
  const view = controlView.value
  return view ? `${view.protocol}://${view.bindHost}:${view.port}` : '—'
})

const passwordSet = computed(() => controlView.value?.auth.passwordSet === true)
const blockedReason = computed(() => controlView.value?.auth.blockedReason ?? null)
const exposed = computed(() => controlView.value?.auth.exposed === true)
const usingDefaultPassword = computed(() => controlView.value?.auth.usingDefaultPassword === true)
const authEnabledWithoutPassword = computed(() => form.auth.enabled && !passwordSet.value)

/** Listener, auth, TLS, host vitals and backups — the panel-wide groups. */
function buildGlobalPatch(view: ControlView): SettingsPatch {
  const patch: SettingsPatch = {}

  const controlPatch = diffFields(
    {
      label: view.label,
      port: view.port,
      host: view.host,
      openBrowser: view.openBrowser,
      tls: { enabled: view.tls.enabled },
      auth: authConfig(view.auth),
    },
    {
      label: form.control.label,
      port: form.control.port,
      host: form.control.host,
      openBrowser: form.control.openBrowser,
      tls: { enabled: form.control.tlsEnabled },
      auth: { ...form.auth },
    },
    ['auth'],
  )
  if (Object.keys(controlPatch).length > 0)
    patch.control = controlPatch as SettingsPatch['control']

  const configured = settings.value
  if (configured) {
    const hostPatch = diffFields(
      { ...configured.host, diskPaths: configured.host.diskPaths } as unknown as Patch,
      { ...form.host, diskPaths: splitList(form.host.diskPaths) } as unknown as Patch,
    )
    if (Object.keys(hostPatch).length > 0)
      patch.host = hostPatch as SettingsPatch['host']

    const backupsPatch = diffFields(
      configured.backups as unknown as Patch,
      { enabled: form.backups.enabled, keep: form.backups.keep, includePaths: splitList(form.backups.includePaths) } as unknown as Patch,
    )
    if (Object.keys(backupsPatch).length > 0)
      patch.backups = backupsPatch as SettingsPatch['backups']
  }

  return patch
}

const pendingPatch = computed(() => {
  const view = controlView.value
  if (!view)
    return null
  return buildGlobalPatch(view)
})

const changedCount = computed(() => (pendingPatch.value === null ? 0 : countLeaves(pendingPatch.value as Patch)))

/** What every patched field is compared against, keyed the way the patch is. */
const currentSnapshot = computed<Patch>(() => {
  const view = controlView.value
  const configured = settings.value
  return {
    control: view === null
      ? {}
      : {
          label: view.label,
          port: view.port,
          host: view.host,
          openBrowser: view.openBrowser,
          tls: { enabled: view.tls.enabled },
          auth: authConfig(view.auth),
        },
    host: configured === null ? {} : { ...configured.host, diskPaths: configured.host.diskPaths },
    backups: configured === null
      ? {}
      : { enabled: configured.backups.enabled, keep: configured.backups.keep, includePaths: configured.backups.includePaths },
  }
})

const changes = computed(() => (pendingPatch.value === null ? [] : describeChanges(pendingPatch.value as Patch, currentSnapshot.value)))

function formatChangeValue(value: unknown): string {
  if (value === undefined)
    return 'unset'
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function saveFromDialog(): void {
  changesOpen.value = false
  void saveSettings()
}

function openChanges(): void {
  changesOpen.value = true
}

function closeChanges(): void {
  changesOpen.value = false
}

async function saveSettings(): Promise<void> {
  saving.value = true
  settingsError.value = null
  settingsMessage.value = null

  try {
    const view = controlView.value
    if (!view) {
      settingsError.value = 'the settings are still loading'
      return
    }

    const globalPatch = buildGlobalPatch(view)
    if (Object.keys(globalPatch).length === 0) {
      settingsMessage.value = 'nothing changed'
      return
    }

    const saved: SettingsSaveResult | null = await control.saveSettings(globalPatch) ?? null
    if (!saved) {
      settingsError.value = control.lastError.value ?? 'the settings could not be saved'
      return
    }

    settings.value = saved
    // What was saved is what live state holds now, so every block may follow it
    // again — including the ones this save just brought back in sync.
    forgetSnapshots()
    applySettings()

    if (!saved.rebinding) {
      settingsMessage.value = 'saved'
      return
    }

    // The panel is moving: this page is talking to a stale origin now.
    const target = saved.targetUrl
    settingsMessage.value = `saved — moving the control panel to ${saved.control.url}`
    if (target === null || target === window.location.origin) {
      settingsMessage.value = 'saved — the control panel restarted on the same address'
      return
    }

    if (await waitForEndpoint(target))
      window.location.replace(target)
    else settingsError.value = `the control panel did not answer on ${target} — check the console`
  }
  finally {
    saving.value = false
  }
}

const currentPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const passwordMessage = ref<string | null>(null)
const passwordError = ref<string | null>(null)
const passwordSaving = ref(false)

async function savePassword(): Promise<void> {
  passwordError.value = null
  passwordMessage.value = null

  if (newPassword.value !== confirmPassword.value) {
    passwordError.value = 'the two passwords do not match'
    return
  }
  if (newPassword.value.length === 0) {
    passwordError.value = 'enter a new password'
    return
  }

  passwordSaving.value = true
  try {
    const failure = await sessionApi.setPassword(passwordSet.value ? currentPassword.value : undefined, newPassword.value)
    if (failure !== null) {
      passwordError.value = failure
      return
    }
    currentPassword.value = ''
    newPassword.value = ''
    confirmPassword.value = ''
    passwordMessage.value = 'password updated — other sessions were signed out'
  }
  finally {
    passwordSaving.value = false
  }
}

async function clearPassword(): Promise<void> {
  passwordError.value = null
  passwordMessage.value = null
  const failure = await sessionApi.clearPassword()
  if (failure !== null)
    passwordError.value = failure
  else passwordMessage.value = 'password cleared and authentication disabled'
}

const backupBusy = ref(false)
const backupMessage = ref<string | null>(null)
const backupError = ref<string | null>(null)
const createBackupOpen = ref(false)
const restoreOpen = ref(false)
/** Which archive the restore dialog starts on; `null` lets it pick. */
const restoreSource = ref<{ kind: 'stored', name: string } | null>(null)

const backupsView = computed<BackupsView | null>(() => control.backups.value)

/** Every declared data path, flattened out of the two-level entry tree. */
const backupPaths = computed<BackupPathEntry[]>(() =>
  (backupsView.value?.entries ?? []).flatMap(entry =>
    entry.items
      .filter(item => item.kind === 'data')
      .map<BackupPathEntry>(item => ({
        id: item.id,
        path: item.path ?? item.label,
        origin: item.origin ?? entry.label,
        included: item.included,
        note: item.note,
      })),
  ),
)
const backupFiles = computed<BackupFile[]>(() => backupsView.value?.files ?? [])

function openRestore(name?: string): void {
  restoreSource.value = name === undefined ? null : { kind: 'stored', name }
  restoreOpen.value = true
}

function onBackupDone(result: string): void {
  backupError.value = null
  backupMessage.value = result
  void control.refresh()
}

function onRestoreDone(result: string): void {
  backupError.value = null
  backupMessage.value = result
  void control.refresh()
}

async function removeBackup(name: string): Promise<void> {
  backupBusy.value = true
  backupError.value = null
  try {
    await api.deleteBackup(name)
    await control.refresh()
  }
  catch (caught) {
    backupError.value = caught instanceof Error ? caught.message : String(caught)
  }
  finally {
    backupBusy.value = false
  }
}

const certInput = ref('')
const keyInput = ref('')
const tlsMessage = ref<string | null>(null)
const tlsError = ref<string | null>(null)

async function readFileInto(event: Event, target: 'cert' | 'key'): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file)
    return
  const text = await file.text()
  if (target === 'cert')
    certInput.value = text
  else keyInput.value = text
}

async function uploadCertificate(): Promise<void> {
  tlsError.value = null
  tlsMessage.value = null
  try {
    const result = await api.uploadTls(certInput.value, keyInput.value)
    certInput.value = ''
    keyInput.value = ''
    tlsMessage.value = 'certificate stored'
    await control.refresh()
    if (result.rebinding && result.targetUrl && result.targetUrl !== window.location.origin) {
      if (await waitForEndpoint(result.targetUrl))
        window.location.replace(result.targetUrl)
    }
  }
  catch (caught) {
    tlsError.value = caught instanceof Error ? caught.message : String(caught)
  }
}

async function removeCertificate(): Promise<void> {
  tlsError.value = null
  tlsMessage.value = null
  try {
    await api.clearTls()
    tlsMessage.value = 'certificate removed'
    await control.refresh()
  }
  catch (caught) {
    tlsError.value = caught instanceof Error ? caught.message : String(caught)
  }
}

const globalSettingsPath = computed(() => (control.dataRoot.value.length > 0 ? `${control.dataRoot.value}/settings.json` : '—'))
const panelUrl = computed(() => controlView.value?.url ?? '—')

const uiFile = ref<File | null>(null)
const uiBusy = ref(false)
const uiMessage = ref<string | null>(null)
const uiError = ref<string | null>(null)
/** `/api/settings` is the only payload that carries the installed-UI status. */
const uiStatus = computed(() => settings.value?.ui ?? null)

function pickUiFile(event: Event): void {
  uiFile.value = (event.target as HTMLInputElement).files?.[0] ?? null
}

function applyUiStatus(ui: SettingsView['ui']): void {
  if (settings.value !== null)
    settings.value = { ...settings.value, ui }
}

async function installUi(): Promise<void> {
  if (uiFile.value === null) {
    uiError.value = 'choose a .zip first'
    return
  }
  uiBusy.value = true
  uiError.value = null
  uiMessage.value = null
  try {
    const result = await api.uploadUi(uiFile.value)
    applyUiStatus(result.ui)
    uiFile.value = null
    uiMessage.value = `installed ${result.meta?.name ?? 'UI'} — refresh to load it`
  }
  catch (caught) {
    uiError.value = caught instanceof Error ? caught.message : String(caught)
  }
  finally {
    uiBusy.value = false
  }
}

async function revertUi(): Promise<void> {
  uiBusy.value = true
  uiError.value = null
  uiMessage.value = null
  try {
    const result = await api.revertUi()
    applyUiStatus(result.ui)
    uiMessage.value = result.removed ? 'stock UI restored — refresh to load it' : 'no custom UI was installed'
  }
  catch (caught) {
    uiError.value = caught instanceof Error ? caught.message : String(caught)
  }
  finally {
    uiBusy.value = false
  }
}
</script>

<template>
  <div class="view">
    <header class="view__head">
      <span class="view__title">global settings</span>
      <span class="view__count">panel-wide · shared by every workspace</span>
      <span v-if="controlView?.restartRequired" class="chip chip--warn">restart required</span>
      <span class="view__spacer" />
      <button
        v-if="changedCount > 0"
        type="button"
        class="btn btn--sm btn--ghost changelink"
        @click="openChanges"
      >
        <span class="mono">{{ changedCount }}</span> field{{ changedCount === 1 ? '' : 's' }} changed
      </button>
      <button type="button" class="btn btn--sm btn--primary" :disabled="saving" @click="saveSettings">
        {{ saving ? 'Saving…' : 'Save settings' }}
      </button>
    </header>

    <div class="view__body">
      <section class="pane">
        <div class="pane__head">
          <span class="pane__title">control panel listener</span>
          <span class="view__spacer" />
          <span class="mono faint">{{ controlView?.bindHost ?? '—' }}:{{ controlView?.port ?? '—' }}</span>
        </div>
        <div class="pane__body">
          <div class="group">
            <div class="grid">
              <label class="field">
                <span class="field__label">panel label</span>
                <input v-model="form.control.label" maxlength="60">
              </label>
              <label class="field">
                <span class="field__label">port</span>
                <input v-model.number="form.control.port" inputmode="numeric">
              </label>
              <label class="field">
                <span class="field__label">bind</span>
                <select :value="bindMode" @change="bindMode = ($event.target as HTMLSelectElement).value">
                  <option v-for="option in hostOptions" :key="option.value" :value="option.value">
                    {{ option.label }}
                  </option>
                </select>
              </label>
              <label v-if="bindMode === 'custom'" class="field">
                <span class="field__label">bind address</span>
                <input v-model="form.control.host" placeholder="192.168.1.20" inputmode="numeric">
              </label>
              <label class="field field--check">
                <input v-model="form.control.openBrowser" type="checkbox">
                <span class="field__label">open a browser on <code>up</code></span>
              </label>
              <label class="field">
                <span class="field__label">live address</span>
                <input :value="liveAddress" disabled>
              </label>
            </div>
            <p v-if="controlView?.restartRequired" class="note note--warn">
              The listener is running on a different address than the config. Saving
              (or restarting) moves it.
            </p>
          </div>
        </div>
      </section>

      <section class="pane">
        <div class="pane__head">
          <span class="pane__title">interface</span>
          <span class="view__spacer" />
          <span v-if="uiStatus?.custom" class="chip chip--accent">custom ui</span>
          <span v-else class="chip chip--neutral">stock ui</span>
        </div>
        <div class="pane__body">
          <div class="group">
            <p class="note">
              Upload a static build as a <code>.zip</code> with <code>index.html</code> at the
              root to replace the panel UI; it may come from any framework. Reverting puts the
              bundled stock panel back.
            </p>
            <div class="grid grid--wide">
              <label class="field">
                <span class="field__label">install a ui build (.zip)</span>
                <input type="file" accept=".zip,application/zip" @change="pickUiFile">
              </label>
              <label class="field">
                <span class="field__label">installed into</span>
                <input :value="uiStatus?.dir ?? '—'" disabled>
              </label>
            </div>
            <div v-if="uiStatus?.meta" class="row">
              <span class="faint">current:</span>
              <span class="mono">{{ uiStatus.meta.name }}</span>
              <span class="faint">v{{ uiStatus.meta.version ?? '—' }}</span>
              <span class="faint">· {{ uiStatus.meta.files }} files</span>
              <span class="faint">· {{ formatDateTime(uiStatus.meta.uploadedAt ?? 0) }}</span>
            </div>
            <p v-if="uiError" class="note note--error">
              {{ uiError }}
            </p>
            <p v-if="uiMessage" class="note note--ok">
              {{ uiMessage }}
            </p>
            <div class="actions actions--start">
              <ConfirmButton
                v-if="uiStatus?.custom"
                label="Revert to stock"
                confirm-label="Confirm revert"
                tone="danger"
                :disabled="uiBusy"
                @confirm="revertUi"
              />
              <button type="button" class="btn btn--sm btn--primary" :disabled="uiBusy || uiFile === null" @click="installUi">
                Install UI
              </button>
            </div>
          </div>
        </div>
      </section>

      <section class="pane">
        <div class="pane__head">
          <span class="pane__title">authentication</span>
          <span class="view__spacer" />
          <span v-if="passwordSet" class="chip chip--ok">password set</span>
          <span v-else class="chip chip--danger">no password</span>
        </div>
        <div class="pane__body">
          <div class="group">
            <div class="grid">
              <label class="field field--check">
                <input v-model="form.auth.enabled" type="checkbox">
                <span class="field__label">require a password</span>
              </label>
              <label class="field field--check">
                <input v-model="form.auth.trustProxy" type="checkbox">
                <span class="field__label">behind a trusted reverse proxy</span>
              </label>
              <label class="field">
                <span class="field__label">session lifetime (ms)</span>
                <input v-model.number="form.auth.sessionTtlMs" inputmode="numeric">
              </label>
              <label class="field">
                <span class="field__label">cookie secure</span>
                <select v-model="form.auth.cookieSecure">
                  <option value="auto">auto — https only</option>
                  <option value="always">always</option>
                  <option value="never">never (plain http)</option>
                </select>
              </label>
              <label class="field">
                <span class="field__label">max login attempts</span>
                <input v-model.number="form.auth.maxLoginAttempts" inputmode="numeric">
              </label>
              <label class="field">
                <span class="field__label">lockout (ms)</span>
                <input v-model.number="form.auth.lockoutMs" inputmode="numeric">
              </label>
            </div>

            <p v-if="usingDefaultPassword" class="note note--warn">
              The panel is still using the default password. Change it below — binding
              beyond <code>127.0.0.1</code> stays refused until you do.
            </p>
            <p v-if="blockedReason" class="note note--error">
              {{ blockedReason }}
            </p>
            <p v-else-if="authEnabledWithoutPassword" class="note note--warn">
              Authentication is on but no password is set, so nothing is required yet — and
              binding beyond <code>127.0.0.1</code> stays refused until one exists.
            </p>
            <p v-else-if="exposed" class="note note--warn">
              This panel is reachable beyond <code>127.0.0.1</code>. Keep the password strong,
              or put a TLS-terminating proxy in front of it.
            </p>
          </div>
        </div>
      </section>

      <section class="pane">
        <div class="pane__head">
          <span class="pane__title">password</span>
          <span class="view__spacer" />
          <span class="faint">{{ passwordSet ? 'change or clear' : 'set one to enable auth' }}</span>
        </div>
        <div class="pane__body">
          <div class="group">
            <div class="grid">
              <label v-if="passwordSet" class="field">
                <span class="field__label">current password</span>
                <input v-model="currentPassword" type="password" autocomplete="current-password">
              </label>
              <label class="field">
                <span class="field__label">new password</span>
                <input v-model="newPassword" type="password" autocomplete="new-password">
              </label>
              <label class="field">
                <span class="field__label">repeat new password</span>
                <input v-model="confirmPassword" type="password" autocomplete="new-password">
                <span v-if="confirmPassword.length > 0 && confirmPassword !== newPassword" class="field__hint danger">does not match</span>
              </label>
            </div>

            <p v-if="newPassword.length > 0 && newPassword.length < 8" class="note note--warn">
              That is a short password. It is allowed, but only you can guess it — exposure
              beyond <code>127.0.0.1</code> stays available once the default is replaced.
            </p>
            <p v-if="passwordError" class="note note--error">
              {{ passwordError }}
            </p>
            <p v-if="passwordMessage" class="note note--ok">
              {{ passwordMessage }}
            </p>

            <div class="actions actions--start">
              <ConfirmButton
                v-if="passwordSet"
                label="Clear password"
                confirm-label="Confirm clear"
                tone="danger"
                :title="exposed ? 'Refused while the panel is reachable beyond loopback' : 'Removes the password and disables auth'"
                @confirm="clearPassword"
              />
              <button type="button" class="btn btn--sm btn--primary" :disabled="passwordSaving" @click="savePassword">
                {{ passwordSet ? 'Update password' : 'Set password and enable auth' }}
              </button>
            </div>
          </div>
        </div>
      </section>

      <section class="pane">
        <div class="pane__head">
          <span class="pane__title">host vitals thresholds</span>
          <span class="view__spacer" />
          <span v-if="control.host.value?.alerts.length" class="chip chip--danger">{{ control.host.value?.alerts.length }} alert(s)</span>
          <span v-else class="chip chip--ok">quiet</span>
        </div>
        <div class="pane__body">
          <div class="group">
            <div class="grid">
              <label class="field field--check">
                <input v-model="form.host.enabled" type="checkbox">
                <span class="field__label">sample this machine</span>
              </label>
              <label class="field">
                <span class="field__label">interval (ms)</span>
                <input v-model.number="form.host.intervalMs" inputmode="numeric">
              </label>
              <label class="field grid__full">
                <span class="field__label">disk paths (comma separated)</span>
                <input v-model="form.host.diskPaths" placeholder="., {home}">
              </label>
              <label class="field">
                <span class="field__label">disk used %</span>
                <input v-model.number="form.host.diskUsedPercent" inputmode="numeric">
              </label>
              <label class="field">
                <span class="field__label">memory used %</span>
                <input v-model.number="form.host.memoryUsedPercent" inputmode="numeric">
              </label>
              <label class="field">
                <span class="field__label">swap used %</span>
                <input v-model.number="form.host.swapUsedPercent" inputmode="numeric">
              </label>
              <label class="field">
                <span class="field__label">load per cpu</span>
                <input v-model.number="form.host.loadPerCpu" inputmode="numeric">
              </label>
              <label class="field">
                <span class="field__label">cpu temp °C</span>
                <input v-model.number="form.host.tempCelsius" inputmode="numeric">
              </label>
            </div>
            <p class="note">
              A threshold of 0 disables that alert. Breaches notify once (and once on recovery).
              <template v-if="control.host.value?.alerts.length">
                <br>Now: <span class="warn">{{ control.host.value?.alerts.join(' · ') }}</span>
              </template>
            </p>
          </div>
        </div>
      </section>

      <section class="pane">
        <div class="pane__head">
          <span class="pane__title">backups</span>
          <span class="view__spacer" />
          <span class="mono faint">{{ backupsView?.dir ?? '—' }}</span>
        </div>
        <div class="pane__body">
          <div class="group">
            <div class="grid">
              <label class="field field--check">
                <input v-model="form.backups.enabled" type="checkbox">
                <span class="field__label">allow backups</span>
              </label>
              <label class="field">
                <span class="field__label">keep</span>
                <input v-model.number="form.backups.keep" inputmode="numeric">
              </label>
              <label class="field grid__full">
                <span class="field__label">extra paths (comma separated)</span>
                <input v-model="form.backups.includePaths" placeholder="{home}/myapp-data">
              </label>
            </div>
            <p class="note">
              Config, secrets and TLS are captured unless a backup leaves them out. Data paths come
              from each entry's <code>dataEnvs</code> (see the server editor) and
              <code>backupPaths</code>; a path already covered by a declared parent is skipped.
              <template v-if="backupPaths.length > 0">
                <br>Declared:
                <template v-for="entry in backupPaths" :key="`${entry.origin}:${entry.path}`">
                  <code>{{ entry.path }}</code>
                  <em v-if="!entry.included" class="warn"> (skipped — {{ entry.note }})</em>
                  <em v-else class="dim"> ({{ entry.origin }})</em>{{ ' ' }}
                </template>
              </template>
            </p>
          </div>

          <div v-if="form.backups.enabled" class="group">
            <div class="group__head">
              <span class="group__title">create</span>
              <span class="group__note">pick what the archive captures before it is written</span>
            </div>
            <div class="actions actions--start">
              <button
                type="button"
                class="btn btn--sm btn--primary"
                :disabled="backupsView === null"
                @click="createBackupOpen = true"
              >
                create backup…
              </button>
            </div>
          </div>
          <div v-else class="group">
            <p class="note note--warn">
              Backups are off — nothing new is archived. Archives already on disk stay
              downloadable and restorable.
            </p>
          </div>

          <div class="group">
            <div class="group__head">
              <span class="group__title">archives</span>
              <span class="view__spacer" />
              <span class="faint">{{ backupFiles.length }} file(s)</span>
            </div>
            <div v-if="backupFiles.length > 0" class="tblwrap">
              <table class="tbl">
                <thead>
                  <tr>
                    <th>
                      archive
                    </th>
                    <th class="num">
                      size
                    </th>
                    <th>
                      created
                    </th>
                    <th class="tbl__actions">
                      actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="file in backupFiles" :key="file.name">
                    <td class="id">
                      {{ file.name }}
                      <span v-if="file.encrypted" class="chip chip--warn">encrypted</span>
                    </td>
                    <td class="num">
                      {{ formatBytes(file.sizeBytes) }}
                    </td>
                    <td class="dim">
                      {{ formatDateTime(file.createdAt) }}
                    </td>
                    <td class="tbl__actions">
                      <span class="rowbtns">
                        <a class="btn btn--xs" :href="api.backupDownloadUrl(file.name)">download</a>
                        <button type="button" class="btn btn--xs" :disabled="backupBusy" @click="openRestore(file.name)">
                          restore
                        </button>
                        <ConfirmButton
                          label="delete"
                          confirm-label="confirm"
                          tone="danger"
                          :disabled="backupBusy"
                          @confirm="removeBackup(file.name)"
                        />
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-else class="empty">
              No archives yet.
            </p>
          </div>

          <div class="group">
            <div class="group__head">
              <span class="group__title">restore</span>
              <span class="group__note">a plan lists what the archive holds before anything is written</span>
            </div>
            <div class="actions actions--start">
              <button type="button" class="btn btn--sm" :disabled="backupsView === null" @click="openRestore()">
                restore from an archive…
              </button>
            </div>
          </div>

          <p v-if="backupError" class="note note--error">
            {{ backupError }}
          </p>
          <p v-if="backupMessage" class="note note--ok">
            {{ backupMessage }}
          </p>
        </div>
      </section>

      <section class="pane">
        <div class="pane__head">
          <span class="pane__title">tls</span>
          <span class="view__spacer" />
          <span v-if="controlView?.tls.certPresent" class="chip chip--ok">certificate present</span>
          <span v-else class="chip chip--neutral">no certificate</span>
        </div>
        <div class="pane__body">
          <div class="group">
            <div class="grid">
              <label class="field field--check">
                <input v-model="form.control.tlsEnabled" type="checkbox">
                <span class="field__label">serve the panel over https</span>
              </label>
              <label class="field">
                <span class="field__label">live address</span>
                <input :value="tlsAddress" disabled>
              </label>
            </div>

            <div v-if="controlView?.tls.error" class="note note--error">
              {{ controlView.tls.error }}
            </div>
            <p v-else-if="controlView?.tls.certPresent" class="note note--ok">
              {{ controlView.tls.subject }}
              <br>
              issued by {{ controlView.tls.issuer ?? '—' }} · expires {{ controlView.tls.validTo?.slice(0, 10) }} ({{ controlView.tls.daysRemaining }} days) · key matches: {{ controlView.tls.keyMatches ? 'yes' : 'no' }}
              <br>
              <code>{{ controlView.tls.fingerprint }}</code>
            </p>
            <p v-else class="note">
              No certificate uploaded. Upload a PEM pair (a self-signed one is fine for a
              home network) and tick the box above to serve https.
            </p>
          </div>

          <div class="group">
            <div class="group__head">
              <span class="group__title">upload a pem pair</span>
            </div>
            <div class="grid grid--wide">
              <label class="field">
                <span class="field__label">certificate file (.pem/.crt)</span>
                <input type="file" accept=".pem,.crt,.cer,text/plain" @change="readFileInto($event, 'cert')">
              </label>
              <label class="field">
                <span class="field__label">private key file (.pem/.key)</span>
                <input type="file" accept=".pem,.key,text/plain" @change="readFileInto($event, 'key')">
              </label>
              <label class="field grid__full">
                <span class="field__label">or paste the certificate</span>
                <textarea v-model="certInput" rows="3" spellcheck="false" placeholder="-----BEGIN CERTIFICATE-----" />
              </label>
              <label class="field grid__full">
                <span class="field__label">or paste the private key</span>
                <textarea v-model="keyInput" rows="3" spellcheck="false" placeholder="-----BEGIN PRIVATE KEY-----" />
              </label>
            </div>

            <p v-if="tlsError" class="note note--error">
              {{ tlsError }}
            </p>
            <p v-if="tlsMessage" class="note note--ok">
              {{ tlsMessage }}
            </p>

            <div class="actions actions--start">
              <ConfirmButton
                v-if="controlView?.tls.certPresent"
                label="Remove certificate"
                confirm-label="Confirm remove"
                tone="danger"
                @confirm="removeCertificate"
              />
              <button
                type="button"
                class="btn btn--sm btn--primary"
                :disabled="certInput.trim().length === 0 || keyInput.trim().length === 0"
                @click="uploadCertificate"
              >
                Save certificate
              </button>
            </div>
          </div>
        </div>
      </section>

      <section class="pane">
        <div class="pane__head">
          <span class="pane__title">paths</span>
          <span class="view__spacer" />
          <span class="faint">read-only</span>
        </div>
        <div class="pane__body">
          <div class="group">
            <div class="stack">
              <div class="row">
                <span class="faint paths__key">data root</span>
                <code class="truncate" :title="control.dataRoot.value">{{ control.dataRoot.value || '—' }}</code>
              </div>
              <div class="row">
                <span class="faint paths__key">settings</span>
                <code class="truncate" :title="globalSettingsPath">{{ globalSettingsPath }}</code>
              </div>
              <div class="row">
                <span class="faint paths__key">project</span>
                <code class="truncate" :title="control.projectDir.value">{{ control.projectDir.value || '—' }}</code>
              </div>
              <div class="row">
                <span class="faint paths__key">panel</span>
                <code class="truncate" :title="panelUrl">{{ panelUrl }}</code>
              </div>
            </div>

            <div class="group__head">
              <span class="group__title">workspace files</span>
              <span class="group__note">each workspace owns its own config, settings and logs</span>
            </div>
            <div v-for="workspace in workspaces" :key="workspace.id" class="stack">
              <div class="row">
                <span class="faint paths__key truncate">{{ workspace.label }}</span>
                <span class="mono truncate" :title="workspace.configPath">{{ workspace.configPath }}</span>
              </div>
              <div class="row">
                <span class="faint paths__key truncate">{{ workspace.id }} settings</span>
                <span class="mono truncate" :title="workspace.settingsPath">{{ workspace.settingsPath }}</span>
              </div>
              <div class="row">
                <span class="faint paths__key truncate">{{ workspace.id }} logs</span>
                <span class="mono truncate" :title="workspace.logsDir">{{ workspace.logsDir }}</span>
              </div>
            </div>

            <div class="group__head">
              <span class="group__title">diagnostics</span>
            </div>
            <div class="row">
              <a class="btn btn--xs" href="/openapi/ui" target="_blank" rel="noreferrer">openapi browser</a>
              <a class="btn btn--xs" href="/openapi/spec.json" target="_blank" rel="noreferrer">openapi spec</a>
              <a class="btn btn--xs" href="/healthz" target="_blank" rel="noreferrer">healthz</a>
              <a class="btn btn--xs" href="/api/metrics" target="_blank" rel="noreferrer">prometheus metrics</a>
            </div>
            <p class="note">
              <code>/healthz</code> and <code>/openapi/*</code> answer without a session;
              <code>/api/metrics</code> uses this one.
            </p>
          </div>
        </div>
      </section>

      <p v-if="settingsError" class="note note--error settings-note">
        {{ settingsError }}
      </p>
      <p v-if="settingsMessage" class="note note--ok settings-note">
        {{ settingsMessage }}
      </p>
    </div>

    <div v-if="changesOpen" class="overlay" @click.self="closeChanges">
      <div class="overlay__panel overlay__panel--sheet" role="dialog" aria-label="unsaved settings changes">
        <div class="overlay__head">
          <span class="overlay__title">unsaved changes</span>
          <span class="view__spacer" />
          <span class="faint">{{ changedCount }} field(s) → settings.json</span>
          <kbd class="kbd">esc</kbd>
          <button type="button" class="btn btn--xs btn--ghost" @click="closeChanges">
            close
          </button>
        </div>
        <div class="overlay__body">
          <div v-if="changes.length > 0" class="change-list">
            <div v-for="change in changes" :key="change.path" class="change-row">
              <code class="change-row__path">{{ change.path }}</code>
              <span class="change-row__from">{{ formatChangeValue(change.from) }}</span>
              <span class="change-row__arrow">→</span>
              <span class="change-row__to">{{ formatChangeValue(change.to) }}</span>
            </div>
          </div>
          <p v-else class="empty">
            nothing changed
          </p>
        </div>
        <div class="group">
          <div class="actions">
            <button type="button" class="btn btn--sm" @click="closeChanges">
              close
            </button>
            <button type="button" class="btn btn--sm btn--primary" :disabled="saving || changes.length === 0" @click="saveFromDialog">
              save {{ changes.length }} change{{ changes.length === 1 ? '' : 's' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <BackupDialog
    :open="createBackupOpen"
    :state="backupsView"
    @close="createBackupOpen = false"
    @done="onBackupDone"
  />
  <RestoreDialog
    :open="restoreOpen"
    :files="backupFiles"
    :initial="restoreSource"
    @close="restoreOpen = false"
    @done="onRestoreDone"
  />
</template>

<style scoped>
.paths__key {
  min-width: 8rem;
}
.settings-note {
  margin: 0.5rem 0.75rem;
}
</style>
