<script setup lang="ts">
import type { HealthConfig, RestartConfig, ServerConfig, StopConfig } from '@shared/contracts'
import type { Patch } from '@shared/patch-diff'
import type { ServerEditForm } from '@shared/server-form'
import { serverPatchSchema } from '@shared/contracts'
import { countLeaves, describeChanges } from '@shared/patch-diff'
import { fillSnapshot, liveConfigUpdate, serverEditForm, serverEditPatch, serverEditPayload } from '@shared/server-form'
import { type } from 'arktype'
import { computed, reactive, ref, watch } from 'vue'
import LifecycleFields from '@/components/server/LifecycleFields.vue'
import { cloneHealth } from '@/components/settings/settingsForm'
import AppButton from '@/components/ui/AppButton.vue'
import BindField from '@/components/ui/BindField.vue'
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
import { formatChangeValue } from '@/lib/format'

const props = defineProps<{
  serverId: string
  /** The workspace that owns the entry; the patch is scoped to it. */
  workspaceId: string
  config: ServerConfig
}>()

const emit = defineEmits<{ saved: [], cancel: [] }>()

const control = useControlPlane()

const saving = ref(false)
const error = ref<string | null>(null)

/**
 * The form and its round trip live in `@shared/server-form`, which the console's page reads too.
 * Restart/health/stop are held apart only because `LifecycleFields` binds them as typed groups.
 */
type EditorForm = Omit<ServerEditForm<number | null>, 'restart' | 'health' | 'stop'>

function formFrom(config: ServerConfig): EditorForm {
  const { restart: _restart, health: _health, stop: _stop, ...rest } = serverEditForm(config)
  return rest
}

const form = reactive<EditorForm>(formFrom(props.config))
const restart = ref<RestartConfig>({ ...props.config.restart })
// A shallow copy would still alias the live `health.http`, which the frame guard compares against.
const health = ref<HealthConfig>(cloneHealth(props.config.health))
const stop = ref<StopConfig>({ ...props.config.stop })

/** The config the form was last filled from: what a cleared box falls back to, and what Save diffs against. */
const filled = ref<ServerConfig>(fillSnapshot(props.config))

/** Set when the entry changed elsewhere while this form held edits. */
const changedElsewhere = ref(false)

function wholeForm(): ServerEditForm {
  return {
    ...form,
    restart: restart.value,
    health: { ...health.value, http: { ...health.value.http, expectStatus: health.value.http.expectStatus ?? null } },
    stop: stop.value,
  }
}

/** Exactly what Save would write: the payload minus everything equal to what the form was filled with. */
const patch = computed(() => serverEditPatch(wholeForm(), filled.value))

const changed = computed(() => countLeaves(patch.value))
const canSave = computed(() => changed.value > 0)

/** The pending patch as readable rows, for the review dialog. */
const changes = computed(() => describeChanges(patch.value, filled.value as unknown as Patch))
const showChanges = ref(false)

function resetFrom(config: ServerConfig): void {
  Object.assign(form, formFrom(config))
  restart.value = { ...config.restart }
  health.value = cloneHealth(config.health)
  stop.value = { ...config.stop }
  filled.value = fillSnapshot(config)
  changedElsewhere.value = false
  error.value = null
}

watch(() => props.config, (next) => {
  // The control plane re-creates every config object on each state refresh. A genuine change
  // refills a clean form; a form holding edits keeps them and says the entry moved underneath it.
  const action = liveConfigUpdate(next, filled.value, changed.value > 0)
  if (action === 'refill')
    resetFrom(next)
  else if (action === 'notice')
    changedElsewhere.value = true
})

async function save(): Promise<void> {
  error.value = null
  saving.value = true
  try {
    const parsed = serverPatchSchema(serverEditPayload(wholeForm(), filled.value))
    if (parsed instanceof type.errors) {
      error.value = parsed.summary
      return
    }

    const pending = patch.value
    if (Object.keys(pending).length === 0) {
      emit('saved')
      return
    }

    const outcome = await control.saveConfig(props.workspaceId, props.serverId, pending)
    if (!outcome.ok) {
      error.value = outcome.error
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

    <p v-if="changedElsewhere" class="mb-3 flex flex-wrap items-center gap-2 rounded-control border border-warn/40 bg-warn-soft px-2.5 py-1.5 text-2xs leading-4 text-warn" role="status">
      <span class="min-w-0 flex-1">{{ t('editor.changedElsewhere') }}</span>
      <AppButton size="sm" variant="ghost" @click="resetFrom(props.config)">
        {{ t('editor.reloadChanged') }}
      </AppButton>
    </p>

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
        <NumberField v-model="form.maxRssMb" nullable :label="t('serverForm.maxRssMb')" :min="0" :hint="t('serverForm.maxRssHint')" />
      </FieldGroup>

      <FieldGroup
        :title="t('editor.portTitle')"
        :description="t('editor.portDescription')"
        :columns="2"
      >
        <NumberField v-model="form.port" :label="t('common.port')" nullable :min="1" :max="65535" :hint="t('serverForm.portHint')" />
        <BindField v-model="form.bind" :label="t('serverForm.bindAddress')" :hint="t('editor.bindHint')" />
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
        <NumberField v-model="form.logBufferLines" nullable :label="t('serverForm.logBufferLines')" :min="50" :max="100000" :step="50" />
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
          v-model="form.bootstrap.enabled"
          :label="t('serverForm.runBootstrap')"
          :hint="t('serverForm.bootstrapHint')"
          wide
        />
        <template v-if="form.bootstrap.enabled">
          <TextField
            v-model="form.bootstrap.command"
            :label="t('common.command')"
            placeholder="./scripts/install.sh"
            class="font-mono text-xs"
          />
          <NumberField v-model="form.bootstrap.timeoutSeconds" :label="t('serverForm.timeoutSeconds')" nullable :min="1" />
          <ToggleSwitch v-model="form.bootstrap.runOnce" :label="t('serverForm.runOnce')" :hint="t('serverForm.runOnceHint')" />
        </template>
        <TextAreaField
          v-if="form.bootstrap.enabled"
          v-model="form.bootstrap.args"
          :label="t('serverForm.bootstrapArgs')"
          :rows="2"
          :hint="t('serverForm.bootstrapArgsHint')"
        />
        <TextAreaField
          v-if="form.bootstrap.enabled"
          v-model="form.bootstrap.env"
          :label="t('serverForm.bootstrapEnv')"
          :rows="2"
          :hint="t('serverForm.bootstrapEnvHint')"
        />
      </FieldGroup>

      <FieldGroup
        :title="t('serverForm.backupHooks')"
        :description="t('serverForm.backupHooksDescription')"
        :columns="2"
      >
        <ToggleSwitch
          v-model="form.dump.enabled"
          :label="t('serverForm.dumpEnabled')"
          :hint="t('serverForm.dumpEnabledHint')"
          wide
        />
        <template v-if="form.dump.enabled">
          <TextField
            v-model="form.dump.command"
            :label="t('serverForm.dumpCommand')"
            placeholder="mongodump"
            class="font-mono text-xs"
          />
          <NumberField v-model="form.dump.timeoutSeconds" :label="t('serverForm.timeoutSeconds')" nullable :min="1" />
          <TextAreaField
            v-model="form.dump.args"
            :label="t('serverForm.dumpArgs')"
            :rows="2"
            :hint="t('serverForm.dumpArgsHint')"
            wide
          />
          <TextAreaField
            v-model="form.dump.env"
            :label="t('serverForm.hookEnv')"
            :rows="2"
            wide
          />
        </template>

        <ToggleSwitch
          v-model="form.load.enabled"
          :label="t('serverForm.loadEnabled')"
          :hint="t('serverForm.loadEnabledHint')"
          wide
        />
        <template v-if="form.load.enabled">
          <TextField
            v-model="form.load.command"
            :label="t('serverForm.loadCommand')"
            placeholder="mongorestore"
            class="font-mono text-xs"
          />
          <NumberField v-model="form.load.timeoutSeconds" :label="t('serverForm.timeoutSeconds')" nullable :min="1" />
          <TextAreaField
            v-model="form.load.args"
            :label="t('serverForm.loadArgs')"
            :rows="2"
            :hint="t('serverForm.loadArgsHint')"
            wide
          />
          <TextAreaField
            v-model="form.load.env"
            :label="t('serverForm.hookEnv')"
            :rows="2"
            wide
          />
        </template>
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
