<script setup lang="ts">
import type { DdnsConfig, WorkspaceSettingsPatch } from '@shared/contracts'
import type { FormSnapshots, WorkspaceFormBlock, WorkspaceSettingsForm } from '@/components/settings/settingsForm'
import type { DraftConfig } from '@/lib/ddns'
import { errorMessage } from '@shared/error-message'
import { countLeaves, describeChanges } from '@shared/patch-diff'
import { computed, reactive, ref, watch } from 'vue'
import DdnsSection from '@/components/settings/DdnsSection.vue'
import DefaultsSection from '@/components/settings/DefaultsSection.vue'
import DestinationsSection from '@/components/settings/DestinationsSection.vue'
import LogsSection from '@/components/settings/LogsSection.vue'
import Notice from '@/components/settings/Notice.vue'
import NotificationPolicyFields from '@/components/settings/NotificationPolicyFields.vue'
import {
  cloneHealth,
  createWorkspaceForm,
  defaultsPatch,
  destinationBaseline,
  destinationsPatch,
  isBlockEdited,
  logsPatch,
  policyBaseline,
  policyPatch,
  workspaceBlockSnapshot,
} from '@/components/settings/settingsForm'
import SettingsSection from '@/components/settings/SettingsSection.vue'
import SettingsShell from '@/components/settings/SettingsShell.vue'
import AppButton from '@/components/ui/AppButton.vue'
import FieldGroup from '@/components/ui/FieldGroup.vue'
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
const notificationDefaults = computed(() => workspace.notifications.value?.defaults ?? null)
const destinationStatuses = computed(() => workspace.notifications.value?.destinations ?? [])
const logsDir = computed(() => workspace.logsDir.value)

/** Only fields that differ from what the workspace currently holds. */
const patch = computed<WorkspaceSettingsPatch>(() => {
  const out: WorkspaceSettingsPatch = {}
  const defaults = defaultsView.value
  const logs = logsConfig.value

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
  // The general block merges; the destination list is replaced when it changed at all.
  const policy = notificationDefaults.value
  const notifications: Record<string, unknown> = {}
  if (policy !== null) {
    const diff = policyPatch(policy, form.policy)
    if (diff !== null)
      Object.assign(notifications, diff)
  }
  const list = destinationsPatch(destinationStatuses.value, form.destinations)
  if (list !== null)
    Object.assign(notifications, list)
  if (Object.keys(notifications).length > 0)
    out.notifications = notifications as WorkspaceSettingsPatch['notifications']
  return out
})

const changedCount = computed(() => countLeaves(patch.value as Record<string, unknown>) + (ddnsPatch.value === null ? 0 : countLeaves(ddnsPatch.value as Record<string, unknown>)))

/** What every patch compares against, keyed the way the patch is. */
const currentSnapshot = computed<Record<string, unknown>>(() => {
  const policy = notificationDefaults.value
  return {
    defaults: defaultsView.value ?? {},
    logs: logsConfig.value ?? {},
    notifications: policy === null ? {} : { defaults: policyBaseline(policy), destinations: destinationStatuses.value.map(destinationBaseline) },
    ddns: ddnsBaseline.value ?? {},
  }
})

const changes = computed(() => describeChanges({ ...(patch.value as Record<string, unknown>), ...(ddnsPatch.value === null ? {} : { ddns: ddnsPatch.value }) }, currentSnapshot.value))

const defaultsDirty = computed(() => defaultsView.value !== null && Object.keys(defaultsPatch(defaultsView.value, form.defaults)).length > 0)
const logsDirty = computed(() => logsConfig.value !== null && Object.keys(logsPatch(logsConfig.value, form.logs)).length > 0)
const notificationsDirty = computed(() => notificationDefaults.value !== null
  && (policyPatch(notificationDefaults.value, form.policy) !== null
    || destinationsPatch(destinationStatuses.value, form.destinations) !== null))

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

  const policy = notificationDefaults.value
  if (policy !== null) {
    fill('notifications', () => {
      Object.assign(form.policy, policyBaseline(policy))
      // The list belongs to the same block: one guard, so one half cannot save while the other
      // stays stale.
      form.destinations = destinationStatuses.value.map(destinationBaseline)
    })
  }
}

function forgetSnapshots(): void {
  for (const key of Object.keys(snapshots))
    delete snapshots[key as WorkspaceFormBlock]
}

watch([defaultsView, logsConfig, notificationDefaults], () => {
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

function resetNotifications(): void {
  if (notificationDefaults.value !== null) {
    Object.assign(form.policy, policyBaseline(notificationDefaults.value))
    form.destinations = destinationStatuses.value.map(destinationBaseline)
  }
  remember('notifications')
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
      <!-- The general block: the policy every destination follows unless it carries its own. -->
      <FieldGroup
        :title="t('settings.destination.generalTitle')"
        :description="t('settings.destination.generalDescription')"
        :columns="1"
      >
        <template #actions>
          <AppButton size="xs" variant="ghost" :disabled="!notificationsDirty" @click="resetNotifications">
            {{ t('common.reset') }}
          </AppButton>
        </template>
        <NotificationPolicyFields v-model="form.policy" />
      </FieldGroup>
      <DestinationsSection
        v-model:destinations="form.destinations"
        :statuses="destinationStatuses"
        :dirty="notificationsDirty"
        @reset="resetNotifications"
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
