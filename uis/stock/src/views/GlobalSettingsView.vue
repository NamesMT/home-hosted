<script setup lang="ts">
import type { SettingsPatch } from '@shared/contracts'
import type { FormSnapshots, GlobalFormBlock, GlobalSettingsForm } from '@/components/settings/settingsForm'
import type { SettingsView } from '@/lib/api'
import { countLeaves, describeChanges } from '@shared/patch-diff'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AuthenticationSection from '@/components/settings/AuthenticationSection.vue'
import BackupsSection from '@/components/settings/BackupsSection.vue'
import HostSection from '@/components/settings/HostSection.vue'
import InterfaceSection from '@/components/settings/InterfaceSection.vue'
import ListenerSection from '@/components/settings/ListenerSection.vue'
import Notice from '@/components/settings/Notice.vue'
import PathsSection from '@/components/settings/PathsSection.vue'
import {
  authBaseline,
  authChanged,
  backupsBaseline,
  backupsPatch,
  controlPartEdited,
  controlPatch,
  createGlobalForm,
  followRebinding,
  globalBlockSnapshot,
  hostBaseline,
  hostPatch,
  isBlockEdited,
  listenerBaseline,
  listenerChanged,
  rememberControlPart,
  tlsChanged,
} from '@/components/settings/settingsForm'
import TlsSection from '@/components/settings/TlsSection.vue'
import AppButton from '@/components/ui/AppButton.vue'
import Modal from '@/components/ui/Modal.vue'
import { useControlPlane } from '@/composables/useControlPlane'
import { useToasts } from '@/composables/useToasts'
import * as api from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatChangeValue } from '@/lib/format'

/** Panel-wide settings: they belong to the process, not to any workspace. */
const SECTIONS = [
  { id: 'listener', title: 'Listener' },
  { id: 'authentication', title: 'Authentication' },
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

const form = reactive<GlobalSettingsForm>(createGlobalForm())

const active = ref<SectionId>('listener')
const saving = ref(false)
const saveError = ref<string | null>(null)
const saveMessage = ref<string | null>(null)
const configLoadError = ref<string | null>(null)
/** `/api/settings`: the file-level blocks the live state frame only partly carries. */
const settingsConfig = ref<SettingsView | null>(null)

const controlView = computed(() => control.control.value)
const hostAlerts = computed(() => control.host.value?.alerts ?? [])
const hostConfig = computed(() => settingsConfig.value?.host ?? null)
const backupsPolicy = computed(() => settingsConfig.value?.backups ?? null)
const backupsState = computed(() => control.backups.value)
const uiStatus = computed(() => settingsConfig.value?.ui ?? null)
const panelVersion = computed(() => control.version.value)
const dataRoot = computed(() => control.dataRoot.value)
const projectDir = computed(() => control.projectDir.value)
/** The panel's own settings file, beside `workspaces.json`. */
const settingsPath = computed(() => (dataRoot.value === null ? null : `${dataRoot.value}/settings.json`))

/** Only fields that differ from what the panel currently holds. */
const patch = computed<SettingsPatch>(() => {
  const out: SettingsPatch = {}
  const view = controlView.value
  if (view !== null) {
    const diff = controlPatch(view, form)
    if (Object.keys(diff).length > 0)
      out.control = diff as SettingsPatch['control']
  }
  const host = hostConfig.value
  if (host !== null) {
    const diff = hostPatch(host, form.host)
    if (Object.keys(diff).length > 0)
      out.host = diff as SettingsPatch['host']
  }
  const backups = backupsPolicy.value
  if (backups !== null) {
    const diff = backupsPatch(backups, form.backups)
    if (Object.keys(diff).length > 0)
      out.backups = diff as SettingsPatch['backups']
  }
  return out
})

const changedCount = computed(() => countLeaves(patch.value as Record<string, unknown>))

const currentSnapshot = computed<Record<string, unknown>>(() => {
  const view = controlView.value
  const host = hostConfig.value
  const backups = backupsPolicy.value
  return {
    control: view === null ? {} : { ...listenerBaseline(view), auth: authBaseline(view.auth) },
    host: host ?? {},
    backups: backups === null ? {} : { enabled: backups.enabled, keep: backups.keep, includePaths: backups.includePaths },
  }
})

const changes = computed(() => describeChanges(patch.value as Record<string, unknown>, currentSnapshot.value))
const showChanges = ref(false)

const listenerDirty = computed(() => controlView.value !== null && listenerChanged(controlView.value, form))
const tlsDirty = computed(() => controlView.value !== null && tlsChanged(controlView.value, form))
const authDirty = computed(() => controlView.value !== null && authChanged(controlView.value, form))
const hostDirty = computed(() => hostConfig.value !== null && Object.keys(hostPatch(hostConfig.value, form.host)).length > 0)
const backupsDirty = computed(() => backupsPolicy.value !== null && Object.keys(backupsPatch(backupsPolicy.value, form.backups)).length > 0)

const snapshots: FormSnapshots = {}

/** Fills each block from its own source, unless the user is editing that block. */
function syncFromLive(): void {
  const fill = (block: GlobalFormBlock, apply: () => void): void => {
    if (isBlockEdited(snapshots[block], globalBlockSnapshot(form, block)))
      return
    apply()
    snapshots[block] = globalBlockSnapshot(form, block)
  }

  const view = controlView.value
  if (view !== null) {
    // The three control groups are guarded separately. One shared snapshot meant a Reset in
    // any of them re-baselined the others, so a pending edit elsewhere was discarded by the
    // next frame.
    if (!controlPartEdited(form, snapshots.control, 'listener')) {
      Object.assign(form.control, listenerBaseline(view))
      rememberControlPart(form, snapshots, 'listener')
    }
    if (!controlPartEdited(form, snapshots.control, 'auth')) {
      Object.assign(form.auth, authBaseline(view.auth))
      rememberControlPart(form, snapshots, 'auth')
    }
    if (!controlPartEdited(form, snapshots.control, 'tls')) {
      form.control.tlsEnabled = view.tls.enabled
      rememberControlPart(form, snapshots, 'tls')
    }
  }
  const host = hostConfig.value
  if (host !== null)
    fill('host', () => Object.assign(form.host, hostBaseline(host)))
  const backups = backupsPolicy.value
  if (backups !== null)
    fill('backups', () => Object.assign(form.backups, backupsBaseline(backups)))
}

function forgetSnapshots(): void {
  for (const key of Object.keys(snapshots))
    delete snapshots[key as GlobalFormBlock]
}

function remember(block: GlobalFormBlock): void {
  snapshots[block] = globalBlockSnapshot(form, block)
}

watch([controlView, settingsConfig], () => {
  syncFromLive()
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
    const result = await control.saveGlobalSettings(pending)
    if (!result) {
      saveError.value = control.lastError.value ?? 'The settings could not be saved.'
      return
    }
    saveMessage.value = 'Settings saved.'
    toasts.success('Settings saved')
    await loadConfig()
    // What was saved is what live state holds now, so every block may follow it again.
    forgetSnapshots()
    syncFromLive()

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
  forgetSnapshots()
  syncFromLive()
}

function resetHost(): void {
  if (hostConfig.value !== null)
    Object.assign(form.host, hostBaseline(hostConfig.value))
  remember('host')
}

function resetBackups(): void {
  if (backupsPolicy.value !== null)
    Object.assign(form.backups, backupsBaseline(backupsPolicy.value))
  remember('backups')
}

function resetListener(): void {
  if (controlView.value !== null) {
    const baseline = listenerBaseline(controlView.value)
    form.control.label = baseline.label
    form.control.port = baseline.port
    form.control.host = baseline.host
    form.control.openBrowser = baseline.openBrowser
  }
  rememberControlPart(form, snapshots, 'listener')
}

function resetAuth(): void {
  if (controlView.value !== null)
    Object.assign(form.auth, authBaseline(controlView.value.auth))
  rememberControlPart(form, snapshots, 'auth')
}

function resetTls(): void {
  if (controlView.value !== null)
    form.control.tlsEnabled = controlView.value.tls.enabled
  rememberControlPart(form, snapshots, 'tls')
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
          Global settings
        </h1>
        <p class="mt-1 text-xs text-muted">
          Listener, access, host vitals, backups, TLS and paths for this panel — shared by every workspace.
        </p>
      </header>

      <Notice v-if="configLoadError" tone="warn" title="Some file-only values could not be loaded" class="mb-4">
        {{ configLoadError }}
      </Notice>

      <div class="lg:grid lg:grid-cols-[11rem_minmax(0,1fr)] lg:gap-8">
        <nav aria-label="Global settings sections" class="hidden lg:block">
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
                Who may sign in to this panel, and how a session is trusted.
              </p>
            </header>
            <AuthenticationSection
              v-model:auth="form.auth"
              :view="controlView"
              :dirty="authDirty"
              @reset="resetAuth"
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
                One archive per capture, covering the panel and any workspace you pick.
              </p>
            </header>
            <BackupsSection
              v-model:form="form.backups"
              :state="backupsState"
              :policy="backupsPolicy"
              :config-path="settingsPath"
              :workspaces="control.workspaces.value"
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
              :panel-version="panelVersion"
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
                Where home-hosted keeps its files, globally and per workspace.
              </p>
            </header>
            <PathsSection
              :data-root="dataRoot"
              :project-dir="projectDir"
              :panel-url="controlView?.url ?? null"
              :workspaces="control.workspaces.value"
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

  <Modal v-model:open="showChanges" title="Unsaved changes" description="What Save would write to the panel's settings file." width="w-[min(92vw,42rem)]">
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
