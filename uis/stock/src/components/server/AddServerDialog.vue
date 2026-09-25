<script setup lang="ts">
import type { AddServerForm } from '@/components/server/addServerForm'
import { serverCreateSchema } from '@shared/contracts'
import { type } from 'arktype'
import { computed, reactive, ref, watch } from 'vue'
import { addServerPayload, addServerPortError, addServerProblem, blankAddServerForm } from '@/components/server/addServerForm'
import AppButton from '@/components/ui/AppButton.vue'
import Disclosure from '@/components/ui/Disclosure.vue'
import FieldGroup from '@/components/ui/FieldGroup.vue'
import Modal from '@/components/ui/Modal.vue'
import NumberField from '@/components/ui/NumberField.vue'
import SelectField from '@/components/ui/SelectField.vue'
import TextAreaField from '@/components/ui/TextAreaField.vue'
import TextField from '@/components/ui/TextField.vue'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import { useControlPlane } from '@/composables/useControlPlane'

const emit = defineEmits<{ created: [] }>()

const open = defineModel<boolean>('open', { default: false })

const control = useControlPlane()

const creating = ref(false)
const formError = ref<string | null>(null)

/** Placeholders the supervisor substitutes in `args` (and in paths). */
const PLACEHOLDERS = ['{port}', '{host}', '{home}', '{projectDir}', '{dataRoot}', '{id}', '{label}', '{cwd}', '{bind}', '{lanIp}']

const form = reactive<AddServerForm>(blankAddServerForm())
const portError = computed(() => addServerPortError(form.port))

/** Reset every time the dialog opens, so a cancelled attempt leaves nothing behind. */
function reset(): void {
  Object.assign(form, blankAddServerForm())
  formError.value = null
}

watch(open, (isOpen) => {
  if (isOpen)
    reset()
})

async function submit(): Promise<void> {
  formError.value = null
  const invalid = addServerProblem(form)
  if (invalid !== null) {
    formError.value = invalid
    return
  }

  const parsed = serverCreateSchema(addServerPayload(form))
  if (parsed instanceof type.errors) {
    formError.value = parsed.summary
    return
  }

  creating.value = true
  try {
    await control.create(parsed)
    if (control.lastError.value !== null) {
      formError.value = control.lastError.value
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
    title="Add a server"
    description="Appends an entry to servers.config.json; every policy you leave out is inherited from the defaults."
    width="w-[min(94vw,40rem)]"
  >
    <form id="add-server-form" class="flex flex-col gap-3" @submit.prevent="submit">
      <FieldGroup title="Identity" :columns="2" dense>
        <TextField
          v-model="form.id"
          label="Id"
          placeholder="my-server"
          hint="Lowercase letters, digits, dashes and underscores; used in URLs and logs."
          class="font-mono text-xs"
        />
        <TextField v-model="form.label" label="Label" placeholder="My server" hint="Shown in the panel; defaults to the id." />
      </FieldGroup>

      <FieldGroup title="Process" :columns="2" dense>
        <TextField
          v-model="form.command"
          label="Command"
          placeholder="node"
          hint="Spawned without a shell."
          class="font-mono text-xs"
        />
        <TextField
          v-model="form.cwd"
          label="Working directory"
          placeholder="."
          hint="Relative paths resolve under projectDir."
          class="font-mono text-xs"
        />
      </FieldGroup>

      <TextAreaField
        v-model="form.args"
        label="Arguments"
        :rows="3"
        hint="One argument per line; whitespace inside a line is preserved."
        placeholder="-p&#10;{port}"
      />

      <FieldGroup title="Port &amp; lifecycle" :columns="2" dense>
        <NumberField
          v-model="form.port"
          label="Port"
          nullable
          :min="1"
          :max="65535"
          :error="portError"
          hint="Blank means the server has no port to probe or preflight."
        />
        <SelectField
          v-model="form.bind"
          label="Bind address"
          :options="[
            { value: 'local', label: 'local — 127.0.0.1' },
            { value: 'lan', label: 'lan — 0.0.0.0' },
          ]"
          hint="lan exposes it to the network; only do that behind auth."
        />
        <ToggleSwitch v-model="form.autostart" label="Autostart with up" hint="Start it whenever the control plane comes up." wide />
      </FieldGroup>

      <Disclosure title="Advanced settings" hint="environment, backups, resources, policy">
        <FieldGroup title="Environment" :columns="2" dense>
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
          <TextField
            v-model="form.envFile"
            label="Env file"
            placeholder="optional KEY=value file"
            hint="Loaded at spawn; its values override env."
            class="font-mono text-xs"
          />
          <TextField
            v-model="form.dependsOn"
            label="Depends on"
            placeholder="postgres, redis"
            hint="Comma separated; started first, stopped last."
            class="font-mono text-xs"
          />
        </FieldGroup>

        <FieldGroup title="Backups" :columns="2" dense>
          <TextAreaField
            v-model="form.backupPaths"
            label="Extra backup paths"
            :rows="2"
            hint="One per line, placeholders allowed; data envs are captured already."
            placeholder="{home}/.app/uploads"
          />
          <ToggleSwitch
            v-model="form.backupIgnoreGenerated"
            label="Ignore known generated files"
            hint="Skips node_modules, dist, .next and the other caches nothing restores from."
            wide
          />
        </FieldGroup>

        <FieldGroup title="Policy &amp; resources" :columns="2" dense>
          <SelectField
            v-model="form.onPortConflict"
            label="On port conflict"
            :options="[
              { value: 'block', label: 'block — refuse to start' },
              { value: 'warn', label: 'warn — start anyway' },
              { value: 'follow', label: 'follow — adopt a detached restart of itself' },
              { value: 'reclaim', label: 'reclaim — replace it with a supervised copy' },
            ]"
          />
          <NumberField v-model="form.logBufferLines" label="Log buffer lines" :min="50" :max="100000" :step="50" hint="Blank keeps the default." />
          <NumberField v-model="form.maxRssMb" label="Max RSS (MB)" :min="0" hint="Restart above this; blank or 0 disables it." />
          <ToggleSwitch v-model="form.enabled" label="Enabled" hint="Off keeps the entry in the config but refuses to start it." wide />
        </FieldGroup>

        <p class="text-2xs leading-4 text-faint">
          Restart, health, stop and bootstrapping policy comes from <span class="font-mono">Settings → Server defaults</span>.
          Override them per server from its own editor after adding it.
        </p>
      </Disclosure>

      <div class="rounded-panel border border-line-soft bg-panel-2/40 p-3">
        <p class="text-2xs font-medium text-muted">
          Available argument placeholders
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

      <p v-if="formError" class="rounded-control border border-danger/40 bg-danger-soft px-2.5 py-1.5 font-mono text-2xs leading-4 text-danger">
        {{ formError }}
      </p>
    </form>

    <template #footer>
      <AppButton variant="ghost" @click="open = false">
        Cancel
      </AppButton>
      <AppButton type="submit" form="add-server-form" variant="primary" :loading="creating">
        Add to servers.config.json
      </AppButton>
    </template>
  </Modal>
</template>
