<script setup lang="ts">
import type { ServerDefaults } from '@shared/contracts'
import { serverCreateSchema } from '@shared/contracts'
import { diffFields } from '@shared/patch-diff'
import { type } from 'arktype'
import { computed, nextTick, reactive, ref, watch } from 'vue'
import LifecycleFields from '@/components/LifecycleFields.vue'
import ServerFormFields from '@/components/ServerFormFields.vue'
import { flash, selectedId } from '@/composables/useUi'
import { useWorkspaces } from '@/composables/useWorkspaces'
import { linesToArray, textToEnv } from '@/lib/fields'
import { repairNumbers } from '@/lib/forms'
import { blankSharedForm, cloneHealth, inheritBaseline, rssBytesFromForm, SCHEMA_HEALTH, SCHEMA_RESTART, SCHEMA_STOP } from '@/lib/serverForm'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const workspace = useWorkspaces()
const error = ref<string | null>(null)
const busy = ref(false)
const fields = ref<InstanceType<typeof ServerFormFields> | null>(null)

/**
 * The dialog's own form: the shared fields plus the three it alone carries. `id` is new
 * here — the page edits an entry that already has one — and `restart`, `health` and `stop`
 * are the typed nested groups this form binds to `LifecycleFields`, where the page's
 * lifecycle boxes are flat strings.
 */
function blank(defaults: ServerDefaults | null = workspace.defaults.value) {
  return {
    id: '',
    ...blankSharedForm('sheet', defaults),
    restart: { ...(defaults?.restart ?? SCHEMA_RESTART) },
    health: cloneHealth(defaults?.health ?? SCHEMA_HEALTH),
    stop: { ...(defaults?.stop ?? SCHEMA_STOP) },
  }
}

const form = reactive(blank())

/** What a blank buffer field inherits, so the hint cannot lie about the number. */
const inheritedLogLines = computed(() => workspace.defaults.value?.logBufferLines ?? 500)

function reset(): void {
  Object.assign(form, blank(workspace.defaults.value))
}

watch(() => props.open, async (open) => {
  if (!open)
    return
  error.value = null
  // Every open starts equal to what the entry would inherit.
  reset()
  await nextTick()
  fields.value?.focusField('id')
})

/**
 * What the person decided, and nothing else: a value equal to what the entry
 * would inherit stays out, so it keeps following `Settings → Server defaults`
 * instead of freezing today's values into `servers.config.json`.
 */
function buildPayload(): Record<string, unknown> {
  const bufferLines = form.logBufferLines.trim()
  const bootstrapMs = Number(form.bootstrapTimeoutMs)
  const defaults = workspace.defaults.value
  const baseline = inheritBaseline(defaults)

  const flat = diffFields(baseline, {
    args: linesToArray(form.args),
    cwd: form.cwd.trim().length > 0 ? form.cwd.trim() : '.',
    env: textToEnv(form.env),
    dataEnvs: textToEnv(form.dataEnvs),
    dependsOn: form.dependsOn.split(',').map(entry => entry.trim()).filter(entry => entry.length > 0),
    envFile: form.envFile.trim(),
    backupPaths: linesToArray(form.backupPaths),
    backupIgnoreGenerated: form.backupIgnoreGenerated,
    resources: { maxRssBytes: rssBytesFromForm(form.maxRssMb) },
    onPortConflict: form.onPortConflict,
    bind: form.bind,
    enabled: form.enabled,
    autostart: form.autostart,
    persistent: form.persistent,
    // Blank means inherited, and a value equal to the default is left out too.
    logBufferLines: bufferLines === '' ? baseline.logBufferLines : Number(bufferLines),
  })

  /**
   * An emptied number box reports `''`, which the create/patch schema rejects for the whole
   * body. Put the inherited value back first, so the field drops out of the diff instead.
   */
  const inherited = {
    restart: defaults?.restart ?? SCHEMA_RESTART,
    health: defaults?.health ?? SCHEMA_HEALTH,
    stop: defaults?.stop ?? SCHEMA_STOP,
  }
  repairNumbers(form.restart as unknown as Record<string, unknown>, inherited.restart as unknown as Record<string, unknown>)
  repairNumbers(form.health as unknown as Record<string, unknown>, inherited.health as unknown as Record<string, unknown>)
  repairNumbers(form.stop as unknown as Record<string, unknown>, inherited.stop as unknown as Record<string, unknown>)

  const groups = diffFields(
    inherited,
    { restart: form.restart, health: form.health, stop: form.stop },
  )

  const payload: Record<string, unknown> = {
    ...flat,
    ...groups,
    id: form.id.trim(),
    command: form.command.trim(),
  }

  const label = form.label.trim()
  if (label.length > 0)
    payload.label = label

  const port = form.port.trim()
  if (port !== '')
    payload.port = Number(port)

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
    await workspace.createServer(parsed)

    if (workspace.lastError.value !== null) {
      error.value = workspace.lastError.value
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
          <ServerFormFields
            ref="fields"
            :form="form"
            variant="sheet"
            :inherited-log-lines="inheritedLogLines"
          >
            <template #lifecycle>
              <LifecycleFields
                v-model:restart="form.restart"
                v-model:health="form.health"
                v-model:stop="form.stop"
              />
            </template>
          </ServerFormFields>

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
