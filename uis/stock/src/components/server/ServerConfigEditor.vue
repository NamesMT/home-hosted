<script setup lang="ts">
import type { HealthConfig, RestartConfig, ServerConfig, StopConfig } from '@shared/contracts'
import { serverPatchSchema } from '@shared/contracts'
import { diffServerConfig } from '@shared/patch-diff'
import { type } from 'arktype'
import { computed, reactive, ref, watch } from 'vue'
import LifecycleFields from '@/components/server/LifecycleFields.vue'
import FieldGroup from '@/components/ui/FieldGroup.vue'
import NumberField from '@/components/ui/NumberField.vue'
import SelectField from '@/components/ui/SelectField.vue'
import TextAreaField from '@/components/ui/TextAreaField.vue'
import TextField from '@/components/ui/TextField.vue'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import { useControlPlane } from '@/composables/useControlPlane'

const props = defineProps<{
  serverId: string
  config: ServerConfig
}>()

const emit = defineEmits<{ saved: [], cancel: [] }>()

/** Nested groups whose patch is merged sub-key by sub-key by the store. */
const NESTED = ['restart', 'health', 'stop'] as const

const control = useControlPlane()

const saving = ref(false)
const error = ref<string | null>(null)

function linesToArray(value: string): string[] {
  return value.split('\n').map(entry => entry.trim()).filter(entry => entry.length > 0)
}

function envToText(env: Record<string, string>): string {
  return Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n')
}

function textToEnv(value: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of linesToArray(value)) {
    const separator = line.indexOf('=')
    if (separator <= 0)
      continue
    env[line.slice(0, separator).trim()] = line.slice(separator + 1).trim()
  }
  return env
}

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
  dependsOn: string
  envFile: string
  maxRssMb: number | null
  port: number | null
  bind: string
  onPortConflict: 'block' | 'warn' | 'adopt'
  logBufferLines: number | null
  enabled: boolean
  autostart: boolean
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
    dependsOn: config.dependsOn.join(', '),
    envFile: config.envFile,
    maxRssMb: megabytes(config.resources.maxRssBytes),
    port: config.port,
    bind: config.bind,
    onPortConflict: config.onPortConflict,
    logBufferLines: config.logBufferLines,
    enabled: config.enabled,
    autostart: config.autostart,
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
const health = ref<HealthConfig>({ ...props.config.health })
const stop = ref<StopConfig>({ ...props.config.stop })

/** The exact object the last save sent, so "unsaved changes" survives a parent refresh. */
let baseline: Record<string, unknown> = { ...props.config }

/** An explicit IPv4 the config already carries is kept selectable rather than dropped. */
const bindOptions = computed(() => {
  const options = [
    { value: 'local', label: 'local — 127.0.0.1' },
    { value: 'lan', label: 'lan — 0.0.0.0' },
  ]
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(props.config.bind))
    options.push({ value: props.config.bind, label: `${props.config.bind} — explicit` })
  return options
})

function buildPayload(): Record<string, unknown> {
  // A non-nullable NumberField yields NaN while it is being cleared.
  const maxRssMb = Number.isFinite(form.maxRssMb) ? form.maxRssMb! : 0
  const logBufferLines = Number.isFinite(form.logBufferLines) ? form.logBufferLines! : 0
  const bootstrapTimeoutMs = Number.isFinite(form.bootstrapTimeoutMs) ? form.bootstrapTimeoutMs! : 0

  return {
    label: form.label.trim(),
    command: form.command.trim(),
    cwd: form.cwd.trim() === '' ? '.' : form.cwd.trim(),
    args: linesToArray(form.args),
    env: textToEnv(form.env),
    dataEnvs: textToEnv(form.dataEnvs),
    backupPaths: linesToArray(form.backupPaths),
    dependsOn: form.dependsOn.split(',').map(entry => entry.trim()).filter(entry => entry.length > 0),
    envFile: form.envFile.trim(),
    resources: { maxRssBytes: maxRssMb > 0 ? Math.round(maxRssMb * 1024 * 1024) : 0 },
    port: form.port === null || Number.isNaN(form.port) ? null : form.port,
    bind: form.bind,
    onPortConflict: form.onPortConflict,
    logBufferLines,
    enabled: form.enabled,
    autostart: form.autostart,
    restart: { ...restart.value },
    health: { ...health.value },
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
  const scope: typeof NESTED[number][] = ['restart', 'health', 'stop']
  for (const group of scope) {
    if (groupPatch(payload, group) === null)
      delete payload[group]
  }
  return diffServerConfig(props.config, payload)
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}

const changed = computed(() => {
  const payload = buildPayload()
  let count = 0
  for (const [key, value] of Object.entries(payload)) {
    if (NESTED.includes(key as typeof NESTED[number]))
      count += groupPatch(payload, key as typeof NESTED[number]) === null ? 0 : 1
    else if (!same(baseline[key], value))
      count += 1
  }
  return count
})

const canSave = computed(() => changed.value > 0)

/** The inbound config the form was last synced to, so a state refresh does not wipe unsaved edits. */
let source: ServerConfig = { ...props.config }

function resetFrom(config: ServerConfig): void {
  Object.assign(form, formFrom(config))
  restart.value = { ...config.restart }
  health.value = { ...config.health }
  stop.value = { ...config.stop }
  baseline = { ...config }
  source = { ...config }
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

    const patch = buildDiff(payload)
    if (Object.keys(patch).length === 0) {
      emit('saved')
      return
    }

    await control.saveConfig(props.serverId, patch)
    if (control.lastError.value !== null) {
      error.value = control.lastError.value
      return
    }

    baseline = { ...payload }
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
          Edit configuration
        </h2>
        <p class="mt-0.5 text-2xs leading-4 text-muted">
          Writes overrides to <span class="font-mono">servers.config.json</span>; anything left alone keeps inheriting the defaults.
        </p>
      </div>
      <div class="flex items-center gap-2">
        <span v-if="changed > 0" class="text-2xs text-warn">
          {{ changed }} unsaved {{ changed === 1 ? 'change' : 'changes' }}
        </span>
        <span v-else class="text-2xs text-faint">in sync</span>
      </div>
    </header>

    <div class="flex flex-col gap-3">
      <FieldGroup
        title="Process"
        description="What gets spawned, where, and with which environment."
        :columns="2"
      >
        <TextField v-model="form.label" label="Label" placeholder="falls back to the id" />
        <TextField v-model="form.command" label="Command" placeholder="node" required class="font-mono text-xs" />
        <TextField v-model="form.cwd" label="Working directory" placeholder="." hint="Relative paths resolve under projectDir." class="font-mono text-xs" />
        <TextField v-model="form.envFile" label="Env file" placeholder="optional KEY=value file" hint="Loaded at spawn; its values override env." class="font-mono text-xs" />
        <TextAreaField
          v-model="form.args"
          label="Arguments"
          :rows="3"
          hint="One per line; {port} {host} {home} {projectDir} {dataRoot} {id} {label} {cwd} {bind} {lanIp} are substituted."
          placeholder="-p&#10;{port}"
        />
        <TextAreaField
          v-model="form.env"
          label="Environment"
          :rows="3"
          hint="KEY=value per line, exported to the process."
          placeholder="NODE_ENV=production"
        />
        <TextAreaField
          v-model="form.dataEnvs"
          label="Data envs"
          :rows="3"
          hint="ENV=path per line — exported to the process and backed up automatically."
          placeholder="DATA_DIR={home}/.app"
        />
        <TextAreaField
          v-model="form.backupPaths"
          label="Extra backup paths"
          :rows="2"
          hint="One per line, placeholders allowed."
          placeholder="{home}/.app/uploads"
        />
        <TextField v-model="form.dependsOn" label="Depends on" placeholder="postgres, redis" hint="Comma separated; started first, stopped last." class="font-mono text-xs" />
        <NumberField v-model="form.maxRssMb" label="Max RSS (MB)" :min="0" hint="Restart above this; blank or 0 disables it." />
      </FieldGroup>

      <FieldGroup
        title="Port &amp; binding"
        description="How the port is preflighted and where the process is reachable."
        :columns="2"
      >
        <NumberField v-model="form.port" label="Port" nullable :min="1" :max="65535" hint="Blank means no port: no probe, no preflight." />
        <SelectField
          v-model="form.bind"
          label="Bind address"
          :options="bindOptions"
          hint="A custom IPv4 the config already sets stays selectable."
        />
        <SelectField
          v-model="form.onPortConflict"
          label="On port conflict"
          :options="[
            { value: 'block', label: 'block — refuse to start' },
            { value: 'warn', label: 'warn — start anyway' },
            { value: 'adopt', label: 'adopt — follow a detached restart of itself' },
          ]"
        />
        <NumberField v-model="form.logBufferLines" label="Log buffer lines" :min="50" :max="100000" :step="50" />
      </FieldGroup>

      <FieldGroup
        title="Lifecycle"
        description="Whether the supervisor owns this entry at all."
        :columns="2"
      >
        <ToggleSwitch v-model="form.enabled" label="Enabled" hint="Shows up and can be started at all." />
        <ToggleSwitch v-model="form.autostart" label="Autostart with up" hint="Started when the control plane comes up." />
      </FieldGroup>

      <LifecycleFields
        v-model:restart="restart"
        v-model:health="health"
        v-model:stop="stop"
      />

      <FieldGroup
        title="Bootstrap"
        description="A one-off command run before the first start — installs, migrations, downloads."
        :columns="2"
      >
        <ToggleSwitch
          v-model="form.bootstrapEnabled"
          label="Run a bootstrap"
          hint="Off means the entry has none and the key is sent as null."
          wide
        />
        <template v-if="form.bootstrapEnabled">
          <TextField
            v-model="form.bootstrapCommand"
            label="Command"
            placeholder="./scripts/install.sh"
            class="font-mono text-xs"
          />
          <NumberField v-model="form.bootstrapTimeoutMs" label="Timeout (ms)" :min="1000" :step="1000" />
          <ToggleSwitch v-model="form.bootstrapRunOnce" label="Only once per session" hint="Off means every start re-runs it." />
        </template>
        <TextAreaField
          v-if="form.bootstrapEnabled"
          v-model="form.bootstrapArgs"
          label="Bootstrap arguments"
          :rows="2"
          hint="One per line; same placeholders as the main arguments."
        />
        <TextAreaField
          v-if="form.bootstrapEnabled"
          v-model="form.bootstrapEnv"
          label="Bootstrap environment"
          :rows="2"
          hint="KEY=value per line, exported to the bootstrap process only."
        />
      </FieldGroup>
    </div>

    <p v-if="error" class="mt-3 rounded-control border border-danger/40 bg-danger-soft px-2.5 py-1.5 font-mono text-2xs leading-4 text-danger">
      {{ error }}
    </p>

    <div class="mt-4 flex items-center justify-end gap-2 border-t border-line pt-3.5">
      <button
        type="button"
        class="inline-flex h-8 select-none items-center rounded-control border border-transparent bg-transparent px-2.5 text-xs font-medium whitespace-nowrap text-muted transition-colors duration-150 hover:bg-hover hover:text-ink"
        @click="emit('cancel')"
      >
        Cancel
      </button>
      <button
        type="submit"
        :disabled="saving || !canSave"
        class="inline-flex h-8 select-none items-center gap-1.5 rounded-control border border-transparent bg-accent px-2.5 text-xs font-medium whitespace-nowrap text-accent-ink transition-[filter,opacity] duration-150 hover:brightness-110 disabled:pointer-events-none disabled:opacity-45"
      >
        {{ saving ? 'Saving…' : 'Save to servers.config.json' }}
      </button>
    </div>
  </form>
</template>
