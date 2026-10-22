<script setup lang="ts">
import type { AddServerField, AddServerForm } from '@/components/server/addServerForm'
import type { ServerPreset } from '@/components/server/serverPresets'
import { serverCreateSchema } from '@shared/contracts'
import { type } from 'arktype'
import { computed, reactive, ref, watch } from 'vue'
import { addServerPayload, addServerPortError, addServerProblem, blankAddServerForm } from '@/components/server/addServerForm'
import LifecycleFields from '@/components/server/LifecycleFields.vue'
import { applyPreset, SERVER_PRESETS } from '@/components/server/serverPresets'
import AppButton from '@/components/ui/AppButton.vue'
import Disclosure from '@/components/ui/Disclosure.vue'
import FieldGroup from '@/components/ui/FieldGroup.vue'
import Modal from '@/components/ui/Modal.vue'
import NumberField from '@/components/ui/NumberField.vue'
import SelectField from '@/components/ui/SelectField.vue'
import TextAreaField from '@/components/ui/TextAreaField.vue'
import TextField from '@/components/ui/TextField.vue'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import TransText from '@/components/ui/TransText.vue'
import { useControlPlane } from '@/composables/useControlPlane'
import { t } from '@/i18n'

const props = defineProps<{ workspaceId: string }>()

const emit = defineEmits<{ created: [] }>()

const open = defineModel<boolean>('open', { default: false })

const control = useControlPlane()

const creating = ref(false)
const formError = ref<string | null>(null)
/** Which input the error is about, so it can be flagged and scrolled to instead of only printed. */
const errorField = ref<AddServerField | null>(null)
const formEl = ref<HTMLFormElement | null>(null)
/**
 * The gallery is shown until a preset is chosen or the person declines it.
 *
 * A brand-new user has a line someone gave them, not a command/args/port trio. Filling the form
 * from a preset is the whole of "onboarding" that does not need a second screen.
 */
const showPresets = ref(true)

/** Placeholders the supervisor substitutes in `args` (and in paths). */
const PLACEHOLDERS = ['{port}', '{host}', '{home}', '{projectDir}', '{dataRoot}', '{id}', '{label}', '{cwd}', '{bind}', '{lanIp}']

/** What an entry would inherit from the workspace it is added to. */
const panelDefaults = computed(() => control.workspaceById(props.workspaceId)?.defaults)
const workspaceLabel = computed(() => control.workspaceById(props.workspaceId)?.label ?? t('addServer.thisWorkspace'))

const form = reactive<AddServerForm>(blankAddServerForm(panelDefaults.value))
function choosePreset(preset: ServerPreset): void {
  Object.assign(form, applyPreset(preset, {
    ...(panelDefaults.value === undefined ? {} : { defaults: panelDefaults.value }),
    id: form.id,
    label: form.label,
  }))
  showPresets.value = false
  formError.value = null
  errorField.value = null
}

function startFromScratch(): void {
  showPresets.value = false
}

/** A catalog key: the check runs outside any component, so it is read through `t()` here. */
const portError = computed(() => {
  const key = addServerPortError(form.port)
  return key === null ? null : t(key)
})

/** Reset every time the dialog opens, so a cancelled attempt leaves nothing behind. */
function reset(): void {
  Object.assign(form, blankAddServerForm(panelDefaults.value))
  formError.value = null
  errorField.value = null
  // Every open starts at the gallery: a second server is usually the same kind as the first, and
  // the presets are one click.
  showPresets.value = true
}

/**
 * Puts the failure where the person is looking.
 *
 * The message used to render only at the very bottom of a long form — off screen on a laptop —
 * with the offending input unmarked and unfocused, so an empty Id read as "the button is broken".
 */
function showError(message: string, field: AddServerField | null): void {
  formError.value = message
  errorField.value = field
  if (field === null)
    return
  const target = formEl.value?.querySelector<HTMLElement>(`[data-field="${field}"] input, [data-field="${field}"] textarea`)
  target?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  target?.focus()
}

watch(open, (isOpen) => {
  if (isOpen)
    reset()
})

async function submit(): Promise<void> {
  formError.value = null
  errorField.value = null
  const invalid = addServerProblem(form)
  if (invalid !== null) {
    showError(t(invalid.key), invalid.field)
    return
  }

  const parsed = serverCreateSchema(addServerPayload(form, panelDefaults.value))
  if (parsed instanceof type.errors) {
    // A schema error names a path; point at the field it names when there is one.
    showError(parsed.summary, null)
    return
  }

  creating.value = true
  try {
    await control.create(props.workspaceId, parsed)
    if (control.lastError.value !== null) {
      showError(control.lastError.value, null)
      return
    }
    emit('created')
    open.value = false
    reset()
  }
  finally {
    creating.value = false
  }
}
</script>

<template>
  <Modal
    v-model:open="open"
    :title="t('addServer.title')"
    :description="t('addServer.description', { workspace: workspaceLabel })"
    width="w-[min(94vw,40rem)]"
  >
    <!--
      Sticky, above the fields: the error belongs where the eye lands on submit, not after ten
      placeholders at the bottom of a scrollable form.
    -->
    <p
      v-if="formError"
      role="alert"
      class="sticky top-0 z-10 mb-3 rounded-control border border-danger/40 bg-danger-soft px-2.5 py-1.5 font-mono text-2xs leading-4 text-danger"
    >
      {{ formError }}
    </p>

    <!--
      The gallery a new user lands on: "what do you want to run?" instead of a command/args/port
      form whose first sentence names a config file. Picking one fills the form below, which stays
      fully editable.
    -->
    <div v-if="showPresets" class="flex flex-col gap-3">
      <div>
        <p class="text-sm font-medium text-ink">
          {{ t('presets.pickTitle') }}
        </p>
        <p class="mt-0.5 text-2xs text-muted">
          {{ t('presets.pickDescription') }}
        </p>
      </div>
      <ul class="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <li v-for="preset in SERVER_PRESETS" :key="preset.id">
          <button
            type="button"
            class="flex h-full w-full flex-col items-start gap-1 rounded-panel border border-line bg-raise px-3 py-2.5 text-left transition-colors hover:bg-hover"
            @click="choosePreset(preset)"
          >
            <span class="text-xs font-medium text-ink">{{ t(preset.nameKey) }}</span>
            <span class="text-2xs leading-4 text-muted">{{ t(preset.descriptionKey) }}</span>
          </button>
        </li>
      </ul>
      <AppButton variant="ghost" size="xs" class="self-start" @click="startFromScratch">
        {{ t('presets.startFromScratch') }}
      </AppButton>
    </div>

    <form v-show="!showPresets" id="add-server-form" ref="formEl" class="flex flex-col gap-3" @submit.prevent="submit">
      <FieldGroup :title="t('addServer.identity')" :columns="2" dense>
        <div data-field="id">
          <TextField
            v-model="form.id"
            :label="t('addServer.id')"
            placeholder="my-server"
            :hint="t('addServer.idHint')"
            :error="errorField === 'id' ? formError : null"
            class="font-mono text-xs"
          />
        </div>
        <TextField v-model="form.label" :label="t('common.label')" placeholder="My server" :hint="t('addServer.labelHint')" />
      </FieldGroup>

      <FieldGroup :title="t('addServer.process')" :columns="2" dense>
        <div data-field="command">
          <TextField
            v-model="form.command"
            :label="t('common.command')"
            placeholder="node"
            :hint="t('addServer.commandHint')"
            :error="errorField === 'command' ? formError : null"
            class="font-mono text-xs"
          />
        </div>
        <TextField
          v-model="form.cwd"
          :label="t('serverForm.workingDirectory')"
          placeholder="."
          :hint="t('serverForm.cwdHint')"
          class="font-mono text-xs"
        />
      </FieldGroup>

      <TextAreaField
        v-model="form.args"
        :label="t('serverForm.arguments')"
        :rows="3"
        :hint="t('addServer.argumentsHint')"
        placeholder="-p&#10;{port}"
      />

      <FieldGroup :title="t('addServer.portLifecycle')" :columns="2" dense>
        <NumberField
          v-model="form.port"
          :label="t('common.port')"
          nullable
          :min="1"
          :max="65535"
          :error="portError"
          :hint="t('serverForm.portHint')"
        />
        <SelectField
          v-model="form.bind"
          :label="t('serverForm.bindAddress')"
          :options="[
            { value: 'local', label: t('bind.local') },
            { value: 'lan', label: t('bind.lan') },
          ]"
          :hint="t('addServer.bindHint')"
        />
        <ToggleSwitch v-model="form.autostart" :label="t('serverForm.autostart')" :hint="t('serverForm.autostartHint')" wide />
        <ToggleSwitch v-model="form.persistent" :label="t('serverForm.persistent')" :hint="t('serverForm.persistentHint')" wide />
      </FieldGroup>

      <Disclosure :title="t('addServer.advanced')" :hint="t('addServer.advancedHint')">
        <FieldGroup :title="t('common.environment')" :columns="2" dense>
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
          <TextField
            v-model="form.envFile"
            :label="t('serverForm.envFile')"
            :placeholder="t('serverForm.envFilePlaceholder')"
            :hint="t('serverForm.envFileHint')"
            class="font-mono text-xs"
          />
          <TextField
            v-model="form.dependsOn"
            :label="t('serverForm.dependsOn')"
            placeholder="postgres, redis"
            :hint="t('serverForm.dependsOnHint')"
            class="font-mono text-xs"
          />
        </FieldGroup>

        <FieldGroup :title="t('addServer.backups')" :columns="2" dense>
          <TextAreaField
            v-model="form.backupPaths"
            :label="t('serverForm.backupPaths')"
            :rows="2"
            :hint="t('serverForm.backupPathsHint')"
            placeholder="{home}/.app/uploads"
          />
          <ToggleSwitch
            v-model="form.backupIgnoreGenerated"
            :label="t('addServer.backupIgnore')"
            :hint="t('serverForm.backupIgnoreHint')"
            wide
          />
        </FieldGroup>

        <LifecycleFields v-model:restart="form.restart" v-model:health="form.health" v-model:stop="form.stop" />

        <FieldGroup :title="t('serverForm.bootstrap')" :description="t('addServer.bootstrapDescription')" :columns="2" dense>
          <ToggleSwitch
            v-model="form.bootstrapEnabled"
            :label="t('serverForm.runBootstrap')"
            :hint="t('addServer.bootstrapHint')"
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
            <TextAreaField
              v-model="form.bootstrapArgs"
              :label="t('serverForm.bootstrapArgs')"
              :rows="2"
              :hint="t('serverForm.bootstrapArgsHint')"
            />
            <TextAreaField
              v-model="form.bootstrapEnv"
              :label="t('serverForm.bootstrapEnv')"
              :rows="2"
              :hint="t('serverForm.bootstrapEnvHint')"
            />
          </template>
        </FieldGroup>

        <FieldGroup :title="t('addServer.policyResources')" :columns="2" dense>
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
          <NumberField v-model="form.logBufferLines" :label="t('serverForm.logBufferLines')" :min="50" :max="100000" :step="50" :hint="t('addServer.logBufferHint')" />
          <NumberField v-model="form.maxRssMb" :label="t('serverForm.maxRssMb')" :min="0" :hint="t('serverForm.maxRssHint')" />
          <ToggleSwitch v-model="form.enabled" :label="t('common.enabled')" :hint="t('serverForm.enabledHint')" wide />
        </FieldGroup>

        <p class="text-2xs leading-4 text-faint">
          <TransText k="addServer.inheritNote">
            <template #settings>
              <span class="font-mono">{{ t('addServer.serverDefaults') }}</span>
            </template>
          </TransText>
        </p>
      </Disclosure>

      <div class="rounded-panel border border-line-soft bg-panel-2/40 p-3">
        <p class="text-2xs font-medium text-muted">
          {{ t('addServer.placeholdersTitle') }}
        </p>
        <div class="mt-1.5 flex flex-wrap gap-1">
          <code
            v-for="placeholder in PLACEHOLDERS"
            :key="placeholder"
            class="rounded-control border border-line bg-raise px-1.5 py-0.5 font-mono text-2xs text-ink"
          >
            {{ placeholder }}
          </code>
        </div>
      </div>
    </form>

    <template #footer>
      <AppButton variant="ghost" @click="open = false">
        {{ t('common.cancel') }}
      </AppButton>
      <!-- Nothing to submit while the gallery is up: the form below is not showing yet. -->
      <AppButton v-if="!showPresets" type="submit" form="add-server-form" variant="primary" :loading="creating">
        {{ t('addServer.submit') }}
      </AppButton>
    </template>
  </Modal>
</template>
