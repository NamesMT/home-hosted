<script setup lang="ts">
import type { SettingsPatch } from '@shared/contracts'
import type { SettingsForm } from '@/components/settings/settingsForm'
import type { SettingsView } from '@/lib/api'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AuthenticationSection from '@/components/settings/AuthenticationSection.vue'
import BackupsSection from '@/components/settings/BackupsSection.vue'
import DefaultsSection from '@/components/settings/DefaultsSection.vue'
import HostSection from '@/components/settings/HostSection.vue'
import InterfaceSection from '@/components/settings/InterfaceSection.vue'
import ListenerSection from '@/components/settings/ListenerSection.vue'
import LogsSection from '@/components/settings/LogsSection.vue'
import Notice from '@/components/settings/Notice.vue'
import NotificationsSection from '@/components/settings/NotificationsSection.vue'
import PathsSection from '@/components/settings/PathsSection.vue'
import {
  authBaseline,
  authChanged,
  backupsBaseline,
  backupsPatch,
  cloneHealth,
  controlPatch,
  countLeaves,
  createSettingsForm,
  defaultsPatch,
  describeChanges,
  followRebinding,
  hostBaseline,
  hostPatch,
  listenerBaseline,
  listenerChanged,
  logsPatch,
  shouldHydrate,
  telegramBaseline,
  telegramPatch,
  tlsChanged,
} from '@/components/settings/settingsForm'
import TlsSection from '@/components/settings/TlsSection.vue'
import AppButton from '@/components/ui/AppButton.vue'
import Modal from '@/components/ui/Modal.vue'
import { useControlPlane } from '@/composables/useControlPlane'
import { useToasts } from '@/composables/useToasts'
import * as api from '@/lib/api'
import { cn } from '@/lib/cn'

const SECTIONS = [
  { id: 'listener', title: 'Listener' },
  { id: 'authentication', title: 'Authentication' },
  { id: 'defaults', title: 'Server defaults' },
  { id: 'logs', title: 'Logs' },
  { id: 'notifications', title: 'Notifications' },
  { id: 'host', title: 'Host vitals' },
  { id: 'backups', title: 'Backups' },
  { id: 'tls', title: 'TLS' },
  { id: 'interface', title: 'Interface' },
  { id: 'paths', title: 'Paths' },
] as const

type SectionId = typeof SECTIONS[number]['id']

const route = useRoute()
const router = useRouter()
const control = useControlPlane()
const toasts = useToasts()

const form = reactive<SettingsForm>(createSettingsForm())

const active = ref<SectionId>('listener')
const saving = ref(false)
const saveError = ref<string | null>(null)
const saveMessage = ref<string | null>(null)
const configLoadError = ref<string | null>(null)
/** The panel's own config file (`/api/settings`), for blocks it does not serve live. */
const settingsConfig = ref<SettingsView | null>(null)

const controlView = computed(() => control.control.value)
const defaultsView = computed(() => control.defaults.value)
const logsConfig = computed(() => control.logsConfig.value)
const telegramStatus = computed(() => control.notifications.value?.telegram ?? null)
const hostAlerts = computed(() => control.host.value?.alerts ?? [])

const hostConfig = computed(() => settingsConfig.value?.host ?? null)
const backupsPolicy = computed(() => settingsConfig.value?.backups ?? null)
const uiStatus = computed(() => settingsConfig.value?.ui ?? null)
const backupsState = computed(() => control.backups.value)
const configPath = computed(() => control.appState.value?.configPath ?? null)

/** Only fields that differ from what the panel currently holds. */
const patch = computed<SettingsPatch>(() => {
  const out: SettingsPatch = {}
  const view = controlView.value
  const defaults = defaultsView.value
  const logs = logsConfig.value
  const telegram = telegramStatus.value

  if (view !== null) {
    const controlDiff = controlPatch(view, form)
    if (Object.keys(controlDiff).length > 0)
      out.control = controlDiff as SettingsPatch['control']
  }
  if (defaults !== null) {
    const defaultsDiff = defaultsPatch(defaults, form.defaults)
    if (Object.keys(defaultsDiff).length > 0)
      out.defaults = defaultsDiff as SettingsPatch['defaults']
  }
  if (logs !== null) {
    const logsDiff = logsPatch(logs, form.logs)
    if (Object.keys(logsDiff).length > 0)
      out.logs = logsDiff as SettingsPatch['logs']
  }
  if (telegram !== null) {
    const telegramDiff = telegramPatch(telegram, form.telegram)
    if (Object.keys(telegramDiff).length > 0)
      out.notifications = telegramDiff as SettingsPatch['notifications']
  }
  // Host thresholds and the backups policy are file-level blocks the panel owns;
  // they come from `/api/settings`, not from the live state frame.
  const host = hostConfig.value
  if (host !== null) {
    const hostDiff = hostPatch(host, form.host)
    if (Object.keys(hostDiff).length > 0)
      out.host = hostDiff as SettingsPatch['host']
  }
  const backups = backupsPolicy.value
  if (backups !== null) {
    const backupsDiff = backupsPatch(backups, form.backups)
    if (Object.keys(backupsDiff).length > 0)
      out.backups = backupsDiff as SettingsPatch['backups']
  }
  return out
})

const changedCount = computed(() => countLeaves(patch.value as Record<string, unknown>))

/** What every patch compares against, keyed the way the patch is. */
const currentSnapshot = computed<Record<string, unknown>>(() => {
  const view = controlView.value
  const telegram = telegramStatus.value
  const host = hostConfig.value
  const backups = backupsPolicy.value
  return {
    control: view === null ? {} : { ...listenerBaseline(view), auth: authBaseline(view.auth) },
    defaults: defaultsView.value ?? {},
    logs: logsConfig.value ?? {},
    notifications: telegram === null ? {} : { telegram: telegramBaseline(telegram) },
    host: host ?? {},
    backups: backups === null ? {} : { enabled: backups.enabled, keep: backups.keep, includePaths: backups.includePaths },
  }
})

const changes = computed(() => describeChanges(patch.value as Record<string, unknown>, currentSnapshot.value))
const showChanges = ref(false)

function formatChangeValue(value: unknown): string {
  if (value === undefined)
    return 'unset'
  return typeof value === 'string' ? value : JSON.stringify(value)
}
const listenerDirty = computed(() => controlView.value !== null && listenerChanged(controlView.value, form))
const tlsDirty = computed(() => controlView.value !== null && tlsChanged(controlView.value, form))
const authDirty = computed(() => controlView.value !== null && authChanged(controlView.value, form))
const defaultsDirty = computed(() => defaultsView.value !== null && Object.keys(defaultsPatch(defaultsView.value, form.defaults)).length > 0)
const logsDirty = computed(() => logsConfig.value !== null && Object.keys(logsPatch(logsConfig.value, form.logs)).length > 0)
const telegramDirty = computed(() => telegramStatus.value !== null && Object.keys(telegramPatch(telegramStatus.value, form.telegram)).length > 0)
const hostDirty = computed(() => hostConfig.value !== null && Object.keys(hostPatch(hostConfig.value, form.host)).length > 0)
const backupsDirty = computed(() => backupsPolicy.value !== null && Object.keys(backupsPatch(backupsPolicy.value, form.backups)).length > 0)

const hydrated = ref(false)

/** Pulls live state into the form, but never over a half-typed edit. */
function syncFromLive(): void {
  const view = controlView.value
  if (view !== null) {
    Object.assign(form.control, listenerBaseline(view))
    Object.assign(form.auth, authBaseline(view.auth))
  }
  const logs = logsConfig.value
  if (logs !== null)
    Object.assign(form.logs, logs)
  const telegram = telegramStatus.value
  if (telegram !== null)
    Object.assign(form.telegram, telegramBaseline(telegram))

  const host = hostConfig.value
  if (host !== null)
    Object.assign(form.host, hostBaseline(host))
  const backups = backupsPolicy.value
  if (backups !== null)
    Object.assign(form.backups, backupsBaseline(backups))

  const defaults = defaultsView.value
  if (defaults !== null) {
    form.defaults.enabled = defaults.enabled
    form.defaults.autostart = defaults.autostart
    form.defaults.bind = defaults.bind
    form.defaults.onPortConflict = defaults.onPortConflict
    form.defaults.logBufferLines = defaults.logBufferLines
    form.defaults.restart = { ...defaults.restart }
    form.defaults.health = cloneHealth(defaults.health)
    form.defaults.stop = { ...defaults.stop }
  }

  // From here on the form mirrors the config, so a diff means a real edit and
  // its guard below may refuse to overwrite it.
  hydrated.value = true
}

watch([controlView, defaultsView, logsConfig, telegramStatus, settingsConfig], () => {
  if (shouldHydrate({
    hydrated: hydrated.value,
    liveAvailable: controlView.value !== null,
    changedCount: changedCount.value,
  })) {
    syncFromLive()
  }
}, { immediate: true })

async function loadConfig(): Promise<void> {
  configLoadError.value = null
  try {
    settingsConfig.value = await api.fetchSettings()
  }
  catch (caught) {
    configLoadError.value = caught instanceof Error ? caught.message : String(caught)
  }
}

onMounted(() => {
  void loadConfig()
})

async function save(): Promise<void> {
  const pending = patch.value
  if (Object.keys(pending).length === 0 || saving.value)
    return

  saving.value = true
  saveError.value = null
  saveMessage.value = null
  try {
    const result = await control.saveSettings(pending)
    if (!result) {
      saveError.value = control.lastError.value ?? 'The settings could not be saved.'
      return
    }
    saveMessage.value = 'Settings saved.'
    toasts.success('Settings saved')
    await loadConfig()

    const failure = await followRebinding(result)
    if (failure !== null) {
      saveMessage.value = null
      saveError.value = failure
    }
    else if (result.rebinding) {
      saveMessage.value = 'Settings saved — the panel is moving to a new address.'
    }
  }
  finally {
    saving.value = false
  }
}

function discard(): void {
  saveError.value = null
  saveMessage.value = null
  syncFromLive()
}

function resetHost(): void {
  if (hostConfig.value !== null)
    Object.assign(form.host, hostBaseline(hostConfig.value))
}

function resetBackups(): void {
  if (backupsPolicy.value !== null)
    Object.assign(form.backups, backupsBaseline(backupsPolicy.value))
}

function resetListener(): void {
  if (controlView.value !== null) {
    const baseline = listenerBaseline(controlView.value)
    form.control.label = baseline.label
    form.control.port = baseline.port
    form.control.host = baseline.host
    form.control.openBrowser = baseline.openBrowser
  }
}

function resetAuth(): void {
  if (controlView.value !== null)
    Object.assign(form.auth, authBaseline(controlView.value.auth))
}

function resetDefaults(): void {
  const defaults = defaultsView.value
  if (defaults === null)
    return
  form.defaults.enabled = defaults.enabled
  form.defaults.autostart = defaults.autostart
  form.defaults.bind = defaults.bind
  form.defaults.onPortConflict = defaults.onPortConflict
  form.defaults.logBufferLines = defaults.logBufferLines
  form.defaults.restart = { ...defaults.restart }
  form.defaults.health = cloneHealth(defaults.health)
  form.defaults.stop = { ...defaults.stop }
}

function resetLogs(): void {
  if (logsConfig.value !== null)
    Object.assign(form.logs, logsConfig.value)
}

function resetTelegram(): void {
  if (telegramStatus.value !== null)
    Object.assign(form.telegram, telegramBaseline(telegramStatus.value))
}

function resetTls(): void {
  if (controlView.value !== null)
    form.control.tlsEnabled = controlView.value.tls.enabled
}

function scrollToSection(id: string): void {
  void nextTick(() => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })
}

function go(id: SectionId): void {
  active.value = id
  if (route.query.section !== id)
    void router.replace({ query: { ...route.query, section: id } })
  scrollToSection(id)
}

watch(() => route.query.section, (value) => {
  const id = typeof value === 'string' ? value : ''
  if (!SECTIONS.some(section => section.id === id))
    return
  active.value = id as SectionId
  scrollToSection(id)
}, { immediate: true })

let observer: IntersectionObserver | null = null

onMounted(() => {
  observer = new IntersectionObserver((entries) => {
    const visible = entries
      .filter(entry => entry.isIntersecting)
      .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
    const first = visible[0]
    if (first !== undefined && first.target.id.length > 0)
      active.value = first.target.id as SectionId
  }, { rootMargin: '-72px 0px -62% 0px', threshold: 0 })

  for (const section of SECTIONS) {
    const element = document.getElementById(section.id)
    if (element)
      observer.observe(element)
  }
})

onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <div class="min-h-full">
    <div class="mx-auto w-full max-w-5xl px-4 pb-6 pt-5 sm:px-6">
      <header class="mb-5">
        <h1 class="text-xl font-semibold tracking-tight text-ink">
          Settings
        </h1>
        <p class="mt-1 text-xs text-muted">
          Listener, access, defaults, retention, alerts, backups and paths for this panel.
        </p>
      </header>

      <Notice v-if="control.configError.value" tone="danger" title="The config file could not be read" class="mb-4">
        {{ control.configError.value }}
      </Notice>
      <Notice v-else-if="configLoadError" tone="warn" title="Some file-only values could not be loaded" class="mb-4">
        {{ configLoadError }}
      </Notice>

      <div class="lg:grid lg:grid-cols-[11rem_minmax(0,1fr)] lg:gap-8">
        <nav aria-label="Settings sections" class="hidden lg:block">
          <ul class="sticky top-6 space-y-0.5 border-l border-line">
            <li v-for="section in SECTIONS" :key="section.id">
              <button
                type="button"
                :aria-current="active === section.id ? 'true' : undefined"
                :class="cn(
                  '-ml-px block w-full border-l-2 py-1.5 pl-3 text-left text-xs transition-colors duration-150',
                  active === section.id
                    ? 'border-accent font-medium text-accent'
                    : 'border-transparent text-muted hover:border-line hover:text-ink',
                )"
                @click="go(section.id)"
              >
                {{ section.title }}
              </button>
            </li>
          </ul>
        </nav>

        <div class="space-y-6">
          <section id="listener" class="scroll-mt-5">
            <header class="mb-3">
              <h2 class="text-lg font-semibold text-ink">
                Listener
              </h2>
              <p class="mt-0.5 text-xs text-muted">
                Where the control panel listens and how it announces itself.
              </p>
            </header>
            <ListenerSection
              v-model:control="form.control"
              :view="controlView"
              :dirty="listenerDirty"
              @reset="resetListener"
            />
          </section>

          <section id="authentication" class="scroll-mt-5">
            <header class="mb-3">
              <h2 class="text-lg font-semibold text-ink">
                Authentication
              </h2>
              <p class="mt-0.5 text-xs text-muted">
                Who may sign in, and how a session is trusted.
              </p>
            </header>
            <AuthenticationSection
              v-model:auth="form.auth"
              :view="controlView"
              :dirty="authDirty"
              @reset="resetAuth"
            />
          </section>

          <section id="password" class="scroll-mt-5">
            <header class="mb-3">
              <h2 class="text-lg font-semibold text-ink">
                Password
              </h2>
              <p class="mt-0.5 text-xs text-muted">
                The one credential that guards this panel.
              </p>
            </header>
            <PasswordSection :view="controlView" />
          </section>

          <section id="defaults" class="scroll-mt-5">
            <header class="mb-3">
              <h2 class="text-lg font-semibold text-ink">
                Server defaults
              </h2>
              <p class="mt-0.5 text-xs text-muted">
                Applied to every entry that does not set its own value.
              </p>
            </header>
            <DefaultsSection
              v-model:defaults="form.defaults"
              :dirty="defaultsDirty"
              @reset="resetDefaults"
            />
          </section>

          <section id="logs" class="scroll-mt-5">
            <header class="mb-3">
              <h2 class="text-lg font-semibold text-ink">
                Logs
              </h2>
              <p class="mt-0.5 text-xs text-muted">
                How much output is kept on disk and for how long.
              </p>
            </header>
            <LogsSection
              v-model:logs="form.logs"
              :logs-dir="control.appState.value?.logsDir ?? null"
              :dirty="logsDirty"
              @reset="resetLogs"
            />
          </section>

          <section id="notifications" class="scroll-mt-5">
            <header class="mb-3">
              <h2 class="text-lg font-semibold text-ink">
                Notifications
              </h2>
              <p class="mt-0.5 text-xs text-muted">
                Crash and health alerts sent to a Telegram chat.
              </p>
            </header>
            <NotificationsSection
              v-model:telegram="form.telegram"
              :status="telegramStatus"
              :dirty="telegramDirty"
              @reset="resetTelegram"
            />
          </section>

          <section id="host" class="scroll-mt-5">
            <header class="mb-3">
              <h2 class="text-lg font-semibold text-ink">
                Host vitals
              </h2>
              <p class="mt-0.5 text-xs text-muted">
                Alert thresholds for this machine's own resources.
              </p>
            </header>
            <HostSection
              v-model:host="form.host"
              :config="hostConfig"
              :alerts="hostAlerts"
              :dirty="hostDirty"
              @reset="resetHost"
            />
          </section>

          <section id="backups" class="scroll-mt-5">
            <header class="mb-3">
              <h2 class="text-lg font-semibold text-ink">
                Backups
              </h2>
              <p class="mt-0.5 text-xs text-muted">
                Archives of config, secrets and declared data paths.
              </p>
            </header>
            <BackupsSection
              v-model:form="form.backups"
              :state="backupsState"
              :policy="backupsPolicy"
              :config-path="configPath"
              :dirty="backupsDirty"
              @reset="resetBackups"
            />
          </section>

          <section id="tls" class="scroll-mt-5">
            <header class="mb-3">
              <h2 class="text-lg font-semibold text-ink">
                TLS
              </h2>
              <p class="mt-0.5 text-xs text-muted">
                Serve the panel over HTTPS with your own certificate.
              </p>
            </header>
            <TlsSection
              v-model:tls-enabled="form.control.tlsEnabled"
              :view="controlView"
              :dirty="tlsDirty"
              @reset="resetTls"
            />
          </section>

          <section id="interface" class="scroll-mt-5">
            <header class="mb-3">
              <h2 class="text-lg font-semibold text-ink">
                Interface
              </h2>
              <p class="mt-0.5 text-xs text-muted">
                Serve your own panel UI instead of the stock one.
              </p>
            </header>
            <InterfaceSection
              v-model:label="form.control.label"
              :ui="uiStatus"
              :label-dirty="listenerDirty"
              @changed="loadConfig"
              @reset-label="resetListener"
            />
          </section>

          <section id="paths" class="scroll-mt-5">
            <header class="mb-3">
              <h2 class="text-lg font-semibold text-ink">
                Paths
              </h2>
              <p class="mt-0.5 text-xs text-muted">
                Where home-hosted keeps its files.
              </p>
            </header>
            <PathsSection
              :config-path="configPath"
              :data-root="control.appState.value?.dataRoot ?? null"
              :logs-dir="control.appState.value?.logsDir ?? null"
              :project-dir="control.appState.value?.projectDir ?? null"
              :panel-url="controlView?.url ?? null"
            />
          </section>
        </div>
      </div>
    </div>

    <div class="sticky bottom-0 z-30 border-t border-line bg-panel/95 backdrop-blur">
      <div class="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
        <div class="min-w-0 flex-1">
          <p class="text-xs text-muted">
            <template v-if="changedCount > 0">
              <button
                type="button"
                class="rounded-control px-1 py-0.5 text-xs text-muted underline decoration-line underline-offset-2 hover:text-ink"
                @click="showChanges = true"
              >
                <span class="font-mono tabular-nums text-ink">{{ changedCount }}</span>
                field{{ changedCount === 1 ? '' : 's' }} changed
              </button>
            </template>
            <template v-else>
              No unsaved changes
            </template>
          </p>
          <p v-if="saveError" class="mt-0.5 text-xs text-danger">
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
          <AppButton variant="primary" :disabled="changedCount === 0" :loading="saving" @click="save">
            Save settings
          </AppButton>
        </div>
      </div>
    </div>
  </div>

  <Modal v-model:open="showChanges" title="Unsaved changes" description="What Save would write to servers.config.json." width="w-[min(92vw,42rem)]">
    <div class="max-h-[60dvh] overflow-auto px-4 py-3">
      <ul v-if="changes.length > 0" class="divide-y divide-line-soft">
        <li v-for="change in changes" :key="change.path" class="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 first:pt-0">
          <code class="font-mono text-xs text-ink">{{ change.path }}</code>
          <span class="ml-auto font-mono text-xs text-muted line-through">{{ formatChangeValue(change.from) }}</span>
          <span class="text-2xs text-faint">→</span>
          <span class="font-mono text-xs text-accent">{{ formatChangeValue(change.to) }}</span>
        </li>
      </ul>
      <p v-else class="text-xs text-muted">
        Nothing to save.
      </p>
    </div>
    <footer class="flex items-center justify-end gap-2 border-t border-line px-4 py-3">
      <AppButton size="sm" variant="ghost" @click="showChanges = false">
        Close
      </AppButton>
      <AppButton size="sm" variant="primary" :disabled="changes.length === 0 || saving" :loading="saving" @click="save(); showChanges = false">
        Save {{ changes.length }} change{{ changes.length === 1 ? '' : 's' }}
      </AppButton>
    </footer>
  </Modal>
</template>
