<script setup lang="ts">
import type { AuthStatus, ControlView, LogsConfig, ServerDefaults, SettingsPatch, TelegramStatus } from '@shared/contracts'
import type { Patch } from '@shared/patch-diff'

import type { BackupsState, RestoreOptions, RestorePlan, SettingsView } from '@/lib/api'
import { countLeaves, describeChanges, diffFields } from '@shared/patch-diff'
import { computed, onMounted, reactive, ref, watch } from 'vue'
import ConfirmButton from '@/components/ConfirmButton.vue'
import LifecycleFields from '@/components/LifecycleFields.vue'
import { useControlPlane } from '@/composables/useControlPlane'
import { useSession } from '@/composables/useSession'
import { changesOpen } from '@/composables/useUi'
import * as api from '@/lib/api'
import { waitForEndpoint } from '@/lib/endpoint'
import { formatBytes, formatDateTime } from '@/lib/format'

const control = useControlPlane()
const sessionApi = useSession()

/** The config schema carries `onHost`; the derived SSE view type has not caught up. */
type TelegramPolicy = TelegramStatus & { onHost?: boolean }

const state = computed(() => control.appState.value)
const controlView = computed<ControlView | null>(() => control.control.value)
const defaultsView = computed<ServerDefaults | null>(() => control.defaults.value)
const telegram = computed<TelegramPolicy | null>(() => state.value?.notifications.telegram ?? null)

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
  logs: {
    persist: true,
    maxBytes: 2000000,
    keep: 3,
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
  notifications: {
    telegram: {
      enabled: false,
      chatId: '',
      onCrash: true,
      onUnhealthy: true,
      onForcedRestart: true,
      onRecovered: false,
      onHost: true,
      cooldownMs: 120000,
    },
  },
  auth: {
    enabled: false,
    sessionTtlMs: 604800000,
    cookieSecure: 'auto' as AuthStatus['cookieSecure'],
    trustProxy: false,
    maxLoginAttempts: 5,
    lockoutMs: 60000,
  },
  defaults: {
    enabled: true,
    autostart: false,
    bind: 'local' as ServerDefaults['bind'],
    onPortConflict: 'block' as ServerDefaults['onPortConflict'],
    logBufferLines: 500,
    restart: { enabled: true, maxRetries: 3, baseDelayMs: 1000, factor: 2, maxDelayMs: 30000, resetAfterMs: 60000 },
    health: {
      enabled: true,
      mode: 'port' as 'port' | 'http',
      http: { path: '/', method: 'GET' as 'GET' | 'HEAD', expectStatus: undefined as number | null | undefined, expectStatusBelow: 400, expectBody: '' },
      intervalMs: 5000,
      timeoutMs: 1500,
      unhealthyThreshold: 3,
      forceRestartAfterMs: 0,
      startTimeoutMs: 20000,
    },
    stop: { signal: 'SIGTERM' as ServerDefaults['stop']['signal'], killGroup: true, graceMs: 5000, killPortHolders: false },
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

/** Only the config-facing fields of the telegram status; the rest is derived. */
function telegramConfig(status: TelegramPolicy): Record<string, unknown> {
  return {
    enabled: status.enabled,
    chatId: status.chatId,
    onCrash: status.onCrash,
    onUnhealthy: status.onUnhealthy,
    onForcedRestart: status.onForcedRestart,
    onRecovered: status.onRecovered,
    onHost: status.onHost === true,
    cooldownMs: status.cooldownMs,
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

type FormBlock = 'control' | 'auth' | 'defaults' | 'logs' | 'telegram' | 'host' | 'backups'
type FormSnapshots = Partial<Record<FormBlock, unknown>>

/** A copy of the health group, nested `http` included. */
function cloneHealth(health: ServerDefaults['health']): ServerDefaults['health'] {
  return { ...health, http: { ...health.http } }
}

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

function fillDefaults(): boolean {
  const defaults = defaultsView.value
  if (!defaults)
    return false
  Object.assign(form.defaults, {
    enabled: defaults.enabled,
    autostart: defaults.autostart,
    bind: defaults.bind,
    onPortConflict: defaults.onPortConflict,
    logBufferLines: defaults.logBufferLines,
  })
  Object.assign(form.defaults.restart, defaults.restart)
  Object.assign(form.defaults.health, cloneHealth(defaults.health))
  Object.assign(form.defaults.stop, defaults.stop)
  return true
}

function fillLogs(): boolean {
  const logs: LogsConfig | undefined = state.value?.logs
  if (!logs)
    return false
  Object.assign(form.logs, logs)
  return true
}

function fillTelegram(): boolean {
  const status = state.value?.notifications.telegram
  if (!status)
    return false
  Object.assign(form.notifications.telegram, telegramConfig(status))
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
  defaults: fillDefaults,
  logs: fillLogs,
  telegram: fillTelegram,
  host: fillHost,
  backups: fillBackups,
}

/** What each block held when it was last filled; absent means "never filled". */
const snapshots: FormSnapshots = {}

function blockSnapshot(block: FormBlock): unknown {
  switch (block) {
    case 'control': return { ...form.control }
    case 'auth': return { ...form.auth }
    case 'defaults': return {
      ...form.defaults,
      restart: { ...form.defaults.restart },
      health: cloneHealth(form.defaults.health),
      stop: { ...form.defaults.stop },
    }
    case 'logs': return { ...form.logs }
    case 'telegram': return { ...form.notifications.telegram }
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

/** A block the user just reset by hand is back in sync with its source. */
function remember(block: FormBlock): void {
  snapshots[block] = blockSnapshot(block)
}

function forgetSnapshots(): void {
  for (const key of Object.keys(snapshots))
    delete snapshots[key as FormBlock]
}

/**
 * Fills each block from its own source unless the user is editing that block.
 * Host thresholds and the backups policy land from `/api/settings` *after* the
 * state stream, so a single global gate would leave those two showing schema
 * defaults forever — the backups toggle reported itself as changed on reload.
 */
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

watch([controlView, defaultsView, settings, state], () => {
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

function buildPatch(view: ControlView, defaults: ServerDefaults): SettingsPatch {
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

  const defaultsPatch = diffFields(
    defaults as unknown as Patch,
    { ...form.defaults } as unknown as Patch,
    ['restart', 'health', 'stop'],
  )
  if (Object.keys(defaultsPatch).length > 0)
    patch.defaults = defaultsPatch as SettingsPatch['defaults']

  const configured = settings.value
  if (configured) {
    const logsPatch = diffFields(configured.logs as unknown as Patch, { ...form.logs } as unknown as Patch)
    if (Object.keys(logsPatch).length > 0)
      patch.logs = logsPatch as SettingsPatch['logs']

    const notificationsPatch = diffFields(
      configured.notifications as unknown as Patch,
      { telegram: { ...form.notifications.telegram } } as unknown as Patch,
      ['telegram'],
    )
    if (Object.keys(notificationsPatch).length > 0)
      patch.notifications = notificationsPatch as SettingsPatch['notifications']

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

const pendingPatch = computed<SettingsPatch | null>(() => {
  const view = controlView.value
  const defaults = defaultsView.value
  if (!view || !defaults)
    return null
  return buildPatch(view, defaults)
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
    defaults: defaultsView.value ?? {},
    logs: configured?.logs ?? {},
    notifications: configured === null ? {} : { telegram: configured.notifications.telegram },
    host: configured === null ? {} : { ...configured.host, diskPaths: configured.host.diskPaths },
    backups: configured === null
      ? {}
      : { enabled: configured.backups.enabled, keep: configured.backups.keep, includePaths: configured.backups.includePaths },
  }
})

const changes = computed(() => (pendingPatch.value === null
  ? []
  : describeChanges(pendingPatch.value as Patch, currentSnapshot.value)))

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
    const defaults = defaultsView.value
    if (!view || !defaults) {
      settingsError.value = 'the settings are still loading'
      return
    }

    const patch = buildPatch(view, defaults)
    if (Object.keys(patch).length === 0) {
      settingsMessage.value = 'nothing changed'
      return
    }

    const result = await control.saveSettings(patch)
    if (!result) {
      settingsError.value = control.lastError.value ?? 'the settings could not be saved'
      return
    }

    settings.value = result
    // What was saved is what live state holds now, so every block may follow it
    // again — including the ones this save just brought back in sync.
    forgetSnapshots()
    applySettings()

    if (!result.rebinding) {
      settingsMessage.value = 'saved'
      return
    }

    // The panel is moving: this page is talking to a stale origin now.
    const target = result.targetUrl
    settingsMessage.value = `saved — moving the control panel to ${result.control.url}`
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
/** Optional: encrypts the next archive. Never stored anywhere. */
const backupPassword = ref('')
const restorePlan = ref<RestorePlan | null>(null)
const restoreFile = ref<File | null>(null)
const restorePassword = ref('')
/** What the shown plan refers to, so "apply" cannot target the wrong archive. */
const restoreTarget = ref<{ kind: 'stored', name: string } | { kind: 'upload' } | null>(null)

const backupPaths = computed(() => state.value?.backups.paths ?? [])
const backupFiles = computed(() => state.value?.backups.files ?? [])
const backupsView = computed<BackupsState | null>(() => settings.value?.backups ?? null)
const selectedCount = computed(() => restorePlan.value?.items.filter(item => item.selected).length ?? 0)
const restoringConfig = computed(() => restorePlan.value?.items.some(item => item.id === 'config' && item.selected) ?? false)

function selectAllRestorable(selected: boolean): void {
  for (const item of restorePlan.value?.items ?? []) {
    if (item.restorable)
      item.selected = selected
  }
}

async function runBackup(): Promise<void> {
  backupBusy.value = true
  backupError.value = null
  backupMessage.value = null
  try {
    await api.createBackup(backupPassword.value)
    backupPassword.value = ''
    backupMessage.value = 'backup created'
    await control.refresh()
  }
  catch (caught) {
    backupError.value = caught instanceof Error ? caught.message : String(caught)
  }
  finally {
    backupBusy.value = false
  }
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

function pickRestoreFile(event: Event): void {
  restoreFile.value = (event.target as HTMLInputElement).files?.[0] ?? null
  restorePlan.value = null
  restoreTarget.value = null
}

function restoreOptions(): RestoreOptions {
  return restorePassword.value.length > 0 ? { password: restorePassword.value } : {}
}

/** `name` selects a stored archive; without it the picked upload is used. */
async function planRestore(name?: string): Promise<void> {
  backupBusy.value = true
  backupError.value = null
  backupMessage.value = null
  restorePlan.value = null
  try {
    if (name !== undefined) {
      restoreTarget.value = { kind: 'stored', name }
      restorePlan.value = await api.restoreStoredBackup(name, false, restoreOptions())
    }
    else if (restoreFile.value !== null) {
      restoreTarget.value = { kind: 'upload' }
      restorePlan.value = await api.restoreUploadedBackup(restoreFile.value, false, restoreOptions())
    }
    else {
      restoreTarget.value = null
    }

    if (restorePlan.value === null)
      backupError.value = 'choose a stored archive or upload one first'
  }
  catch (caught) {
    restoreTarget.value = null
    backupError.value = caught instanceof Error ? caught.message : String(caught)
  }
  finally {
    backupBusy.value = false
  }
}

/** Re-reads the same archive, now with whatever the password field holds. */
async function replanRestore(): Promise<void> {
  const target = restoreTarget.value
  if (target === null)
    return
  await planRestore(target.kind === 'stored' ? target.name : undefined)
}

async function applyRestore(): Promise<void> {
  const target = restoreTarget.value
  const plan = restorePlan.value
  if (target === null || plan === null) {
    backupError.value = 'check an archive first'
    return
  }

  backupBusy.value = true
  backupError.value = null
  const options: RestoreOptions = {
    ...restoreOptions(),
    include: plan.items.filter(item => item.restorable && item.selected).map(item => item.id),
  }

  try {
    const result = target.kind === 'stored'
      ? await api.restoreStoredBackup(target.name, true, options)
      : restoreFile.value !== null
        ? await api.restoreUploadedBackup(restoreFile.value, true, options)
        : null

    restorePlan.value = null
    restoreTarget.value = null
    restoreFile.value = null
    restorePassword.value = ''

    const notes: string[] = []
    if (result?.reloaded)
      notes.push('the restored servers are live, autostart entries starting')
    if (result?.restartRequired)
      notes.push('restart home-hosted to apply the panel settings')
    backupMessage.value = result === null
      ? 'restore failed'
      : `restored ${result.applied.length} item(s)${notes.length === 0 ? '' : ` — ${notes.join('; ')}`}`
    if (result !== null && result.skipped.length > 0)
      backupMessage.value += ` · skipped: ${result.skipped.join(', ')}`
    await control.refresh()
  }
  catch (caught) {
    backupError.value = caught instanceof Error ? caught.message : String(caught)
  }
  finally {
    backupBusy.value = false
  }
}

const tokenInput = ref('')
const tokenMessage = ref<string | null>(null)
const tokenError = ref<string | null>(null)
const detectedChats = ref<Array<{ id: number | string, title: string }>>([])
const notifyBusy = ref(false)

async function saveToken(): Promise<void> {
  tokenError.value = null
  tokenMessage.value = null
  try {
    const result = await api.saveTelegramToken(tokenInput.value.trim())
    tokenInput.value = ''
    tokenMessage.value = `token saved${result.username ? ` (bot @${result.username})` : ''}`
    await control.refresh()
  }
  catch (caught) {
    tokenError.value = caught instanceof Error ? caught.message : String(caught)
  }
}

async function removeToken(): Promise<void> {
  tokenError.value = null
  tokenMessage.value = null
  try {
    await api.clearTelegramToken()
    tokenMessage.value = 'token removed'
    await control.refresh()
  }
  catch (caught) {
    tokenError.value = caught instanceof Error ? caught.message : String(caught)
  }
}

async function detectChats(): Promise<void> {
  notifyBusy.value = true
  tokenError.value = null
  try {
    const override = tokenInput.value.trim()
    const result = await api.detectTelegramChats(override.length > 0 ? { botToken: override } : {})
    detectedChats.value = result.chats
    if (result.chats.length === 0)
      tokenError.value = 'no chats found — send /start to the bot first, then detect again'
  }
  catch (caught) {
    tokenError.value = caught instanceof Error ? caught.message : String(caught)
  }
  finally {
    notifyBusy.value = false
  }
}

async function sendTest(): Promise<void> {
  notifyBusy.value = true
  tokenError.value = null
  tokenMessage.value = null
  try {
    const override = tokenInput.value.trim()
    const result = await api.sendTelegramTest({
      chatId: form.notifications.telegram.chatId.length > 0 ? form.notifications.telegram.chatId : undefined,
      ...(override.length > 0 ? { botToken: override } : {}),
    })
    if (result.ok)
      tokenMessage.value = 'test message sent'
    else tokenError.value = result.error ?? 'the test message failed'
    await control.refresh()
  }
  catch (caught) {
    tokenError.value = caught instanceof Error ? caught.message : String(caught)
  }
  finally {
    notifyBusy.value = false
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

const paths = computed(() => {
  const current = state.value
  return [
    { label: 'config', value: current?.configPath ?? '—' },
    { label: 'project', value: current?.projectDir ?? '—' },
    { label: 'data root', value: current?.dataRoot ?? '—' },
    { label: 'logs', value: current?.logsDir ?? '—' },
  ]
})

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
      <span class="view__title">settings</span>
      <span class="view__count">panel config · servers.config.json</span>
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
              <span class="faint">· {{ formatDateTime(uiStatus.meta.uploadedAt) }}</span>
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
          <span class="pane__title">server defaults</span>
          <span class="view__spacer" />
          <span class="faint">a server that sets its own value wins</span>
        </div>
        <div class="pane__body">
          <div class="group">
            <div class="grid">
              <label class="field field--check">
                <input v-model="form.defaults.enabled" type="checkbox">
                <span class="field__label">enabled</span>
              </label>
              <label class="field field--check">
                <input v-model="form.defaults.autostart" type="checkbox">
                <span class="field__label">autostart with <code>up</code></span>
              </label>
              <label class="field">
                <span class="field__label">bind</span>
                <select v-model="form.defaults.bind">
                  <option value="local">local (127.0.0.1)</option>
                  <option value="lan">lan (0.0.0.0)</option>
                </select>
              </label>
              <label class="field">
                <span class="field__label">on port conflict</span>
                <select v-model="form.defaults.onPortConflict">
                  <option value="block">block</option>
                  <option value="warn">warn</option>
                  <option value="follow">follow</option>
                  <option value="reclaim">reclaim</option>
                  <option value="kill">kill</option>
                </select>
              </label>
              <label class="field">
                <span class="field__label">log buffer lines</span>
                <input v-model.number="form.defaults.logBufferLines" inputmode="numeric">
              </label>
            </div>
          </div>

          <LifecycleFields
            v-model:restart="form.defaults.restart"
            v-model:health="form.defaults.health"
            v-model:stop="form.defaults.stop"
          />
        </div>
      </section>

      <section class="pane">
        <div class="pane__head">
          <span class="pane__title">logs</span>
          <span class="view__spacer" />
          <RouterLink class="mono faint" to="/logs">
            open logs
          </RouterLink>
        </div>
        <div class="pane__body">
          <div class="group">
            <div class="grid">
              <label class="field field--check">
                <input v-model="form.logs.persist" type="checkbox">
                <span class="field__label">keep logs on disk</span>
              </label>
              <label class="field">
                <span class="field__label">rotate at (bytes)</span>
                <input v-model.number="form.logs.maxBytes" inputmode="numeric">
              </label>
              <label class="field">
                <span class="field__label">keep rotated files</span>
                <input v-model.number="form.logs.keep" inputmode="numeric">
              </label>
              <label class="field">
                <span class="field__label">directory</span>
                <input :value="state?.logsDir ?? '—'" disabled>
              </label>
            </div>
            <p class="note">
              The live view always comes from memory; persisted files feed the
              <RouterLink to="/logs">
                Logs
              </RouterLink> page and survive a restart.
            </p>
          </div>
        </div>
      </section>

      <section class="pane">
        <div class="pane__head">
          <span class="pane__title">host vitals thresholds</span>
          <span class="view__spacer" />
          <span v-if="state?.host.alerts.length" class="chip chip--danger">{{ state?.host.alerts.length }} alert(s)</span>
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
              <template v-if="state?.host.alerts.length">
                <br>Now: <span class="warn">{{ state?.host.alerts.join(' · ') }}</span>
              </template>
            </p>
          </div>
        </div>
      </section>

      <section class="pane">
        <div class="pane__head">
          <span class="pane__title">telegram notifications</span>
          <span class="view__spacer" />
          <span v-if="telegram?.tokenSet" class="chip chip--ok">token set</span>
          <span v-else class="chip chip--warn">no token</span>
        </div>
        <div class="pane__body">
          <div class="group">
            <div class="grid">
              <label class="field field--check">
                <input v-model="form.notifications.telegram.enabled" type="checkbox">
                <span class="field__label">send notifications</span>
              </label>
              <label class="field">
                <span class="field__label">chat id</span>
                <input v-model="form.notifications.telegram.chatId" placeholder="123456789 or @channel">
              </label>
              <label class="field">
                <span class="field__label">cooldown per event (ms)</span>
                <input v-model.number="form.notifications.telegram.cooldownMs" inputmode="numeric">
              </label>
            </div>
            <div class="grid">
              <label class="field field--check">
                <input v-model="form.notifications.telegram.onCrash" type="checkbox">
                <span class="field__label">retries exhausted</span>
              </label>
              <label class="field field--check">
                <input v-model="form.notifications.telegram.onUnhealthy" type="checkbox">
                <span class="field__label">port unhealthy</span>
              </label>
              <label class="field field--check">
                <input v-model="form.notifications.telegram.onForcedRestart" type="checkbox">
                <span class="field__label">forced restart</span>
              </label>
              <label class="field field--check">
                <input v-model="form.notifications.telegram.onRecovered" type="checkbox">
                <span class="field__label">recovered</span>
              </label>
              <label class="field field--check">
                <input v-model="form.notifications.telegram.onHost" type="checkbox">
                <span class="field__label">host thresholds</span>
              </label>
            </div>
            <p class="note">
              Policy above lives in <code>servers.config.json</code>; the bot token is a
              secret and is stored in the git-ignored secrets file instead.
              <template v-if="telegram?.lastResult">
                Last send: {{ telegram?.lastResult }}.
              </template>
            </p>

            <label class="field">
              <span class="field__label">bot token (from @BotFather)</span>
              <input
                v-model="tokenInput"
                type="password"
                autocomplete="off"
                :placeholder="telegram?.tokenSet ? '•••••• (saved) — type to replace' : '123456:ABC-DEF...'"
              >
            </label>

            <div class="actions actions--start">
              <button type="button" class="btn btn--sm btn--ghost" :disabled="notifyBusy" @click="detectChats">
                Detect chats
              </button>
              <ConfirmButton
                v-if="telegram?.tokenSet"
                label="Remove token"
                confirm-label="Confirm remove"
                tone="danger"
                :disabled="notifyBusy"
                @confirm="removeToken"
              />
              <button type="button" class="btn btn--sm" :disabled="notifyBusy || tokenInput.trim().length === 0" @click="saveToken">
                Save token
              </button>
              <button type="button" class="btn btn--sm btn--primary" :disabled="notifyBusy" @click="sendTest">
                Send test
              </button>
            </div>

            <div v-if="detectedChats.length > 0" class="row">
              <span class="faint">found:</span>
              <button
                v-for="chat in detectedChats"
                :key="String(chat.id)"
                type="button"
                class="btn btn--xs"
                @click="form.notifications.telegram.chatId = String(chat.id)"
              >
                {{ chat.title }} ({{ chat.id }})
              </button>
            </div>
            <p v-if="tokenError" class="note note--error">
              {{ tokenError }}
            </p>
            <p v-if="tokenMessage" class="note note--ok">
              {{ tokenMessage }}
            </p>
          </div>
        </div>
      </section>

      <section class="pane">
        <div class="pane__head">
          <span class="pane__title">backups</span>
          <span class="view__spacer" />
          <span class="mono faint">{{ backupsView?.dir ?? state?.backups.dir ?? '—' }}</span>
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
              Config, secrets and TLS are always included. Data paths come from each entry's
              <code>dataEnvs</code> (see the server editor) and <code>backupPaths</code>;
              a path already covered by a declared parent is skipped.
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
              <span class="group__note">the password encrypts this archive only; restoring asks for it</span>
            </div>
            <div class="grid grid--wide">
              <label class="field">
                <span class="field__label">password (optional)</span>
                <input v-model="backupPassword" type="password" autocomplete="new-password">
              </label>
            </div>
            <div class="actions actions--start">
              <button type="button" class="btn btn--sm btn--primary" :disabled="backupBusy" @click="runBackup">
                Create backup now
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
                        <button type="button" class="btn btn--xs" :disabled="backupBusy" @click="planRestore(file.name)">
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
              <span class="group__note">a dry run lists what the archive holds before anything is written</span>
            </div>
            <div class="grid grid--wide">
              <label class="field">
                <span class="field__label">upload an archive (.zip)</span>
                <input type="file" accept=".zip,application/zip" @change="pickRestoreFile">
              </label>
            </div>
            <div class="actions actions--start">
              <button type="button" class="btn btn--sm" :disabled="backupBusy || restoreFile === null" @click="planRestore()">
                Check upload
              </button>
            </div>

            <div v-if="restorePlan" class="stack">
              <p class="note note--warn">
                <strong>{{ restorePlan.dryRun ? 'Nothing changed yet.' : 'Applied.' }}</strong>
                <template v-if="restoreTarget?.kind === 'stored'">
                  Archive {{ restoreTarget.name }}.
                </template>
              </p>

              <template v-if="restorePlan.needsPassword">
                <p class="note note--error">
                  {{ restorePlan.error ?? 'This backup is password-protected.' }}
                </p>
                <label class="field">
                  <span class="field__label">password</span>
                  <input v-model="restorePassword" type="password" autocomplete="off">
                </label>
                <div class="actions actions--start">
                  <button type="button" class="btn btn--sm" :disabled="backupBusy" @click="replanRestore()">
                    Check again with the password
                  </button>
                </div>
              </template>

              <template v-else>
                <p class="note">
                  Choose what to restore — {{ selectedCount }} of {{ restorePlan.items.length }} selected.
                </p>
                <div class="stack">
                  <label
                    v-for="item in restorePlan.items"
                    :key="item.id"
                    class="field field--check"
                    :class="{ faint: !item.restorable }"
                  >
                    <input v-model="item.selected" type="checkbox" :disabled="!item.restorable">
                    <span class="field__label">
                      {{ item.label }}
                      <span class="faint">· {{ item.kind }}</span>
                      <em v-if="item.note" class="dim">— {{ item.note }}</em>
                    </span>
                  </label>
                </div>
                <div class="actions actions--start">
                  <button type="button" class="btn btn--sm btn--ghost" :disabled="backupBusy" @click="selectAllRestorable(true)">
                    Select all
                  </button>
                  <button type="button" class="btn btn--sm btn--ghost" :disabled="backupBusy" @click="selectAllRestorable(false)">
                    Select none
                  </button>
                </div>

                <p class="note">
                  Will restore: {{ restorePlan.applied.join(', ') || 'nothing' }}.
                  <template v-if="restorePlan.skipped.length">
                    Skipped: {{ restorePlan.skipped.join(', ') }}.
                  </template>
                  <template v-if="restorePlan.restartRequired">
                    The panel settings differ, so restart home-hosted afterwards.
                  </template>
                  <template v-else-if="restoringConfig">
                    The restored servers are reloaded immediately; entries marked autostart start on their own.
                  </template>
                </p>
                <div class="actions actions--start">
                  <button
                    type="button"
                    class="btn btn--sm btn--danger"
                    :disabled="backupBusy || selectedCount === 0"
                    @click="applyRestore()"
                  >
                    {{ restoreTarget?.kind === 'stored' ? 'Apply this restore' : 'Restore the upload' }}
                  </button>
                </div>
              </template>
            </div>

            <p v-if="backupError" class="note note--error">
              {{ backupError }}
            </p>
            <p v-if="backupMessage" class="note note--ok">
              {{ backupMessage }}
            </p>
          </div>
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
              <div v-for="entry in paths" :key="entry.label" class="row">
                <span class="faint paths__key">{{ entry.label }}</span>
                <code class="truncate" :title="entry.value">{{ entry.value }}</code>
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
          <span class="faint">{{ changedCount }} field(s) → servers.config.json</span>
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
</template>

<style scoped>
.paths__key {
  min-width: 6.5rem;
}
.settings-note {
  margin: 0.5rem 0.75rem;
}
</style>
