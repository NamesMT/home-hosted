<script setup lang="ts">
import type { ServerConfig } from '@shared/contracts'
import type { Patch } from '@shared/patch-diff'
import { parseBind, serverPatchSchema } from '@shared/contracts'
import { countLeaves, describeChanges, diffServerConfig } from '@shared/patch-diff'
import { type } from 'arktype'
import { computed, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import ConfirmButton from '@/components/ConfirmButton.vue'
import StatusChip from '@/components/StatusChip.vue'
import { useControlPlane } from '@/composables/useControlPlane'
import { configChangesOpen, flash, selectedId } from '@/composables/useUi'

const props = defineProps<{ id: string }>()

const control = useControlPlane()
const router = useRouter()

const error = ref<string | null>(null)
const saving = ref(false)

const server = computed(() => control.serverById(props.id))
const config = computed<ServerConfig | null>(() => server.value?.config ?? null)

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

const form = reactive({
  label: '',
  command: '',
  args: '',
  cwd: '.',
  env: '',
  dataEnvs: '',
  backupPaths: '',
  backupIgnoreGenerated: true,
  port: '',
  bind: 'local',
  customBind: '',
  onPortConflict: 'block' as 'block' | 'warn' | 'follow' | 'reclaim',
  logBufferLines: '500',
  enabled: true,
  autostart: false,

  restartEnabled: true,
  maxRetries: '3',
  baseDelayMs: '1000',
  factor: '2',
  maxDelayMs: '30000',
  resetAfterMs: '60000',

  healthEnabled: true,
  healthMode: 'port' as 'port' | 'http',
  httpPath: '/',
  httpMethod: 'GET' as 'GET' | 'HEAD',
  httpExpectStatus: '',
  httpExpectStatusBelow: '400',
  httpExpectBody: '',
  intervalMs: '5000',
  timeoutMs: '1500',
  unhealthyThreshold: '3',
  forceRestartAfterMs: '0',
  startTimeoutMs: '20000',

  signal: 'SIGTERM' as 'SIGTERM' | 'SIGINT' | 'SIGKILL',
  killGroup: true,
  graceMs: '5000',
  killPortHolders: false,

  dependsOn: '',
  envFile: '',
  maxRssMb: '',

  bootstrapEnabled: false,
  bootstrapCommand: '',
  bootstrapArgs: '',
  bootstrapEnv: '',
  bootstrapTimeoutMs: '120000',
  bootstrapRunOnce: true,
})

/** The config the form was last loaded from; a live frame equal to it must not reload the form. */
let source: ServerConfig | null = null

function load(cfg: ServerConfig): void {
  const standard = cfg.bind === 'local' || cfg.bind === 'lan'
  Object.assign(form, {
    label: cfg.label ?? '',
    command: cfg.command,
    args: cfg.args.join('\n'),
    cwd: cfg.cwd,
    env: envToText(cfg.env),
    dataEnvs: envToText(cfg.dataEnvs),
    backupPaths: cfg.backupPaths.join('\n'),
    port: cfg.port === null ? '' : String(cfg.port),
    bind: standard ? cfg.bind : 'custom',
    customBind: standard ? '' : cfg.bind,
    onPortConflict: cfg.onPortConflict,
    logBufferLines: String(cfg.logBufferLines),
    enabled: cfg.enabled,
    autostart: cfg.autostart,
    restartEnabled: cfg.restart.enabled,
    maxRetries: String(cfg.restart.maxRetries),
    baseDelayMs: String(cfg.restart.baseDelayMs),
    factor: String(cfg.restart.factor),
    maxDelayMs: String(cfg.restart.maxDelayMs),
    resetAfterMs: String(cfg.restart.resetAfterMs),
    healthEnabled: cfg.health.enabled,
    healthMode: cfg.health.mode,
    httpPath: cfg.health.http.path,
    httpMethod: cfg.health.http.method,
    httpExpectStatus: cfg.health.http.expectStatus == null ? '' : String(cfg.health.http.expectStatus),
    httpExpectStatusBelow: String(cfg.health.http.expectStatusBelow),
    httpExpectBody: cfg.health.http.expectBody,
    intervalMs: String(cfg.health.intervalMs),
    timeoutMs: String(cfg.health.timeoutMs),
    unhealthyThreshold: String(cfg.health.unhealthyThreshold),
    forceRestartAfterMs: String(cfg.health.forceRestartAfterMs),
    startTimeoutMs: String(cfg.health.startTimeoutMs),
    signal: cfg.stop.signal,
    killGroup: cfg.stop.killGroup,
    graceMs: String(cfg.stop.graceMs),
    killPortHolders: cfg.stop.killPortHolders,
    dependsOn: cfg.dependsOn.join(', '),
    envFile: cfg.envFile,
    maxRssMb: cfg.resources.maxRssBytes > 0 ? String(Math.round(cfg.resources.maxRssBytes / 1024 / 1024)) : '',
    bootstrapEnabled: cfg.bootstrap !== null && cfg.bootstrap !== undefined,
    bootstrapCommand: cfg.bootstrap?.command ?? '',
    bootstrapArgs: (cfg.bootstrap?.args ?? []).join('\n'),
    bootstrapEnv: envToText(cfg.bootstrap?.env ?? {}),
    bootstrapTimeoutMs: String(cfg.bootstrap?.timeoutMs ?? 120000),
    bootstrapRunOnce: cfg.bootstrap?.runOnce ?? true,
    backupIgnoreGenerated: cfg.backupIgnoreGenerated !== false,
  })
  source = cfg
}

// The control plane rebuilds every config object on each state frame; only a
// genuine change may replace what the user has typed so far.
watch(config, (next) => {
  if (next && JSON.stringify(next) !== JSON.stringify(source))
    load(next)
}, { immediate: true })

const bindValue = computed(() => (form.bind === 'custom' ? form.customBind.trim() : form.bind))

function buildPayload(): Record<string, unknown> {
  const expectStatus = form.httpExpectStatus.trim()
  return {
    label: form.label.trim(),
    command: form.command.trim(),
    args: linesToArray(form.args),
    cwd: form.cwd.trim() === '' ? '.' : form.cwd.trim(),
    dependsOn: form.dependsOn.split(',').map(entry => entry.trim()).filter(entry => entry.length > 0),
    envFile: form.envFile.trim(),
    resources: { maxRssBytes: form.maxRssMb.trim() === '' ? 0 : Math.round(Number(form.maxRssMb) * 1024 * 1024) },
    env: textToEnv(form.env),
    dataEnvs: textToEnv(form.dataEnvs),
    backupPaths: linesToArray(form.backupPaths),
    backupIgnoreGenerated: form.backupIgnoreGenerated,
    port: form.port.trim() === '' ? null : Number(form.port),
    bind: bindValue.value,
    onPortConflict: form.onPortConflict,
    logBufferLines: Number(form.logBufferLines),
    enabled: form.enabled,
    autostart: form.autostart,
    restart: {
      enabled: form.restartEnabled,
      maxRetries: Number(form.maxRetries),
      baseDelayMs: Number(form.baseDelayMs),
      factor: Number(form.factor),
      maxDelayMs: Number(form.maxDelayMs),
      resetAfterMs: Number(form.resetAfterMs),
    },
    health: {
      enabled: form.healthEnabled,
      mode: form.healthMode,
      http: {
        path: form.httpPath,
        method: form.httpMethod,
        // `null` clears the exact-status check; omitting it would keep an existing value.
        expectStatus: expectStatus.length === 0 ? null : Number(expectStatus),
        expectStatusBelow: Number(form.httpExpectStatusBelow),
        expectBody: form.httpExpectBody,
      },
      intervalMs: Number(form.intervalMs),
      timeoutMs: Number(form.timeoutMs),
      unhealthyThreshold: Number(form.unhealthyThreshold),
      forceRestartAfterMs: Number(form.forceRestartAfterMs),
      startTimeoutMs: Number(form.startTimeoutMs),
    },
    stop: {
      signal: form.signal,
      killGroup: form.killGroup,
      graceMs: Number(form.graceMs),
      killPortHolders: form.killPortHolders,
    },
    bootstrap: form.bootstrapEnabled
      ? {
          command: form.bootstrapCommand.trim(),
          args: linesToArray(form.bootstrapArgs),
          env: textToEnv(form.bootstrapEnv),
          timeoutMs: Number(form.bootstrapTimeoutMs),
          runOnce: form.bootstrapRunOnce,
        }
      : null,
  }
}

function back(): void {
  void router.push({ name: 'servers' })
}

const payload = computed(() => buildPayload())
/**
 * `diffServerConfig` compares nested group members by reference, and `health.http`
 * is the only object down there: drop it again when its contents did not change,
 * or every load would report a phantom "unsaved changes". A blank exact status is
 * `null` in the payload and an absent key in the config — both mean "any below".
 */
const patch = computed<Patch>(() => (config.value === null ? {} : diffServerConfig(config.value, payload.value)))
const changedCount = computed(() => countLeaves(patch.value))
const changes = computed(() => describeChanges(
  patch.value,
  config.value === null ? {} : { ...config.value, label: config.value.label ?? '' } as Patch,
))

function formatChangeValue(value: unknown): string {
  if (value === undefined)
    return 'unset'
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function openChanges(): void {
  configChangesOpen.value = true
}

function closeChanges(): void {
  configChangesOpen.value = false
}

function saveFromDialog(): void {
  configChangesOpen.value = false
  void save()
}

async function save(): Promise<void> {
  error.value = null
  const cfg = config.value
  if (!cfg)
    return

  if (form.bind === 'custom' && parseBind(form.customBind.trim()) === null) {
    error.value = 'a custom bind must be an IPv4 address, "local" or "lan"'
    configChangesOpen.value = false
    return
  }

  const validated = serverPatchSchema(payload.value)
  if (validated instanceof type.errors) {
    error.value = validated.summary
    configChangesOpen.value = false
    return
  }

  if (Object.keys(patch.value).length === 0) {
    flash('nothing changed')
    back()
    return
  }

  saving.value = true
  try {
    await control.saveConfig(props.id, patch.value)
    if (control.lastError.value !== null) {
      error.value = control.lastError.value
      return
    }
    selectedId.value = props.id
    flash(`saved ${props.id}`)
    back()
  }
  finally {
    saving.value = false
  }
}

async function remove(): Promise<void> {
  await control.remove(props.id)
  if (control.lastError.value === null) {
    flash(`removed ${props.id}`)
    back()
  }
}
</script>

<template>
  <div class="view">
    <div class="view__head">
      <RouterLink to="/" class="btn btn--sm btn--ghost">
        ← servers
      </RouterLink>
      <span class="view__title">{{ id }} · config</span>
      <StatusChip v-if="server" :status="server.status" />
      <span v-if="server && !server.config.enabled" class="chip chip--idle">disabled</span>
      <span class="view__spacer" />
      <button
        v-if="changedCount > 0"
        type="button"
        class="btn btn--sm btn--ghost changelink"
        @click="openChanges"
      >
        <span class="mono">{{ changedCount }}</span> unsaved {{ changedCount === 1 ? 'change' : 'changes' }}
      </button>
      <span v-else-if="config" class="view__count">in sync</span>
      <ConfirmButton v-if="server" label="remove server" confirm-label="confirm remove" tone="danger" @confirm="remove" />
      <button type="button" class="btn btn--sm" @click="back">
        cancel
      </button>
      <button type="button" class="btn btn--sm btn--primary" :disabled="saving || config === null" @click="save">
        save config
      </button>
    </div>

    <p v-if="config === null" class="empty">
      no server called “{{ id }}” — it may have been removed
    </p>

    <form v-else class="form form--page" @submit.prevent="save">
      <p v-if="error" class="banner banner--error">
        {{ error }}
      </p>

      <div class="pane">
        <div class="pane__head">
          <span class="pane__title">process</span>
        </div>
        <div class="pane__body" style="padding: 0.6rem 0.75rem">
          <div class="grid">
            <label class="field">
              <span class="field__label">label</span>
              <input v-model="form.label" placeholder="falls back to the id">
            </label>
            <label class="field">
              <span class="field__label">command</span>
              <input v-model="form.command" required>
            </label>
            <label class="field">
              <span class="field__label">cwd</span>
              <input v-model="form.cwd" placeholder=".">
            </label>
            <label class="field">
              <span class="field__label">env file</span>
              <input v-model="form.envFile" placeholder="empty = none">
              <span class="field__hint">loaded at spawn; its values override env</span>
            </label>
            <label class="field grid__full">
              <span class="field__label">args — one per line, placeholders allowed</span>
              <textarea v-model="form.args" rows="4" spellcheck="false" />
              <span class="field__hint">{port} {host} {home} {projectDir} {dataRoot} {id} {label} {cwd} {bind} {lanIp}</span>
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
        </div>
      </div>

      <div class="pane">
        <div class="pane__head">
          <span class="pane__title">port &amp; binding</span>
        </div>
        <div class="pane__body" style="padding: 0.6rem 0.75rem">
          <div class="grid">
            <label class="field">
              <span class="field__label">port</span>
              <input v-model="form.port" inputmode="numeric" placeholder="empty = no port">
              <span class="field__hint">no port means no readiness probe and no health supervision</span>
            </label>
            <label class="field">
              <span class="field__label">bind</span>
              <select v-model="form.bind">
                <option value="local">local · 127.0.0.1</option>
                <option value="lan">lan · 0.0.0.0</option>
                <option value="custom">custom ipv4</option>
              </select>
            </label>
            <label v-if="form.bind === 'custom'" class="field">
              <span class="field__label">ipv4 address</span>
              <input v-model="form.customBind" placeholder="192.168.1.10">
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
              <input v-model="form.logBufferLines" inputmode="numeric">
            </label>
            <label class="field">
              <span class="field__label">live bind address</span>
              <input :value="server?.bindHost" disabled>
            </label>
            <label class="field field--check">
              <input v-model="form.enabled" type="checkbox">
              <span class="field__label">enabled</span>
            </label>
            <label class="field field--check">
              <input v-model="form.autostart" type="checkbox">
              <span class="field__label">autostart with up</span>
            </label>
            <label class="field grid__full">
              <span class="field__label">depends on — comma separated ids</span>
              <input v-model="form.dependsOn" placeholder="db, cache">
              <span class="field__hint">started first (and healthy); stopped in reverse order</span>
            </label>
          </div>
        </div>
      </div>

      <div class="pane">
        <div class="pane__head">
          <span class="pane__title">restart</span>
          <label class="field field--check" style="padding-top: 0">
            <input v-model="form.restartEnabled" type="checkbox">
            <span class="field__label">enabled</span>
          </label>
        </div>
        <div class="pane__body" style="padding: 0.6rem 0.75rem">
          <div class="grid">
            <label class="field">
              <span class="field__label">max retries</span>
              <input v-model="form.maxRetries" inputmode="numeric">
            </label>
            <label class="field">
              <span class="field__label">base delay (ms)</span>
              <input v-model="form.baseDelayMs" inputmode="numeric">
            </label>
            <label class="field">
              <span class="field__label">factor</span>
              <input v-model="form.factor" inputmode="numeric">
            </label>
            <label class="field">
              <span class="field__label">max delay (ms)</span>
              <input v-model="form.maxDelayMs" inputmode="numeric">
            </label>
            <label class="field">
              <span class="field__label">reset after (ms)</span>
              <input v-model="form.resetAfterMs" inputmode="numeric">
              <span class="field__hint">alive this long counts as healthy again</span>
            </label>
          </div>
        </div>
      </div>

      <div class="pane">
        <div class="pane__head">
          <span class="pane__title">health</span>
          <label class="field field--check" style="padding-top: 0">
            <input v-model="form.healthEnabled" type="checkbox">
            <span class="field__label">enabled</span>
          </label>
          <select v-if="form.healthEnabled" v-model="form.healthMode">
            <option value="port">
              tcp port
            </option>
            <option value="http">
              http request
            </option>
          </select>
        </div>
        <div class="pane__body" style="padding: 0.6rem 0.75rem">
          <div class="grid">
            <label class="field">
              <span class="field__label">interval (ms)</span>
              <input v-model="form.intervalMs" inputmode="numeric">
            </label>
            <label class="field">
              <span class="field__label">timeout (ms)</span>
              <input v-model="form.timeoutMs" inputmode="numeric">
            </label>
            <label class="field">
              <span class="field__label">unhealthy after</span>
              <input v-model="form.unhealthyThreshold" inputmode="numeric">
              <span class="field__hint">consecutive failed probes</span>
            </label>
            <label class="field">
              <span class="field__label">force restart after (ms)</span>
              <input v-model="form.forceRestartAfterMs" inputmode="numeric">
              <span class="field__hint">0 = never</span>
            </label>
            <label class="field">
              <span class="field__label">start timeout (ms)</span>
              <input v-model="form.startTimeoutMs" inputmode="numeric">
              <span class="field__hint">wait for the port after spawn</span>
            </label>
          </div>

          <div v-if="form.healthEnabled && form.healthMode === 'http'" class="grid" style="margin-top: 0.5rem">
            <label class="field">
              <span class="field__label">http path</span>
              <input v-model="form.httpPath" placeholder="/healthz">
            </label>
            <label class="field">
              <span class="field__label">method</span>
              <select v-model="form.httpMethod">
                <option value="GET">GET</option>
                <option value="HEAD">HEAD</option>
              </select>
            </label>
            <label class="field">
              <span class="field__label">expect status</span>
              <input v-model="form.httpExpectStatus" inputmode="numeric" placeholder="blank = any below">
            </label>
            <label class="field">
              <span class="field__label">healthy below status</span>
              <input v-model="form.httpExpectStatusBelow" inputmode="numeric">
            </label>
            <label class="field grid__full">
              <span class="field__label">body must contain</span>
              <input v-model="form.httpExpectBody" placeholder="optional substring">
            </label>
          </div>
        </div>
      </div>

      <div class="pane">
        <div class="pane__head">
          <span class="pane__title">stop</span>
        </div>
        <div class="pane__body" style="padding: 0.6rem 0.75rem">
          <div class="grid">
            <label class="field">
              <span class="field__label">signal</span>
              <select v-model="form.signal">
                <option value="SIGTERM">SIGTERM</option>
                <option value="SIGINT">SIGINT</option>
                <option value="SIGKILL">SIGKILL</option>
              </select>
            </label>
            <label class="field">
              <span class="field__label">grace (ms)</span>
              <input v-model="form.graceMs" inputmode="numeric">
            </label>
            <label class="field field--check">
              <input v-model="form.killGroup" type="checkbox">
              <span class="field__label">kill the process group</span>
            </label>
            <label class="field field--check">
              <input v-model="form.killPortHolders" type="checkbox">
              <span class="field__label">kill port holders</span>
            </label>
          </div>
        </div>
      </div>

      <div class="pane">
        <div class="pane__head">
          <span class="pane__title">resources</span>
        </div>
        <div class="pane__body" style="padding: 0.6rem 0.75rem">
          <div class="grid">
            <label class="field">
              <span class="field__label">max rss (MiB)</span>
              <input v-model="form.maxRssMb" inputmode="numeric" placeholder="empty = no guard">
              <span class="field__hint">restart when the process tree exceeds it</span>
            </label>
          </div>
        </div>
      </div>

      <div class="pane">
        <div class="pane__head">
          <span class="pane__title">bootstrap</span>
          <label class="field field--check" style="padding-top: 0">
            <input v-model="form.bootstrapEnabled" type="checkbox">
            <span class="field__label">run before the first start</span>
          </label>
        </div>
        <div class="pane__body" style="padding: 0.6rem 0.75rem">
          <div class="grid">
            <label class="field">
              <span class="field__label">command</span>
              <input v-model="form.bootstrapCommand" :disabled="!form.bootstrapEnabled">
            </label>
            <label class="field">
              <span class="field__label">timeout (ms)</span>
              <input v-model="form.bootstrapTimeoutMs" :disabled="!form.bootstrapEnabled" inputmode="numeric">
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
      </div>

      <div class="group">
        <div class="actions">
          <button type="button" class="btn btn--sm" @click="back">
            cancel
          </button>
          <button type="submit" class="btn btn--sm btn--primary" :disabled="saving">
            save to servers.config.json
          </button>
        </div>
      </div>
    </form>

    <div v-if="configChangesOpen" class="overlay" @click.self="closeChanges">
      <div class="overlay__panel overlay__panel--sheet" role="dialog" aria-label="unsaved server config changes">
        <div class="overlay__head">
          <span class="overlay__title">unsaved changes</span>
          <span class="view__spacer" />
          <span class="faint">writes to servers.config.json</span>
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
            nothing to save
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
