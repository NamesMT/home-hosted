<script setup lang="ts">
import type { DdnsConfig, LogsConfig, ServerDefaults, TelegramStatus, WorkspaceSettingsPatch } from '@shared/contracts'
import type { Patch } from '@shared/patch-diff'
import type { DraftConfig } from '@/lib/ddns'
import { countLeaves, describeChanges, diffFields } from '@shared/patch-diff'
import { computed, onMounted, reactive, ref, watch } from 'vue'
import ConfirmButton from '@/components/ConfirmButton.vue'
import DdnsPanel from '@/components/DdnsPanel.vue'
import LifecycleFields from '@/components/LifecycleFields.vue'
import { useControlPlane } from '@/composables/useControlPlane'
import { changesOpen } from '@/composables/useUi'
import { useWorkspaces } from '@/composables/useWorkspaces'
import * as api from '@/lib/api'

/**
 * The selected workspace's own groups: server defaults, log retention,
 * notifications and dynamic DNS. Listener, auth, TLS, host vitals and backups
 * are panel-wide and live on the global settings page.
 */
const control = useControlPlane()
const workspace = useWorkspaces()

/** The config schema carries `onHost`; the derived SSE view type has not caught up. */
type TelegramPolicy = TelegramStatus & { onHost?: boolean }

const activeId = computed(() => workspace.activeId.value)
const selected = computed(() => workspace.selected.value)
const defaultsView = computed<ServerDefaults | null>(() => workspace.defaults.value)
const telegram = computed<TelegramPolicy | null>(() => selected.value?.notifications.telegram ?? null)

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
    telegram: {
      enabled: false,
      chatId: '',
      onCrash: true,
      onUnhealthy: true,
      onForcedRestart: true,
      onRecovered: false,
      onHost: true,
      onDdns: true,
      cooldownMs: 120000,
    },
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
    // A panel from before DDNS sends no flag; absent means "on".
    onDdns: status.onDdns !== false,
    cooldownMs: status.cooldownMs,
  }
}

type FormBlock = 'defaults' | 'logs' | 'telegram'

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

function fillTelegram(): boolean {
  const status = selected.value?.notifications.telegram
  if (!status)
    return false
  Object.assign(form.notifications.telegram, telegramConfig(status))
  return true
}

const FILLERS: Record<FormBlock, () => boolean> = {
  defaults: fillDefaults,
  logs: fillLogs,
  telegram: fillTelegram,
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
    case 'telegram': return { ...form.notifications.telegram }
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

    const notificationsPatch = diffFields(
      configured.notifications as unknown as Patch,
      { telegram: { ...form.notifications.telegram } } as unknown as Patch,
      ['telegram'],
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
    notifications: configured === null ? {} : { telegram: configured.notifications.telegram },
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
    settingsError.value = caught instanceof Error ? caught.message : String(caught)
  }
  finally {
    saving.value = false
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
    const result = await api.saveTelegramToken(tokenInput.value.trim(), activeId.value)
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
    await api.clearTelegramToken(activeId.value)
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
    const result = await api.detectTelegramChats(override.length > 0 ? { botToken: override } : {}, activeId.value)
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
    }, activeId.value)
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
              <label class="field field--check">
                <input v-model="form.notifications.telegram.onDdns" type="checkbox">
                <span class="field__label">dynamic DNS changes and failures</span>
              </label>
            </div>
            <p class="note">
              Policy above lives in this workspace's <code>settings.json</code>; the bot token is a
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
