<script setup lang="ts">
import type { DdnsConfig, DestinationStatusView, LogsConfig, ServerDefaults, WorkspaceSettingsPatch } from '@shared/contracts'
import type { Patch } from '@shared/patch-diff'
import type { DraftConfig } from '@/lib/ddns'
import { errorMessage } from '@shared/error-message'
import { countLeaves, describeChanges, diffFields } from '@shared/patch-diff'
import { computed, onMounted, reactive, ref, watch } from 'vue'
import ConfirmButton from '@/components/ConfirmButton.vue'
import DdnsPanel from '@/components/DdnsPanel.vue'
import LifecycleFields from '@/components/LifecycleFields.vue'
import { useControlPlane } from '@/composables/useControlPlane'
import { changesOpen } from '@/composables/useUi'
import { useWorkspaces } from '@/composables/useWorkspaces'
import * as api from '@/lib/api'
import { repairNumbers } from '@/lib/forms'

/**
 * The selected workspace's own groups: server defaults, log retention,
 * notifications and dynamic DNS. Listener, auth, TLS, host vitals and backups
 * are panel-wide and live on the global settings page.
 */
const control = useControlPlane()
const workspace = useWorkspaces()

/** The general block as this page edits it. */
interface PolicyDraft {
  onCrash: boolean
  onUnhealthy: boolean
  onForcedRestart: boolean
  onRecovered: boolean
  onHost: boolean
  onDdns: boolean
  cooldownMs: number
}
/** One destination as the config carries it: the status row minus its derived fields. */
type DestinationDraft = Omit<DestinationStatusView, 'lastResult' | 'lastResultAt'>

const activeId = computed(() => workspace.activeId.value)
const selected = computed(() => workspace.selected.value)
const defaultsView = computed<ServerDefaults | null>(() => workspace.defaults.value)

const settingsMessage = ref<string | null>(null)
const settingsError = ref<string | null>(null)
const saving = ref(false)
/** What the DDNS panel would change, and the block it started from. */
const ddnsPatch = ref<DdnsConfig | null>(null)
const ddnsBaseline = ref<DraftConfig | null>(null)
const ddnsSection = ref<{ reload: () => Promise<void> } | null>(null)

const form = reactive({
  logs: {
    persist: true,
    maxBytes: 2000000,
    keep: 3,
  },
  notifications: {
    /** The general block: what a destination inherits unless it opts out. */
    policy: {
      onCrash: true,
      onUnhealthy: true,
      onForcedRestart: true,
      onRecovered: false,
      onHost: true,
      onDdns: true,
      cooldownMs: 120000,
    } as PolicyDraft,
    /** One list, whatever the kind, because a panel alerts more than one place. */
    destinations: [] as DestinationDraft[],
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
      http: { scheme: 'http' as 'http' | 'https', allowInvalidCert: false, path: '/', method: 'GET' as 'GET' | 'HEAD', expectStatus: undefined as number | null | undefined, expectStatusBelow: 400, expectBody: '' },
      intervalMs: 5000,
      timeoutMs: 1500,
      unhealthyThreshold: 3,
      forceRestartAfterMs: 0,
      startTimeoutMs: 20000,
    },
    stop: { signal: 'SIGTERM' as ServerDefaults['stop']['signal'], killGroup: true, graceMs: 5000, killPortHolders: false },
  },
})

/** The general block as the form holds it. */
function policyConfig(status: Omit<PolicyDraft, 'onDdns'> & { onDdns?: boolean }): PolicyDraft {
  return {
    onCrash: status.onCrash,
    onUnhealthy: status.onUnhealthy,
    onForcedRestart: status.onForcedRestart,
    onRecovered: status.onRecovered,
    onHost: status.onHost,
    // A panel from before DDNS sends no flag; absent means "on".
    onDdns: status.onDdns !== false,
    cooldownMs: status.cooldownMs,
  }
}

/**
 * One destination in the shape the API *stores* — the only shape a diff may compare.
 *
 * `tokenSet` is derived and never written, so it must not appear on either side of the diff; the
 * policy columns are written only for a destination that carries its own. Comparing the form's
 * richer shape against the wire shape made every untouched row look edited, so the change dialog
 * always claimed an edit and a save rewrote the list in its reduced form.
 */
function destinationWire(entry: DestinationDraft): Record<string, unknown> {
  return {
    kind: entry.kind,
    id: entry.id,
    enabled: entry.enabled,
    useOwnSettings: entry.useOwnSettings,
    ...(entry.kind === 'telegram' ? { chatId: entry.chatId } : { url: entry.url, method: entry.method, format: entry.format, headers: entry.headers }),
    ...(entry.useOwnSettings
      ? { onCrash: entry.onCrash, onUnhealthy: entry.onUnhealthy, onForcedRestart: entry.onForcedRestart, onRecovered: entry.onRecovered, onHost: entry.onHost, onDdns: entry.onDdns, cooldownMs: entry.cooldownMs }
      : {}),
  }
}

/**
 * One destination as the form holds it. The row carries its *effective* policy, which is what a
 * read-only view should show for an inheriting destination.
 */
function destinationConfig(row: DestinationStatusView): DestinationDraft {
  return {
    id: row.id,
    kind: row.kind,
    enabled: row.enabled,
    useOwnSettings: row.useOwnSettings,
    chatId: row.chatId ?? '',
    tokenSet: row.tokenSet,
    url: row.url ?? '',
    method: row.method ?? 'POST',
    format: row.format ?? 'json',
    headers: row.headers ?? '',
    ...policyConfig(row),
  }
}

/** The per-event toggles, as one list the template renders for every target. */
const POLICY_TOGGLES = [
  { key: 'onCrash', label: 'crashed' },
  { key: 'onUnhealthy', label: 'unhealthy' },
  { key: 'onForcedRestart', label: 'force restarted' },
  { key: 'onRecovered', label: 'recovered' },
  { key: 'onHost', label: 'host vitals' },
  { key: 'onDdns', label: 'dynamic DNS' },
] as const

/** A row's own message (test result, token saved), by destination id. */
const hookResults = ref<Record<string, string>>({})
const hookError = ref<string | null>(null)

function uniqueId(kind: DestinationDraft['kind']): string {
  const existing = new Set(form.notifications.destinations.map(entry => entry.id))
  if (!existing.has(kind))
    return kind
  let suffix = 2
  while (existing.has(`${kind}-${suffix}`))
    suffix += 1
  return `${kind}-${suffix}`
}

function addDestination(kind: DestinationDraft['kind']): void {
  form.notifications.destinations = [...form.notifications.destinations, {
    id: uniqueId(kind),
    kind,
    enabled: true,
    // A destination created here opts into inheritance: that is what the general block is for.
    useOwnSettings: false,
    chatId: '',
    tokenSet: false,
    url: '',
    method: 'POST',
    format: 'json',
    headers: '',
    policy: undefined as never,
    ...form.notifications.policy,
  } as DestinationDraft]
}

function removeDestination(id: string): void {
  form.notifications.destinations = form.notifications.destinations.filter(entry => entry.id !== id)
}

/** Tests the destination as the form holds it, so an unsaved URL and header block are what is tried. */
async function testDestination(entry: DestinationDraft): Promise<void> {
  hookError.value = null
  try {
    if (entry.kind === 'telegram')
      await api.sendTelegramTest(entry.id, { chatId: entry.chatId || undefined }, activeId.value)
    else
      await api.testWebhook(activeId.value, { target: { url: entry.url, method: entry.method, format: entry.format, headers: entry.headers, enabled: entry.enabled, cooldownMs: entry.cooldownMs, onCrash: entry.onCrash, onUnhealthy: entry.onUnhealthy, onForcedRestart: entry.onForcedRestart, onRecovered: entry.onRecovered, onHost: entry.onHost, onDdns: entry.onDdns }, id: entry.id })
    hookResults.value[entry.id] = 'test sent'
  }
  catch (caught) {
    hookResults.value[entry.id] = ''
    hookError.value = errorMessage(caught)
  }
}

type FormBlock = 'defaults' | 'logs' | 'notifications'

/** A copy of the health group, nested `http` included. */
function cloneHealth(health: ServerDefaults['health']): ServerDefaults['health'] {
  return { ...health, http: { ...health.http } }
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
  const logs: LogsConfig | undefined = selected.value?.logs
  if (!logs)
    return false
  Object.assign(form.logs, logs)
  return true
}

function fillNotifications(): boolean {
  const configured = selected.value?.notifications
  if (!configured?.defaults)
    return false
  Object.assign(form.notifications.policy, policyConfig(configured.defaults))
  form.notifications.destinations = (configured.destinations ?? []).map(destinationConfig)
  return true
}

const FILLERS: Record<FormBlock, () => boolean> = {
  defaults: fillDefaults,
  logs: fillLogs,
  notifications: fillNotifications,
}

/** What each block held when it was last filled; absent means "never filled". */
const snapshots: Partial<Record<FormBlock, unknown>> = {}

function blockSnapshot(block: FormBlock): unknown {
  switch (block) {
    case 'defaults': return {
      ...form.defaults,
      restart: { ...form.defaults.restart },
      health: cloneHealth(form.defaults.health),
      stop: { ...form.defaults.stop },
    }
    case 'logs': return { ...form.logs }
    // The block holds the Telegram policy **and** the webhook list; both, or a state frame
    // re-fills the list over an edit (the stock UI had the same defect).
    // The block owns the general policy *and* the list: both, or a state frame re-fills an edit.
    case 'notifications': return {
      policy: { ...form.notifications.policy },
      destinations: form.notifications.destinations.map(entry => ({ ...entry })),
    }
  }
}

/**
 * True when a block was filled from live state and edited since, so the next
 * frame must leave it alone. A block that was never filled is always free.
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

function syncFromLive(): void {
  for (const block of Object.keys(FILLERS) as FormBlock[]) {
    if (isBlockEdited(block))
      continue
    if (FILLERS[block]())
      remember(block)
  }
}

function applySettings(): void {
  for (const block of Object.keys(FILLERS) as FormBlock[]) {
    if (FILLERS[block]())
      remember(block)
  }
}

onMounted(applySettings)

watch([defaultsView, selected], () => {
  syncFromLive()
}, { immediate: true })

// Switching workspace swaps every source under the form, so nothing may look edited.
watch(activeId, () => {
  forgetSnapshots()
  applySettings()
})

/** The workspace-scoped patch: server defaults, log retention, notifications, DDNS. */
function buildWorkspacePatch(defaults: ServerDefaults): WorkspaceSettingsPatch {
  const patch: WorkspaceSettingsPatch = {}

  /**
   * An emptied number box reports `''`, which the patch schema rejects for the whole body.
   * Put the live value back first, so the field drops out of the diff instead of failing it.
   */
  repairNumbers(form.defaults as unknown as Record<string, unknown>, defaults as unknown as Record<string, unknown>)
  const live = selected.value
  if (live !== null) {
    repairNumbers(form.logs as unknown as Record<string, unknown>, live.logs as unknown as Record<string, unknown>)
    repairNumbers(
      form.notifications.policy as unknown as Record<string, unknown>,
      (live.notifications.defaults ?? form.notifications.policy) as unknown as Record<string, unknown>,
    )
  }

  const defaultsPatch = diffFields(
    defaults as unknown as Patch,
    { ...form.defaults } as unknown as Patch,
    ['restart', 'health', 'stop'],
  )
  if (Object.keys(defaultsPatch).length > 0)
    patch.defaults = defaultsPatch as WorkspaceSettingsPatch['defaults']

  const configured = selected.value
  if (configured) {
    const logsPatch = diffFields(configured.logs as unknown as Patch, { ...form.logs } as unknown as Patch)
    if (Object.keys(logsPatch).length > 0)
      patch.logs = logsPatch as WorkspaceSettingsPatch['logs']

    // The general block merges; the list is **replaced** — a merge cannot express removing one.
    // An inheriting destination sends no policy columns: they would be ignored anyway, and writing
    // them would make the config say something the page does not mean.
    const notificationsPatch = diffFields(
      {
        defaults: policyConfig(configured.notifications.defaults ?? form.notifications.policy),
        // Through the form mapper first, so both sides of the diff are the same type.
        destinations: (configured.notifications.destinations ?? []).map(destinationConfig).map(destinationWire),
      } as unknown as Patch,
      {
        defaults: { ...form.notifications.policy },
        destinations: form.notifications.destinations.map(destinationWire),
      } as unknown as Patch,
      ['defaults'],
    )
    if (Object.keys(notificationsPatch).length > 0)
      patch.notifications = notificationsPatch as WorkspaceSettingsPatch['notifications']
  }

  return patch
}

const pendingPatch = computed(() => {
  const defaults = defaultsView.value
  if (!defaults || activeId.value.length === 0)
    return null
  return buildWorkspacePatch(defaults)
})

const changedCount = computed(() => (pendingPatch.value === null ? 0 : countLeaves(pendingPatch.value as Patch)))

/** What every patched field is compared against, keyed the way the patch is. */
const currentSnapshot = computed<Patch>(() => {
  const configured = selected.value
  return {
    defaults: defaultsView.value ?? {},
    logs: configured?.logs ?? {},
    notifications: configured === null
      ? {}
      : { defaults: configured.notifications.defaults ?? {}, destinations: (configured.notifications.destinations ?? []).map(destinationConfig) },
    ddns: ddnsBaseline.value ?? {},
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
    const defaults = defaultsView.value
    if (!defaults || activeId.value.length === 0) {
      settingsError.value = 'the settings are still loading'
      return
    }

    const patch = buildWorkspacePatch(defaults)
    if (Object.keys(patch).length === 0 && ddnsPatch.value === null) {
      settingsMessage.value = 'nothing changed'
      return
    }

    if (Object.keys(patch).length > 0 && !(await workspace.saveSettings(patch))) {
      settingsError.value = control.lastError.value ?? 'the workspace settings could not be saved'
      return
    }

    // DDNS has its own route (`PUT /api/ddns`); the panel owns its draft.
    if (ddnsPatch.value !== null)
      await api.saveDdns(ddnsPatch.value, activeId.value)

    // What was saved is what live state holds now, so every block may follow it
    // again — including the ones this save just brought back in sync.
    forgetSnapshots()
    applySettings()
    await ddnsSection.value?.reload()
    settingsMessage.value = 'saved'
  }
  catch (caught) {
    settingsError.value = errorMessage(caught)
  }
  finally {
    saving.value = false
  }
}

/**
 * The Telegram destination the token controls act on.
 *
 * The page shows one token box (a secret is typed rarely), so it points at the first Telegram
 * destination. Adding a second chat is the case the old singleton could not express at all; each
 * one's token is saved under its own id, so this pick is a UI convenience, never a limit.
 */
const tokenTarget = computed<DestinationDraft | null>(() =>
  form.notifications.destinations.find(entry => entry.kind === 'telegram') ?? null)

const tokenInput = ref('')
const tokenMessage = ref<string | null>(null)
const tokenError = ref<string | null>(null)
const detectedChats = ref<Array<{ id: number | string, title: string }>>([])
const notifyBusy = ref(false)

async function saveToken(): Promise<void> {
  tokenError.value = null
  tokenMessage.value = null
  try {
    if (tokenTarget.value === null)
      return
    const result = await api.saveTelegramToken(tokenTarget.value.id, tokenInput.value.trim(), activeId.value)
    tokenInput.value = ''
    tokenMessage.value = `token saved${result.username ? ` (bot @${result.username})` : ''}`
    await control.refresh()
  }
  catch (caught) {
    tokenError.value = errorMessage(caught)
  }
}

async function removeToken(): Promise<void> {
  tokenError.value = null
  tokenMessage.value = null
  try {
    if (tokenTarget.value === null)
      return
    await api.clearTelegramToken(tokenTarget.value.id, activeId.value)
    tokenMessage.value = 'token removed'
    await control.refresh()
  }
  catch (caught) {
    tokenError.value = errorMessage(caught)
  }
}

async function detectChats(): Promise<void> {
  notifyBusy.value = true
  tokenError.value = null
  try {
    if (tokenTarget.value === null)
      return
    const override = tokenInput.value.trim()
    const result = await api.detectTelegramChats(tokenTarget.value.id, override.length > 0 ? { botToken: override } : {}, activeId.value)
    detectedChats.value = result.chats
    if (result.chats.length === 0)
      tokenError.value = 'no chats found — send /start to the bot first, then detect again'
  }
  catch (caught) {
    tokenError.value = errorMessage(caught)
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
    if (tokenTarget.value === null)
      return
    const result = await api.sendTelegramTest(tokenTarget.value.id, {
      chatId: (tokenTarget.value.chatId ?? '').length > 0 ? tokenTarget.value.chatId ?? undefined : undefined,
    }, activeId.value)
    if (result.ok)
      tokenMessage.value = 'test message sent'
    else tokenError.value = result.error ?? 'the test message failed'
    await control.refresh()
  }
  catch (caught) {
    tokenError.value = errorMessage(caught)
  }
  finally {
    notifyBusy.value = false
  }
}
</script>

<template>
  <div class="view">
    <header class="view__head">
      <span class="view__title">workspace settings</span>
      <span class="view__count">{{ selected?.label ?? '—' }} · <span class="mono">{{ activeId || '—' }}</span></span>
      <span v-if="workspace.configError.value" class="chip chip--danger">config problem</span>
      <span v-if="selected?.configWarnings?.length" class="chip chip--warn">{{ selected.configWarnings.length }} warning(s)</span>
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
      <p v-if="workspace.configError.value" class="banner banner--warn">
        <strong>config problem</strong>
        <span>{{ workspace.configError.value }}</span>
        <code>{{ workspace.configPath.value }}</code>
        <span class="faint">running the last good config; fixing the file reloads it</span>
      </p>

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
          <RouterLink class="mono faint" :to="`/w/${activeId}/logs`">
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
                <input :value="workspace.logsDir.value ?? '—'" disabled>
              </label>
            </div>
            <p class="note">
              The live view always comes from memory; persisted files feed the
              <RouterLink :to="`/w/${activeId}/logs`">
                Logs
              </RouterLink> page and survive a restart.
            </p>
          </div>
        </div>
      </section>

      <section id="notifications" class="pane">
        <div class="pane__head">
          <span class="pane__title">notifications</span>
          <span class="view__spacer" />
          <span class="faint">{{ form.notifications.destinations.length }} destination(s)</span>
        </div>
        <div class="pane__body">
          <!--
            The general block: the toggles and throttle, set once. A destination that does not carry
            its own settings follows this, which is what stops the same policy being repeated per
            transport and again per chat.
          -->
          <div class="group">
            <div class="group__title">
              general
            </div>
            <p class="note">
              What every destination follows unless it sets its own.
            </p>
            <div class="grid">
              <label v-for="toggle in POLICY_TOGGLES" :key="toggle.key" class="field field--check">
                <input v-model="form.notifications.policy[toggle.key]" type="checkbox">
                <span class="field__label">{{ toggle.label }}</span>
              </label>
              <label class="field">
                <span class="field__label">cooldown (ms)</span>
                <input v-model.number="form.notifications.policy.cooldownMs" inputmode="numeric">
                <span class="field__hint">per destination, server and reason</span>
              </label>
            </div>
          </div>

          <div class="group">
            <div class="group__title">
              destinations
            </div>
            <p class="note">
              Where events go. A Telegram chat or a webhook — the same list, because both are just
              somewhere an alert lands. A bot token is a secret, stored per destination.
            </p>

            <div v-for="entry in form.notifications.destinations" :key="entry.id" class="hook">
              <div class="grid">
                <label class="field field--check">
                  <input v-model="entry.enabled" type="checkbox">
                  <span class="field__label">{{ entry.kind }} · {{ entry.id }}</span>
                </label>

                <template v-if="entry.kind === 'telegram'">
                  <label class="field">
                    <span class="field__label">chat id</span>
                    <input v-model="entry.chatId" placeholder="123456789 or @channel">
                  </label>
                </template>
                <template v-else>
                  <label class="field grid__full">
                    <span class="field__label">url</span>
                    <input v-model="entry.url" placeholder="https://ntfy.sh/my-topic">
                  </label>
                  <label class="field">
                    <span class="field__label">method</span>
                    <select v-model="entry.method">
                      <option value="POST">POST</option>
                      <option value="PUT">PUT</option>
                    </select>
                  </label>
                  <label class="field">
                    <span class="field__label">body</span>
                    <select v-model="entry.format">
                      <option value="json">JSON</option>
                      <option value="text">plain text</option>
                    </select>
                  </label>
                  <label class="field grid__full">
                    <span class="field__label">headers (Name: value per line)</span>
                    <textarea v-model="entry.headers" rows="2" placeholder="Authorization: Bearer …" />
                  </label>
                </template>

                <label class="field field--check grid__full">
                  <input v-model="entry.useOwnSettings" type="checkbox">
                  <span class="field__label">own settings</span>
                  <span class="field__hint">off follows the general block above</span>
                </label>
                <template v-if="entry.useOwnSettings">
                  <label v-for="toggle in POLICY_TOGGLES" :key="toggle.key" class="field field--check">
                    <input v-model="entry[toggle.key]" type="checkbox">
                    <span class="field__label">{{ toggle.label }}</span>
                  </label>
                  <label class="field">
                    <span class="field__label">cooldown (ms)</span>
                    <input v-model.number="entry.cooldownMs" inputmode="numeric">
                  </label>
                </template>
              </div>

              <div class="hook__actions">
                <button class="btn btn--ghost" type="button" @click="testDestination(entry)">
                  send a test
                </button>
                <span v-if="hookResults[entry.id]" class="faint">{{ hookResults[entry.id] }}</span>
                <span class="view__spacer" />
                <!-- One click away and destructive, so it confirms in a popover. -->
                <ConfirmButton
                  label="remove"
                  tone="danger"
                  :title="`Remove ${entry.id}?`"
                  :hint="entry.kind === 'telegram' ? 'Its alerts stop, and any stored bot token for it is removed.' : 'Its alerts stop being sent.'"
                  @confirm="removeDestination(entry.id)"
                />
              </div>
            </div>

            <div class="row">
              <button class="btn btn--ghost" type="button" @click="addDestination('telegram')">
                add telegram
              </button>
              <button class="btn btn--ghost" type="button" @click="addDestination('webhook')">
                add webhook
              </button>
            </div>

            <!-- The token belongs to one Telegram destination; this box edits the first one. -->
            <template v-if="tokenTarget !== null">
              <div class="grid">
                <label class="field grid__full">
                  <span class="field__label">bot token — {{ tokenTarget.id }}</span>
                  <input v-model="tokenInput" :placeholder="tokenTarget.tokenSet ? '•••••• (saved) — type to replace' : '123456:ABC-DEF...'">
                </label>
              </div>
              <div class="row">
                <button class="btn btn--ghost" type="button" :disabled="tokenInput.trim().length === 0" @click="saveToken">
                  save token
                </button>
                <button class="btn btn--ghost" type="button" @click="detectChats">
                  detect chats
                </button>
                <button class="btn btn--ghost" type="button" @click="sendTest">
                  send test
                </button>
                <ConfirmButton
                  v-if="tokenTarget.tokenSet"
                  label="remove token"
                  tone="danger"
                  title="Remove the bot token?"
                  hint="This destination stops sending until a token is saved again."
                  @confirm="removeToken"
                />
              </div>
              <p v-if="detectedChats.length > 0" class="note">
                <button
                  v-for="chat in detectedChats"
                  :key="String(chat.id)"
                  class="btn btn--ghost"
                  type="button"
                  @click="tokenTarget.chatId = String(chat.id)"
                >
                  {{ chat.title }}
                </button>
              </p>
              <p v-if="tokenMessage" class="note note--ok">
                {{ tokenMessage }}
              </p>
              <p v-if="tokenError" class="note note--error">
                {{ tokenError }}
              </p>
            </template>

            <p v-if="hookError" class="note note--error">
              {{ hookError }}
            </p>
          </div>
        </div>
      </section>

      <section id="ddns" class="pane">
        <div class="pane__head">
          <span class="pane__title">dynamic dns</span>
          <span class="view__spacer" />
          <span class="faint">provider tokens stay in the secrets file</span>
        </div>
        <div class="pane__body">
          <DdnsPanel
            ref="ddnsSection"
            :key="activeId"
            v-model:patch="ddnsPatch"
            v-model:baseline="ddnsBaseline"
          />
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
          <span class="faint">{{ changedCount }} field(s) → workspace settings</span>
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
.settings-note {
  margin: 0.5rem 0.75rem;
}
</style>
