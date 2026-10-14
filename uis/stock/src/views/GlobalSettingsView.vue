<script setup lang="ts">
import type { SettingsPatch } from '@shared/contracts'
import type { FormSnapshots, GlobalFormBlock, GlobalSettingsForm } from '@/components/settings/settingsForm'
import type { SettingsView } from '@/lib/api'
import { errorMessage } from '@shared/error-message'
import { countLeaves, describeChanges } from '@shared/patch-diff'
import { computed, onMounted, reactive, ref, watch } from 'vue'
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
import SettingsSection from '@/components/settings/SettingsSection.vue'
import SettingsShell from '@/components/settings/SettingsShell.vue'
import TlsSection from '@/components/settings/TlsSection.vue'
import LanguageSelect from '@/components/ui/LanguageSelect.vue'
import { useControlPlane } from '@/composables/useControlPlane'
import { useToasts } from '@/composables/useToasts'
import { t } from '@/i18n'
import * as api from '@/lib/api'

/** Panel-wide settings: they belong to the process, not to any workspace. */
const SECTIONS = computed(() => [
  { id: 'listener', title: t('views.globalSettings.sectionListener') },
  { id: 'authentication', title: t('views.globalSettings.sectionAuthentication') },
  { id: 'host', title: t('views.globalSettings.sectionHost') },
  { id: 'backups', title: t('views.globalSettings.sectionBackups') },
  { id: 'tls', title: t('views.globalSettings.sectionTls') },
  { id: 'language', title: t('language.label') },
  { id: 'interface', title: t('views.globalSettings.sectionInterface') },
  { id: 'paths', title: t('views.globalSettings.sectionPaths') },
])

const control = useControlPlane()
const toasts = useToasts()

const form = reactive<GlobalSettingsForm>(createGlobalForm())

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
    configLoadError.value = errorMessage(caught)
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
      saveError.value = control.lastError.value ?? t('views.globalSettings.saveFailed')
      return
    }
    saveMessage.value = t('views.globalSettings.saved')
    toasts.success(t('views.globalSettings.savedToast'))
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
      saveMessage.value = t('views.globalSettings.savedRebinding')
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
</script>

<template>
  <SettingsShell
    :sections="SECTIONS"
    :nav-label="t('views.globalSettings.navLabel')"
    :changes-description="t('views.globalSettings.changesDescription')"
    :changed-count="changedCount"
    :changes="changes"
    :save-error="saveError"
    :save-message="saveMessage"
    :saving="saving"
    @save="save"
    @discard="discard"
  >
    <template #header>
      <header class="mb-5">
        <h1 class="text-xl font-semibold tracking-tight text-ink">
          {{ t('views.globalSettings.title') }}
        </h1>
        <p class="mt-1 text-xs text-muted">
          {{ t('views.globalSettings.description') }}
        </p>
      </header>

      <Notice v-if="configLoadError" tone="warn" :title="t('views.globalSettings.loadErrorTitle')" class="mb-4">
        {{ configLoadError }}
      </Notice>
    </template>

    <SettingsSection id="listener" :title="t('views.globalSettings.sectionListener')" :description="t('views.globalSettings.listenerDescription')">
      <ListenerSection
        v-model:control="form.control"
        :view="controlView"
        :dirty="listenerDirty"
        @reset="resetListener"
      />
    </SettingsSection>

    <SettingsSection id="authentication" :title="t('views.globalSettings.sectionAuthentication')" :description="t('views.globalSettings.authenticationDescription')">
      <AuthenticationSection
        v-model:auth="form.auth"
        :view="controlView"
        :dirty="authDirty"
        @reset="resetAuth"
      />
    </SettingsSection>

    <SettingsSection id="host" :title="t('views.globalSettings.sectionHost')" :description="t('views.globalSettings.hostDescription')">
      <HostSection
        v-model:host="form.host"
        :config="hostConfig"
        :alerts="hostAlerts"
        :dirty="hostDirty"
        @reset="resetHost"
      />
    </SettingsSection>

    <SettingsSection id="backups" :title="t('views.globalSettings.sectionBackups')" :description="t('views.globalSettings.backupsDescription')">
      <BackupsSection
        v-model:form="form.backups"
        :state="backupsState"
        :policy="backupsPolicy"
        :config-path="settingsPath"
        :workspaces="control.workspaces.value"
        :dirty="backupsDirty"
        @reset="resetBackups"
      />
    </SettingsSection>

    <SettingsSection id="tls" :title="t('views.globalSettings.sectionTls')" :description="t('views.globalSettings.tlsDescription')">
      <TlsSection
        v-model:tls-enabled="form.control.tlsEnabled"
        :view="controlView"
        :dirty="tlsDirty"
        @reset="resetTls"
      />
    </SettingsSection>

    <SettingsSection id="language" :title="t('language.label')" :description="t('views.globalSettings.languageDescription')">
      <LanguageSelect :wide="true" />
      <p class="text-2xs leading-4 text-faint sm:col-span-2">
        {{ t('views.globalSettings.languageNote') }}
      </p>
    </SettingsSection>

    <SettingsSection id="interface" :title="t('views.globalSettings.sectionInterface')" :description="t('views.globalSettings.interfaceDescription')">
      <InterfaceSection
        v-model:label="form.control.label"
        :ui="uiStatus"
        :panel-version="panelVersion"
        :label-dirty="listenerDirty"
        @changed="loadConfig"
        @reset-label="resetListener"
      />
    </SettingsSection>

    <SettingsSection id="paths" :title="t('views.globalSettings.sectionPaths')" :description="t('views.globalSettings.pathsDescription')">
      <PathsSection
        :data-root="dataRoot"
        :project-dir="projectDir"
        :panel-url="controlView?.url ?? null"
        :workspaces="control.workspaces.value"
      />
    </SettingsSection>
  </SettingsShell>
</template>
