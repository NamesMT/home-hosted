<script setup lang="ts">
import type { HealthConfig, RestartConfig, ServerDefaults, StopConfig } from '@shared/contracts'
import { serverCreateSchema } from '@shared/contracts'
import { type } from 'arktype'
import { nextTick, reactive, ref, watch } from 'vue'
import LifecycleFields from '@/components/LifecycleFields.vue'
import { useControlPlane } from '@/composables/useControlPlane'
import { flash, selectedId } from '@/composables/useUi'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const control = useControlPlane()
const error = ref<string | null>(null)
const busy = ref(false)
const idField = ref<HTMLInputElement | null>(null)

/** Schema constants, only until the panel defaults have landed. */
const SCHEMA_RESTART: RestartConfig = { enabled: true, maxRetries: 3, baseDelayMs: 1000, factor: 2, maxDelayMs: 30000, resetAfterMs: 60000 }
const SCHEMA_HEALTH: HealthConfig = {
  enabled: true,
  mode: 'port',
  http: { path: '/', method: 'GET', expectStatusBelow: 400, expectBody: '' },
  intervalMs: 5000,
  timeoutMs: 1500,
  unhealthyThreshold: 3,
  forceRestartAfterMs: 0,
  startTimeoutMs: 20000,
}
const SCHEMA_STOP: StopConfig = { signal: 'SIGTERM', killGroup: true, graceMs: 5000, killPortHolders: false }

function cloneHealth(health: HealthConfig): HealthConfig {
  return { ...health, http: { ...health.http } }
}

function blank(defaults: ServerDefaults | null) {
  return {
    id: '',
    label: '',
    command: '',
    args: '',
    cwd: '',
    port: '',
    bind: defaults?.bind ?? 'local',
    autostart: defaults?.autostart ?? false,
    enabled: defaults?.enabled ?? true,
    env: '',
    dataEnvs: '',
    backupPaths: '',
    backupIgnoreGenerated: true,
    dependsOn: '',
    envFile: '',
    maxRssMb: '',
    onPortConflict: defaults?.onPortConflict ?? 'block',
    logBufferLines: '',
    restart: { ...(defaults?.restart ?? SCHEMA_RESTART) },
    health: cloneHealth(defaults?.health ?? SCHEMA_HEALTH),
    stop: { ...(defaults?.stop ?? SCHEMA_STOP) },
    bootstrapEnabled: false,
    bootstrapCommand: '',
    bootstrapArgs: '',
    bootstrapEnv: '',
    bootstrapTimeoutMs: '',
    bootstrapRunOnce: true,
  }
}

const form = reactive(blank(control.defaults.value))

function linesToArray(value: string): string[] {
  return value.split('\n').map(entry => entry.trim()).filter(entry => entry.length > 0)
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

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function reset(): void {
  Object.assign(form, blank(control.defaults.value))
}

watch(() => props.open, async (open) => {
  if (!open)
    return
  error.value = null
  // Every open starts equal to what the entry would inherit.
  reset()
  await nextTick()
  idField.value?.focus()
})

function buildPayload(): Record<string, unknown> {
  const rssMb = form.maxRssMb.trim()
  const bufferLines = form.logBufferLines.trim()
  const bootstrapMs = Number(form.bootstrapTimeoutMs)
  const defaults = control.defaults.value

  const payload: Record<string, unknown> = {
    id: form.id.trim(),
    label: form.label.trim(),
    command: form.command.trim(),
    args: linesToArray(form.args),
    cwd: form.cwd.trim().length > 0 ? form.cwd.trim() : '.',
    env: textToEnv(form.env),
    dataEnvs: textToEnv(form.dataEnvs),
    backupPaths: linesToArray(form.backupPaths),
    backupIgnoreGenerated: form.backupIgnoreGenerated,
    dependsOn: form.dependsOn.split(',').map(entry => entry.trim()).filter(entry => entry.length > 0),
    envFile: form.envFile.trim(),
    resources: { maxRssBytes: rssMb === '' ? 0 : Math.round(Number(rssMb) * 1024 * 1024) },
    onPortConflict: form.onPortConflict,
    port: form.port.trim() === '' ? null : Number(form.port),
    bind: form.bind,
    enabled: form.enabled,
    autostart: form.autostart,
  }

  // Blank means inherited; 0 is below the schema's floor, so the key stays out.
  if (bufferLines !== '')
    payload.logBufferLines = Number(bufferLines)

  // A policy group the person left alone keeps inheriting the panel defaults
  // instead of freezing today's values into servers.config.json.
  if (defaults === null || !same(form.restart, defaults.restart))
    payload.restart = { ...form.restart }
  if (defaults === null || !same(form.health, defaults.health))
    payload.health = cloneHealth(form.health)
  if (defaults === null || !same(form.stop, defaults.stop))
    payload.stop = { ...form.stop }

  if (form.bootstrapEnabled) {
    payload.bootstrap = {
      command: form.bootstrapCommand.trim(),
      args: linesToArray(form.bootstrapArgs),
      env: textToEnv(form.bootstrapEnv),
      timeoutMs: Number.isFinite(bootstrapMs) && bootstrapMs >= 1000 ? bootstrapMs : 120000,
      runOnce: form.bootstrapRunOnce,
    }
  }

  return payload
}

async function submit(): Promise<void> {
  error.value = null

  if (!/^[a-z0-9][a-z0-9_-]*$/.test(form.id.trim())) {
    error.value = 'id must start with a lowercase letter or digit, then letters, digits, dash or underscore'
    return
  }
  if (form.command.trim().length === 0) {
    error.value = 'a command is required'
    return
  }
  if (form.bootstrapEnabled && form.bootstrapCommand.trim().length === 0) {
    error.value = 'a bootstrap needs a command to run'
    return
  }

  // The schema is the single validator: a bad number reads like a real message
  // instead of coming back as a 400 from the panel.
  const parsed = serverCreateSchema(buildPayload())
  if (parsed instanceof type.errors) {
    error.value = parsed.summary
    return
  }

  busy.value = true
  try {
    await control.create(parsed)

    if (control.lastError.value !== null) {
      error.value = control.lastError.value
      return
    }

    selectedId.value = parsed.id
    flash(`added ${parsed.id}`)
    reset()
    emit('close')
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <div v-if="open" class="overlay" @click.self="emit('close')">
    <div class="overlay__panel overlay__panel--sheet dialog" role="dialog" aria-label="add a server">
      <div class="overlay__head">
        <span class="overlay__title">add server</span>
        <span class="view__spacer" />
        <span class="faint">writes to servers.config.json</span>
        <kbd class="kbd">esc</kbd>
      </div>

      <form class="sheet__form" @submit.prevent="submit">
        <div class="overlay__body">
          <div class="grid">
            <label class="field">
              <span class="field__label">id</span>
              <input ref="idField" v-model="form.id" placeholder="my-server" required>
            </label>
            <label class="field">
              <span class="field__label">label</span>
              <input v-model="form.label" placeholder="falls back to the id">
            </label>
            <label class="field grid__full">
              <span class="field__label">command</span>
              <input v-model="form.command" placeholder="node" required>
            </label>
            <label class="field grid__full">
              <span class="field__label">args — space separated</span>
              <input v-model="form.args" placeholder="-p {port} -H {host}">
              <span class="field__hint">placeholders: {port} {host} {home} {projectDir} {dataRoot} {id} {label} {cwd} {bind} {lanIp}</span>
            </label>
            <label class="field">
              <span class="field__label">cwd</span>
              <input v-model="form.cwd" placeholder=".">
            </label>
            <label class="field">
              <span class="field__label">port</span>
              <input v-model="form.port" inputmode="numeric" placeholder="empty = none">
            </label>
            <label class="field">
              <span class="field__label">bind</span>
              <select v-model="form.bind">
                <option value="local">local (127.0.0.1)</option>
                <option value="lan">lan (0.0.0.0)</option>
              </select>
            </label>
            <label class="field field--check">
              <input v-model="form.autostart" type="checkbox">
              <span class="field__label">autostart with up</span>
            </label>
          </div>

          <details class="advanced">
            <summary class="advanced__summary">
              advanced
            </summary>
            <p class="field__hint advanced__note">
              restart, health, stop and bootstrapping start equal to the panel defaults —
              change a group to write it into this entry; leave it alone and it keeps inheriting.
            </p>

            <div class="grid">
              <label class="field field--check">
                <input v-model="form.enabled" type="checkbox">
                <span class="field__label">enabled</span>
              </label>
              <label class="field">
                <span class="field__label">on port conflict</span>
                <select v-model="form.onPortConflict">
                  <option value="block">block</option>
                  <option value="warn">warn</option>
                  <option value="follow">follow</option>
                  <option value="reclaim">reclaim</option>
                </select>
              </label>
              <label class="field">
                <span class="field__label">log buffer lines</span>
                <input v-model="form.logBufferLines" inputmode="numeric" placeholder="inherited (500)">
              </label>
              <label class="field">
                <span class="field__label">max rss (MiB)</span>
                <input v-model="form.maxRssMb" inputmode="numeric" placeholder="empty = no guard">
              </label>
              <label class="field">
                <span class="field__label">env file</span>
                <input v-model="form.envFile" placeholder="empty = none">
              </label>
              <label class="field">
                <span class="field__label">depends on — comma separated ids</span>
                <input v-model="form.dependsOn" placeholder="db, cache">
              </label>
              <label class="field grid__full">
                <span class="field__label">env — KEY=value per line</span>
                <textarea v-model="form.env" rows="3" spellcheck="false" />
              </label>
              <label class="field grid__full">
                <span class="field__label">data envs — ENV=path per line</span>
                <textarea v-model="form.dataEnvs" rows="3" spellcheck="false" placeholder="DATA_DIR={home}/.app" />
                <span class="field__hint">exported to the process and picked up by backups automatically</span>
              </label>
              <label class="field grid__full">
                <span class="field__label">extra backup paths — one per line</span>
                <textarea v-model="form.backupPaths" rows="2" spellcheck="false" placeholder="{home}/.app/uploads" />
              </label>
              <label class="field field--check grid__full">
                <input v-model="form.backupIgnoreGenerated" type="checkbox">
                <span class="field__label">ignore known generated files when backing this up</span>
                <span class="field__hint">node_modules, dist, .next, caches — nothing restores from them</span>
              </label>
            </div>

            <LifecycleFields
              v-model:restart="form.restart"
              v-model:health="form.health"
              v-model:stop="form.stop"
            />

            <div class="group">
              <div class="group__head">
                <span class="group__title">bootstrap</span>
                <label class="field field--check" style="padding-top: 0">
                  <input v-model="form.bootstrapEnabled" type="checkbox">
                  <span class="field__label">run before the first start</span>
                </label>
              </div>
              <div class="grid">
                <label class="field">
                  <span class="field__label">command</span>
                  <input v-model="form.bootstrapCommand" :disabled="!form.bootstrapEnabled" placeholder="./scripts/install.sh">
                </label>
                <label class="field">
                  <span class="field__label">timeout (ms)</span>
                  <input v-model="form.bootstrapTimeoutMs" inputmode="numeric" :disabled="!form.bootstrapEnabled" placeholder="120000">
                </label>
                <label class="field field--check">
                  <input v-model="form.bootstrapRunOnce" type="checkbox" :disabled="!form.bootstrapEnabled">
                  <span class="field__label">once per up session</span>
                </label>
                <label class="field grid__full">
                  <span class="field__label">args — one per line</span>
                  <textarea v-model="form.bootstrapArgs" rows="2" spellcheck="false" :disabled="!form.bootstrapEnabled" />
                </label>
                <label class="field grid__full">
                  <span class="field__label">env — KEY=value per line</span>
                  <textarea v-model="form.bootstrapEnv" rows="2" spellcheck="false" :disabled="!form.bootstrapEnabled" />
                </label>
              </div>
            </div>
          </details>

          <p v-if="error" class="note note--error">
            {{ error }}
          </p>
        </div>

        <div class="group sheet__foot">
          <div class="actions">
            <button type="button" class="btn btn--sm" @click="emit('close')">
              cancel
            </button>
            <button type="submit" class="btn btn--sm btn--primary" :disabled="busy">
              add server
            </button>
          </div>
        </div>
      </form>
    </div>
  </div>
</template>
