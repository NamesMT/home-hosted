<script setup lang="ts">
import type { DdnsConfig, WorkspaceSettingsPatch } from '@shared/contracts'
import type { FormSnapshots, WorkspaceFormBlock, WorkspaceSettingsForm } from '@/components/settings/settingsForm'
import type { DraftConfig } from '@/lib/ddns'
import { errorMessage } from '@shared/error-message'
import { countLeaves, describeChanges } from '@shared/patch-diff'
import { computed, reactive, ref, watch } from 'vue'
import DdnsSection from '@/components/settings/DdnsSection.vue'
import DefaultsSection from '@/components/settings/DefaultsSection.vue'
import LogsSection from '@/components/settings/LogsSection.vue'
import Notice from '@/components/settings/Notice.vue'
import NotificationsSection from '@/components/settings/NotificationsSection.vue'
import {
  cloneHealth,
  createWorkspaceForm,
  defaultsPatch,
  isBlockEdited,
  logsPatch,
  telegramBaseline,
  telegramPatch,
  webhookBaseline,
  webhooksPatch,
  workspaceBlockSnapshot,
} from '@/components/settings/settingsForm'
import SettingsSection from '@/components/settings/SettingsSection.vue'
import SettingsShell from '@/components/settings/SettingsShell.vue'
import WebhookSection from '@/components/settings/WebhookSection.vue'
import PageHeader from '@/components/ui/PageHeader.vue'
import { useControlPlane } from '@/composables/useControlPlane'
import { useToasts } from '@/composables/useToasts'
import { useWorkspaces } from '@/composables/useWorkspaces'
import { t } from '@/i18n'
import * as api from '@/lib/api'

/** The rail's own wording: the section headings inside each block are the sections' business. */
const SECTIONS = computed(() => [
  { id: 'defaults', title: t('views.settings.sectionDefaults') },
  { id: 'logs', title: t('views.settings.sectionLogs') },
  { id: 'notifications', title: t('views.settings.sectionNotifications') },
  { id: 'ddns', title: t('views.settings.sectionDdns') },
])

const control = useControlPlane()
const workspace = useWorkspaces()
const toasts = useToasts()

const form = reactive<WorkspaceSettingsForm>(createWorkspaceForm())

const saving = ref(false)
const saveError = ref<string | null>(null)
const saveMessage = ref<string | null>(null)

/**
 * The DDNS section owns its own draft (its accounts and hostnames are lists). Its
 * policy is written through `/api/ddns`, so this page saves it alongside the rest.
 */
const ddnsPatch = ref<DdnsConfig | null>(null)
const ddnsBaseline = ref<DraftConfig | null>(null)
const ddnsSection = ref<{ reload: () => Promise<void> } | null>(null)

const defaultsView = computed(() => workspace.defaults.value)
const logsConfig = computed(() => workspace.logsConfig.value)
const telegramStatus = computed(() => workspace.notifications.value?.telegram ?? null)
const webhookStatuses = computed(() => workspace.notifications.value?.webhooks ?? [])
const logsDir = computed(() => workspace.logsDir.value)

/** Only fields that differ from what the workspace currently holds. */
const patch = computed<WorkspaceSettingsPatch>(() => {
  const out: WorkspaceSettingsPatch = {}
  const defaults = defaultsView.value
  const logs = logsConfig.value
  const telegram = telegramStatus.value

  if (defaults !== null) {
    const diff = defaultsPatch(defaults, form.defaults)
    if (Object.keys(diff).length > 0)
      out.defaults = diff as WorkspaceSettingsPatch['defaults']
  }
  if (logs !== null) {
    const diff = logsPatch(logs, form.logs)
    if (Object.keys(diff).length > 0)
      out.logs = diff as WorkspaceSettingsPatch['logs']
  }
  if (telegram !== null) {
    const diff = telegramPatch(telegram, form.telegram)
    if (Object.keys(diff).length > 0)
      out.notifications = diff as WorkspaceSettingsPatch['notifications']
  }
  // The list is replaced when it changed at all: a merge cannot express removing a target.
  const hooks = webhooksPatch(webhookStatuses.value, form.webhooks)
  if (hooks !== null) {
    out.notifications = {
      ...(out.notifications ?? {}),
      webhooks: hooks.webhooks,
    } as WorkspaceSettingsPatch['notifications']
  }
  return out
})

const changedCount = computed(() => countLeaves(patch.value as Record<string, unknown>) + (ddnsPatch.value === null ? 0 : countLeaves(ddnsPatch.value as Record<string, unknown>)))

/** What every patch compares against, keyed the way the patch is. */
const currentSnapshot = computed<Record<string, unknown>>(() => {
  const telegram = telegramStatus.value
  return {
    defaults: defaultsView.value ?? {},
    logs: logsConfig.value ?? {},
    notifications: telegram === null ? {} : { telegram: telegramBaseline(telegram) },
    ddns: ddnsBaseline.value ?? {},
  }
})

const changes = computed(() => describeChanges({ ...(patch.value as Record<string, unknown>), ...(ddnsPatch.value === null ? {} : { ddns: ddnsPatch.value }) }, currentSnapshot.value))

const defaultsDirty = computed(() => defaultsView.value !== null && Object.keys(defaultsPatch(defaultsView.value, form.defaults)).length > 0)
const logsDirty = computed(() => logsConfig.value !== null && Object.keys(logsPatch(logsConfig.value, form.logs)).length > 0)
const telegramDirty = computed(() => telegramStatus.value !== null
  && (Object.keys(telegramPatch(telegramStatus.value, form.telegram)).length > 0
    || webhooksPatch(webhookStatuses.value, form.webhooks) !== null))

/** What each block held when it was last filled, so an edit is not overwritten. */
const snapshots: FormSnapshots = {}

/**
 * Fills each block from the workspace's own slice of the state frame, unless the
 * user is editing that block. A live frame must never overwrite a half-typed edit.
 */
function syncFromLive(): void {
  const fill = (block: WorkspaceFormBlock, apply: () => void): void => {
    if (isBlockEdited(snapshots[block], workspaceBlockSnapshot(form, block)))
      return
    apply()
    snapshots[block] = workspaceBlockSnapshot(form, block)
  }

  const defaults = defaultsView.value
  if (defaults !== null) {
    fill('defaults', () => {
      form.defaults.enabled = defaults.enabled
      form.defaults.autostart = defaults.autostart
      form.defaults.bind = defaults.bind
      form.defaults.onPortConflict = defaults.onPortConflict
      form.defaults.logBufferLines = defaults.logBufferLines
      form.defaults.restart = { ...defaults.restart }
      form.defaults.health = cloneHealth(defaults.health)
      form.defaults.stop = { ...defaults.stop }
    })
  }

  const logs = logsConfig.value
  if (logs !== null)
    fill('logs', () => Object.assign(form.logs, logs))

  const telegram = telegramStatus.value
  if (telegram !== null) {
    fill('telegram', () => {
      Object.assign(form.telegram, telegramBaseline(telegram))
      // The webhook list belongs to the same notifications block, so it fills and resets with
      // it — a second guard would make one half save while the other stayed stale.
      form.webhooks = webhookStatuses.value.map(webhookBaseline)
    })
  }
}

function forgetSnapshots(): void {
  for (const key of Object.keys(snapshots))
    delete snapshots[key as WorkspaceFormBlock]
}

watch([defaultsView, logsConfig, telegramStatus], () => {
  syncFromLive()
}, { immediate: true })

async function save(): Promise<void> {
  const pending = patch.value
  const ddns = ddnsPatch.value
  const hasWorkspacePatch = Object.keys(pending).length > 0
  if ((!hasWorkspacePatch && ddns === null) || saving.value || workspace.activeId.value.length === 0)
    return

  saving.value = true
  saveError.value = null
  saveMessage.value = null
  try {
    if (hasWorkspacePatch) {
      const result = await control.saveWorkspaceSettings(workspace.activeId.value, pending)
      if (!result) {
        saveError.value = control.lastError.value ?? t('views.settings.saveFailed')
        return
      }
    }
    if (ddns !== null) {
      await api.saveDdns(workspace.activeId.value, ddns)
      await ddnsSection.value?.reload()
    }
    saveMessage.value = t('views.settings.saved')
    toasts.success(t('views.settings.savedToast'))
    forgetSnapshots()
    syncFromLive()
  }
  catch (caught) {
    saveError.value = errorMessage(caught)
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
  ddnsSection.value?.reload()
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
  remember('defaults')
}

function resetLogs(): void {
  if (logsConfig.value !== null)
    Object.assign(form.logs, logsConfig.value)
  remember('logs')
}

function resetTelegram(): void {
  if (telegramStatus.value !== null) {
    Object.assign(form.telegram, telegramBaseline(telegramStatus.value))
    form.webhooks = webhookStatuses.value.map(webhookBaseline)
  }
  remember('telegram')
}

/** A reset re-baselines its own block; the guards of the other blocks stay where they were. */
function remember(block: WorkspaceFormBlock): void {
  snapshots[block] = workspaceBlockSnapshot(form, block)
}

// A workspace switch replaces every block on this page with a new workspace's own.
watch(() => workspace.activeId.value, () => {
  forgetSnapshots()
  syncFromLive()
  saveError.value = null
  saveMessage.value = null
})
</script>

<template>
  <SettingsShell
    :sections="SECTIONS"
    :nav-label="t('views.settings.navLabel')"
    :changes-description="t('views.settings.changesDescription', { workspace: workspace.selected.value?.label ?? t('nav.workspace') })"
    :changed-count="changedCount"
    :changes="changes"
    :save-error="saveError"
    :save-message="saveMessage"
    :saving="saving"
    @save="save"
    @discard="discard"
  >
    <template #header>
      <PageHeader
        :title="t('nav.workspaceSettings')"
        :description="t('views.settings.description', { workspace: workspace.selected.value?.label ?? t('nav.workspace') })"
      />

      <Notice v-if="workspace.configError.value" tone="danger" :title="t('views.settings.configErrorTitle')" class="mb-4">
        <p>{{ workspace.configError.value }}</p>
        <p class="mt-1">
          {{ t('views.settings.configErrorNote') }}
        </p>
      </Notice>
      <Notice v-else-if="workspace.configWarnings.value.length > 0" tone="warn" :title="t('views.settings.configWarningTitle')" class="mb-4">
        <p v-for="warning in workspace.configWarnings.value" :key="warning" class="font-mono">
          {{ warning }}
        </p>
      </Notice>
    </template>

    <SettingsSection id="defaults" :title="t('views.settings.sectionDefaults')" :description="t('views.settings.defaultsDescription')">
      <DefaultsSection
        v-model:defaults="form.defaults"
        :dirty="defaultsDirty"
        @reset="resetDefaults"
      />
    </SettingsSection>

    <SettingsSection id="logs" :title="t('views.settings.sectionLogs')" :description="t('views.settings.logsDescription')">
      <LogsSection
        v-model:logs="form.logs"
        :logs-dir="logsDir"
        :dirty="logsDirty"
        @reset="resetLogs"
      />
    </SettingsSection>

    <SettingsSection id="notifications" :title="t('views.settings.sectionNotifications')" :description="t('views.settings.notificationsDescription')">
      <NotificationsSection
        v-model:telegram="form.telegram"
        :status="telegramStatus"
        :dirty="telegramDirty"
        @reset="resetTelegram"
      />
      <WebhookSection
        v-model:webhooks="form.webhooks"
        :statuses="webhookStatuses"
        :dirty="telegramDirty"
      />
    </SettingsSection>

    <SettingsSection id="ddns" :title="t('views.settings.sectionDdns')" :description="t('views.settings.ddnsDescription')">
      <DdnsSection
        ref="ddnsSection"
        v-model:patch="ddnsPatch"
        v-model:baseline="ddnsBaseline"
      />
    </SettingsSection>
  </SettingsShell>
</template>
