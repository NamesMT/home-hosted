<script setup lang="ts">
import type { DdnsConfig, WorkspaceSettingsPatch } from '@shared/contracts'
import type { FormSnapshots, WorkspaceFormBlock, WorkspaceSettingsForm } from '@/components/settings/settingsForm'
import type { DraftConfig } from '@/lib/ddns'
import { countLeaves, describeChanges } from '@shared/patch-diff'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
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
  workspaceBlockSnapshot,
} from '@/components/settings/settingsForm'
import AppButton from '@/components/ui/AppButton.vue'
import Modal from '@/components/ui/Modal.vue'
import PageHeader from '@/components/ui/PageHeader.vue'
import { useControlPlane } from '@/composables/useControlPlane'
import { useToasts } from '@/composables/useToasts'
import { useWorkspaces } from '@/composables/useWorkspaces'
import * as api from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatChangeValue } from '@/lib/format'

/** Everything this page owns; the panel-wide settings live on `/global-settings`. */
const SECTIONS = [
  { id: 'defaults', title: 'Server defaults' },
  { id: 'logs', title: 'Logs' },
  { id: 'notifications', title: 'Notifications' },
  { id: 'ddns', title: 'Dynamic DNS' },
] as const

type SectionId = typeof SECTIONS[number]['id']

const route = useRoute()
const router = useRouter()
const control = useControlPlane()
const workspace = useWorkspaces()
const toasts = useToasts()

const form = reactive<WorkspaceSettingsForm>(createWorkspaceForm())

const active = ref<SectionId>('defaults')
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
const showChanges = ref(false)

const defaultsDirty = computed(() => defaultsView.value !== null && Object.keys(defaultsPatch(defaultsView.value, form.defaults)).length > 0)
const logsDirty = computed(() => logsConfig.value !== null && Object.keys(logsPatch(logsConfig.value, form.logs)).length > 0)
const telegramDirty = computed(() => telegramStatus.value !== null && Object.keys(telegramPatch(telegramStatus.value, form.telegram)).length > 0)

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
  if (telegram !== null)
    fill('telegram', () => Object.assign(form.telegram, telegramBaseline(telegram)))
}

function forgetSnapshots(): void {
  for (const key of Object.keys(snapshots))
    delete snapshots[key as WorkspaceFormBlock]
}

function remember(block: WorkspaceFormBlock): void {
  snapshots[block] = workspaceBlockSnapshot(form, block)
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
        saveError.value = control.lastError.value ?? 'The settings could not be saved.'
        return
      }
    }
    if (ddns !== null) {
      await api.saveDdns(workspace.activeId.value, ddns)
      await ddnsSection.value?.reload()
    }
    saveMessage.value = 'Workspace settings saved.'
    toasts.success('Workspace settings saved')
    forgetSnapshots()
    syncFromLive()
  }
  catch (caught) {
    saveError.value = caught instanceof Error ? caught.message : String(caught)
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
  if (telegramStatus.value !== null)
    Object.assign(form.telegram, telegramBaseline(telegramStatus.value))
  remember('telegram')
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

// A workspace switch replaces every block on this page with a new workspace's own.
watch(() => workspace.activeId.value, () => {
  forgetSnapshots()
  syncFromLive()
  saveError.value = null
  saveMessage.value = null
})

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
      <PageHeader
        title="Workspace settings"
        :description="`Server defaults, log retention, notifications and dynamic DNS for ${workspace.selected.value?.label ?? 'this workspace'}.`"
      />

      <Notice v-if="workspace.configError.value" tone="danger" title="The workspace config could not be read" class="mb-4">
        <p>{{ workspace.configError.value }}</p>
        <p class="mt-1">
          The panel keeps supervising with the config it already had; fixing the file reloads it on its own.
        </p>
      </Notice>
      <Notice v-else-if="workspace.configWarnings.value.length > 0" tone="warn" title="This workspace's config has a warning" class="mb-4">
        <p v-for="warning in workspace.configWarnings.value" :key="warning" class="font-mono">
          {{ warning }}
        </p>
      </Notice>

      <div class="lg:grid lg:grid-cols-[11rem_minmax(0,1fr)] lg:gap-8">
        <nav aria-label="Workspace settings sections" class="hidden lg:block">
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
          <section id="defaults" class="scroll-mt-5">
            <header class="mb-3">
              <h2 class="text-lg font-semibold text-ink">
                Server defaults
              </h2>
              <p class="mt-0.5 text-xs text-muted">
                Applied to every entry in this workspace that does not set its own value.
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
                How much output this workspace keeps on disk and for how long.
              </p>
            </header>
            <LogsSection
              v-model:logs="form.logs"
              :logs-dir="logsDir"
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
                Crash and health alerts for this workspace, sent to a Telegram chat.
              </p>
            </header>
            <NotificationsSection
              v-model:telegram="form.telegram"
              :status="telegramStatus"
              :dirty="telegramDirty"
              @reset="resetTelegram"
            />
          </section>

          <section id="ddns" class="scroll-mt-5">
            <header class="mb-3">
              <h2 class="text-lg font-semibold text-ink">
                Dynamic DNS
              </h2>
              <p class="mt-0.5 text-xs text-muted">
                Keep hostnames pointed at this machine's public address, whichever registrar holds them.
              </p>
            </header>
            <DdnsSection
              ref="ddnsSection"
              v-model:patch="ddnsPatch"
              v-model:baseline="ddnsBaseline"
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

  <Modal v-model:open="showChanges" title="Unsaved changes" :description="`What Save would write to ${workspace.selected.value?.label ?? 'this workspace'}'s settings.`" width="w-[min(92vw,42rem)]">
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
