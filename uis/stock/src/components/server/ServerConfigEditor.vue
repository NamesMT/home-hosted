<script setup lang="ts">
import type { HealthConfig, OnPortConflict, RestartConfig, ServerConfig, StopConfig } from '@shared/contracts'
import type { Patch } from '@shared/patch-diff'
import { serverPatchSchema } from '@shared/contracts'
import { countLeaves, describeChanges, diffServerConfig } from '@shared/patch-diff'
import { type } from 'arktype'
import { computed, reactive, ref, watch } from 'vue'
import LifecycleFields from '@/components/server/LifecycleFields.vue'
import { cloneHealth } from '@/components/settings/settingsForm'
import AppButton from '@/components/ui/AppButton.vue'
import FieldGroup from '@/components/ui/FieldGroup.vue'
import Modal from '@/components/ui/Modal.vue'
import NumberField from '@/components/ui/NumberField.vue'
import SelectField from '@/components/ui/SelectField.vue'
import TextAreaField from '@/components/ui/TextAreaField.vue'
import TextField from '@/components/ui/TextField.vue'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import TransText from '@/components/ui/TransText.vue'
import { useControlPlane } from '@/composables/useControlPlane'
import { t, tc } from '@/i18n'
import { commaList, envToText, linesToArray, textToEnv } from '@/lib/fields'
import { formatChangeValue } from '@/lib/format'

const props = defineProps<{
  serverId: string
  /** The workspace that owns the entry; the patch is scoped to it. */
  workspaceId: string
  config: ServerConfig
}>()

const emit = defineEmits<{ saved: [], cancel: [] }>()

/** Nested groups whose patch is merged sub-key by sub-key by the store. */
const NESTED = ['restart', 'health', 'stop'] as const

const control = useControlPlane()

const saving = ref(false)
const error = ref<string | null>(null)

function megabytes(bytes: number): number | null {
  return bytes > 0 ? Math.round(bytes / 1024 / 1024) : null
}

interface EditorForm {
  label: string
  command: string
  cwd: string
  args: string
  env: string
  dataEnvs: string
  backupPaths: string
  backupIgnoreGenerated: boolean
  dependsOn: string
  envFile: string
  maxRssMb: number | null
  port: number | null
  bind: string
  onPortConflict: OnPortConflict
  logBufferLines: number | null
  enabled: boolean
  autostart: boolean
  persistent: boolean
  bootstrapEnabled: boolean
  bootstrapCommand: string
  bootstrapArgs: string
  bootstrapEnv: string
  bootstrapTimeoutMs: number | null
  bootstrapRunOnce: boolean
}

/** Text stays text, numbers stay numbers, and a blank numeric field stays blank rather than 0. */
function formFrom(config: ServerConfig): EditorForm {
  return {
    label: config.label ?? '',
    command: config.command,
    cwd: config.cwd,
    args: config.args.join('\n'),
    env: envToText(config.env),
    dataEnvs: envToText(config.dataEnvs),
    backupPaths: config.backupPaths.join('\n'),
    // Absent in a payload from a panel that predates the field: the default is on.
    backupIgnoreGenerated: config.backupIgnoreGenerated !== false,
    dependsOn: config.dependsOn.join(', '),
    envFile: config.envFile,
    maxRssMb: megabytes(config.resources.maxRssBytes),
    port: config.port,
    bind: config.bind,
    onPortConflict: config.onPortConflict,
    logBufferLines: config.logBufferLines,
    enabled: config.enabled,
    autostart: config.autostart,
    // Absent in a payload from a panel that predates the field: the default is off.
    persistent: config.persistent === true,
    bootstrapEnabled: config.bootstrap !== null && config.bootstrap !== undefined,
    bootstrapCommand: config.bootstrap?.command ?? '',
    bootstrapArgs: (config.bootstrap?.args ?? []).join('\n'),
    bootstrapEnv: envToText(config.bootstrap?.env ?? {}),
    bootstrapTimeoutMs: config.bootstrap?.timeoutMs ?? 120000,
    bootstrapRunOnce: config.bootstrap?.runOnce ?? true,
  }
}

const form = reactive<EditorForm>(formFrom(props.config))
const restart = ref<RestartConfig>({ ...props.config.restart })
// A shallow copy would still alias the live `health.http`, which the frame guard compares against.
const health = ref<HealthConfig>(cloneHealth(props.config.health))
const stop = ref<StopConfig>({ ...props.config.stop })

/** An explicit IPv4 the config already carries is kept selectable rather than dropped. */
const bindOptions = computed(() => {
  const options = [
    { value: 'local', label: t('bind.local') },
    { value: 'lan', label: t('bind.lan') },
  ]
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(props.config.bind))
    options.push({ value: props.config.bind, label: t('bind.explicit', { bind: props.config.bind }) })
  return options
})

function buildPayload(): Record<string, unknown> {
  // A non-nullable NumberField yields NaN while it is being cleared; the log
  // buffer has a floor of its own, and 0 would be rejected outright.
  const maxRssMb = Number.isFinite(form.maxRssMb) ? form.maxRssMb! : 0
  const logBufferLines = Number.isFinite(form.logBufferLines) && form.logBufferLines! >= 50 ? form.logBufferLines! : 50
  const bootstrapTimeoutMs = Number.isFinite(form.bootstrapTimeoutMs) ? form.bootstrapTimeoutMs! : 0

  return {
    // An emptied label sends **null**, which removes the key, so every display falls back to the id — which
    // is what the field's own label promises. Sending `label: ''` stored an empty string instead, and
    // `label ?? id` does not fire on an empty string, so the card went blank and a notification read
    // ` (web) crashed`. The add dialog omits the key for a new entry, which is right there: there is
    // nothing to clear yet.
    label: form.label.trim().length === 0 ? null : form.label.trim(),
    command: form.command.trim(),
    cwd: form.cwd.trim() === '' ? '.' : form.cwd.trim(),
    args: linesToArray(form.args),
    env: textToEnv(form.env),
    dataEnvs: textToEnv(form.dataEnvs),
    backupPaths: linesToArray(form.backupPaths),
    backupIgnoreGenerated: form.backupIgnoreGenerated,
    dependsOn: commaList(form.dependsOn),
    envFile: form.envFile.trim(),
    resources: { maxRssBytes: maxRssMb > 0 ? Math.round(maxRssMb * 1024 * 1024) : 0 },
    port: form.port === null || Number.isNaN(form.port) ? null : form.port,
    bind: form.bind,
    onPortConflict: form.onPortConflict,
    logBufferLines,
    enabled: form.enabled,
    autostart: form.autostart,
    persistent: form.persistent,
    restart: { ...restart.value },
    health: cloneHealth(health.value),
    stop: { ...stop.value },
    bootstrap: form.bootstrapEnabled
      ? {
          command: form.bootstrapCommand.trim(),
          args: linesToArray(form.bootstrapArgs),
          env: textToEnv(form.bootstrapEnv),
          timeoutMs: bootstrapTimeoutMs,
          runOnce: form.bootstrapRunOnce,
        }
      : null,
  }
}

/** Only the changed sub-keys: the store merges a nested group rather than replacing it. */
function groupPatch(payload: Record<string, unknown>, group: typeof NESTED[number]): Record<string, unknown> | null {
  const before = (props.config[group] ?? {}) as Record<string, unknown>
  const after = (payload[group] ?? {}) as Record<string, unknown>
  const changed: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(after)) {
    if (before[key] !== value)
      changed[key] = value
  }
  return Object.keys(changed).length > 0 ? changed : null
}

function buildDiff(payload: Record<string, unknown>): Record<string, unknown> {
  for (const group of NESTED) {
    if (groupPatch(payload, group) === null)
      delete payload[group]
  }
  return diffServerConfig(props.config, payload)
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}

/** Exactly what Save would write: the payload minus everything that did not change. */
const patch = computed(() => buildDiff(buildPayload()))

const changed = computed(() => countLeaves(patch.value))
const canSave = computed(() => changed.value > 0)

/** The pending patch as readable rows, for the review dialog. */
const changes = computed(() => describeChanges(patch.value, props.config as unknown as Patch))
const showChanges = ref(false)

/** The inbound config the form was last synced to, so a state refresh does not wipe unsaved edits. */
let source: ServerConfig = detach(props.config)

/** A detached copy: the form must never alias the live state this guard compares against. */
function detach(config: ServerConfig): ServerConfig {
  return JSON.parse(JSON.stringify(config)) as ServerConfig
}

function resetFrom(config: ServerConfig): void {
  Object.assign(form, formFrom(config))
  restart.value = { ...config.restart }
  health.value = cloneHealth(config.health)
  stop.value = { ...config.stop }
  source = detach(config)
  error.value = null
}

watch(() => props.config, (next) => {
  // The control plane re-creates every config object on each state refresh; only
  // a genuine change replaces what the user has typed so far.
  if (!same(next, source))
    resetFrom(next)
})

async function save(): Promise<void> {
  error.value = null
  saving.value = true
  try {
    const payload = buildPayload()

    const parsed = serverPatchSchema(payload)
    if (parsed instanceof type.errors) {
      error.value = parsed.summary
      return
    }

    const pending = buildDiff(payload)
    if (Object.keys(pending).length === 0) {
      emit('saved')
      return
    }

    await control.saveConfig(props.workspaceId, props.serverId, pending)
    if (control.lastError.value !== null) {
      error.value = control.lastError.value
      return
    }

    emit('saved')
  }
  finally {
    saving.value = false
  }
}
</script>

<template>
  <form class="border-t border-line bg-page/40 px-4 py-4" @submit.prevent="save">
    <header class="mb-4 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <div class="min-w-0">
        <h2 class="text-sm font-semibold text-ink">
          {{ t('editor.title') }}
        </h2>
        <p class="mt-0.5 text-2xs leading-4 text-muted">
          <TransText k="editor.description">
            <template #file>
              <span class="font-mono">servers.config.json</span>
            </template>
          </TransText>
        </p>
      </div>
      <div class="flex items-center gap-2">
        <button
          v-if="changed > 0"
          type="button"
          class="rounded-control px-1 py-0.5 text-2xs text-warn underline decoration-warn/40 underline-offset-2 transition-colors duration-150 hover:text-ink"
          @click="showChanges = true"
        >
          <span class="font-mono tabular-nums">{{ changed }}</span>
          {{ tc('editor.unsaved', changed) }}
        </button>
        <span v-else class="text-2xs text-faint">{{ t('editor.inSync') }}</span>
      </div>
    </header>

    <div class="flex flex-col gap-3">
      <FieldGroup
        :title="t('editor.process')"
        :description="t('editor.processDescription')"
        :columns="2"
      >
        <TextField v-model="form.label" :label="t('common.label')" :placeholder="t('editor.labelPlaceholder')" />
        <TextField v-model="form.command" :label="t('common.command')" placeholder="node" required class="font-mono text-xs" />
        <TextField v-model="form.cwd" :label="t('serverForm.workingDirectory')" placeholder="." :hint="t('serverForm.cwdHint')" class="font-mono text-xs" />
        <TextField v-model="form.envFile" :label="t('serverForm.envFile')" :placeholder="t('serverForm.envFilePlaceholder')" :hint="t('serverForm.envFileHint')" class="font-mono text-xs" />
        <TextAreaField
          v-model="form.args"
          :label="t('serverForm.arguments')"
          :rows="3"
          :hint="t('editor.argumentsHint')"
          placeholder="-p&#10;{port}"
        />
        <TextAreaField
          v-model="form.env"
          :label="t('common.environment')"
          :rows="3"
          :hint="t('serverForm.envHint')"
          placeholder="NODE_ENV=production"
        />
        <TextAreaField
          v-model="form.dataEnvs"
          :label="t('serverForm.dataEnvs')"
          :rows="3"
          :hint="t('serverForm.dataEnvsHint')"
          placeholder="DATA_DIR={home}/.app"
        />
        <TextAreaField
          v-model="form.backupPaths"
          :label="t('serverForm.backupPaths')"
          :rows="2"
          :hint="t('serverForm.backupPathsHint')"
          placeholder="{home}/.app/uploads"
        />
        <ToggleSwitch
          v-model="form.backupIgnoreGenerated"
          :label="t('serverForm.backupIgnore')"
          :hint="t('serverForm.backupIgnoreHint')"
          wide
        />
        <TextField v-model="form.dependsOn" :label="t('serverForm.dependsOn')" placeholder="postgres, redis" :hint="t('serverForm.dependsOnHint')" class="font-mono text-xs" />
        <NumberField v-model="form.maxRssMb" :label="t('serverForm.maxRssMb')" :min="0" :hint="t('serverForm.maxRssHint')" />
      </FieldGroup>

      <FieldGroup
        :title="t('editor.portTitle')"
        :description="t('editor.portDescription')"
        :columns="2"
      >
        <NumberField v-model="form.port" :label="t('common.port')" nullable :min="1" :max="65535" :hint="t('serverForm.portHint')" />
        <SelectField
          v-model="form.bind"
          :label="t('serverForm.bindAddress')"
          :options="bindOptions"
          :hint="t('editor.bindHint')"
        />
        <SelectField
          v-model="form.onPortConflict"
          :label="t('serverForm.onPortConflict')"
          :options="[
            { value: 'block', label: t('onPortConflict.block') },
            { value: 'warn', label: t('onPortConflict.warn') },
            { value: 'follow', label: t('onPortConflict.follow') },
            { value: 'reclaim', label: t('onPortConflict.reclaim') },
            { value: 'kill', label: t('onPortConflict.kill') },
          ]"
        />
        <NumberField v-model="form.logBufferLines" :label="t('serverForm.logBufferLines')" :min="50" :max="100000" :step="50" />
      </FieldGroup>

      <FieldGroup
        :title="t('editor.lifecycle')"
        :description="t('editor.lifecycleDescription')"
        :columns="3"
      >
        <ToggleSwitch v-model="form.enabled" :label="t('common.enabled')" :hint="t('serverForm.enabledHint')" />
        <ToggleSwitch v-model="form.autostart" :label="t('serverForm.autostart')" :hint="t('serverForm.autostartHint')" />
        <ToggleSwitch v-model="form.persistent" :label="t('serverForm.persistent')" :hint="t('serverForm.persistentHint')" />
      </FieldGroup>

      <LifecycleFields
        v-model:restart="restart"
        v-model:health="health"
        v-model:stop="stop"
      />

      <FieldGroup
        :title="t('serverForm.bootstrap')"
        :description="t('serverForm.bootstrapDescription')"
        :columns="2"
      >
        <ToggleSwitch
          v-model="form.bootstrapEnabled"
          :label="t('serverForm.runBootstrap')"
          :hint="t('serverForm.bootstrapHint')"
          wide
        />
        <template v-if="form.bootstrapEnabled">
          <TextField
            v-model="form.bootstrapCommand"
            :label="t('common.command')"
            placeholder="./scripts/install.sh"
            class="font-mono text-xs"
          />
          <NumberField v-model="form.bootstrapTimeoutMs" :label="t('serverForm.timeoutMs')" :min="1000" :step="1000" />
          <ToggleSwitch v-model="form.bootstrapRunOnce" :label="t('serverForm.runOnce')" :hint="t('serverForm.runOnceHint')" />
        </template>
        <TextAreaField
          v-if="form.bootstrapEnabled"
          v-model="form.bootstrapArgs"
          :label="t('serverForm.bootstrapArgs')"
          :rows="2"
          :hint="t('serverForm.bootstrapArgsHint')"
        />
        <TextAreaField
          v-if="form.bootstrapEnabled"
          v-model="form.bootstrapEnv"
          :label="t('serverForm.bootstrapEnv')"
          :rows="2"
          :hint="t('serverForm.bootstrapEnvHint')"
        />
      </FieldGroup>
    </div>

    <p v-if="error" class="mt-3 rounded-control border border-danger/40 bg-danger-soft px-2.5 py-1.5 font-mono text-2xs leading-4 text-danger">
      {{ error }}
    </p>

    <div class="mt-4 flex items-center justify-end gap-2 border-t border-line pt-3.5">
      <AppButton variant="ghost" @click="emit('cancel')">
        {{ t('common.cancel') }}
      </AppButton>
      <AppButton type="submit" variant="primary" :disabled="saving || !canSave" :loading="saving">
        {{ t('editor.save') }}
      </AppButton>
    </div>
  </form>

  <Modal
    v-model:open="showChanges"
    :title="t('editor.changesTitle')"
    :description="t('editor.changesDescription')"
    width="w-[min(92vw,42rem)]"
  >
    <div class="max-h-[60dvh] overflow-auto">
      <ul v-if="changes.length > 0" class="divide-y divide-line-soft">
        <li v-for="change in changes" :key="change.path" class="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 first:pt-0">
          <code class="font-mono text-xs text-ink">{{ change.path }}</code>
          <span class="ml-auto font-mono text-xs text-muted line-through">{{ formatChangeValue(change.from) }}</span>
          <span class="text-2xs text-faint">→</span>
          <span class="font-mono text-xs text-accent">{{ formatChangeValue(change.to) }}</span>
        </li>
      </ul>
      <p v-else class="text-xs text-muted">
        {{ t('editor.nothingToSave') }}
      </p>
    </div>
    <template #footer>
      <AppButton size="sm" variant="ghost" @click="showChanges = false">
        {{ t('common.close') }}
      </AppButton>
      <AppButton
        size="sm"
        variant="primary"
        :disabled="changes.length === 0 || saving"
        :loading="saving"
        @click="save(); showChanges = false"
      >
        {{ tc('editor.saveChanges', changes.length) }}
      </AppButton>
    </template>
  </Modal>
</template>
