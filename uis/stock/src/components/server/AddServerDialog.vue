<script setup lang="ts">
import type { CreateServerPayload } from '@/lib/api'
import { computed, reactive, ref, watch } from 'vue'
import AppButton from '@/components/ui/AppButton.vue'
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

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/

/** Placeholders the supervisor substitutes in `args` (and in paths). */
const PLACEHOLDERS = ['{port}', '{host}', '{home}', '{projectDir}', '{dataRoot}', '{id}', '{label}', '{cwd}', '{bind}', '{lanIp}']

interface AddForm {
  id: string
  label: string
  command: string
  args: string
  cwd: string
  port: number | null
  bind: string
  autostart: boolean
}

const form = reactive<AddForm>({
  id: '',
  label: '',
  command: '',
  args: '',
  cwd: '',
  port: null,
  bind: 'local',
  autostart: false,
})

function blank(): AddForm {
  return {
    id: '',
    label: '',
    command: '',
    args: '',
    cwd: '',
    port: null,
    bind: 'local',
    autostart: false,
  }
}

const portError = computed(() => {
  if (form.port === null || form.port === undefined || Number.isNaN(form.port))
    return null
  return Number.isInteger(form.port) && form.port >= 1 && form.port <= 65535
    ? null
    : 'Port must be a whole number between 1 and 65535.'
})

/** Reset every time the dialog opens, so a cancelled attempt leaves nothing behind. */
function reset(): void {
  Object.assign(form, blank())
  formError.value = null
}

watch(open, (isOpen) => {
  if (isOpen)
    reset()
})

function body(): CreateServerPayload {
  return {
    id: form.id.trim(),
    label: form.label.trim().length > 0 ? form.label.trim() : undefined,
    command: form.command.trim(),
    args: form.args.split('\n').map(line => line.trim()).filter(line => line.length > 0),
    cwd: form.cwd.trim().length > 0 ? form.cwd.trim() : undefined,
    ...(form.port === null ? {} : { port: form.port }),
    bind: form.bind,
    autostart: form.autostart,
  }
}

function validate(): string | null {
  if (form.id.trim().length === 0)
    return 'An id is required — it is the key this server lives under.'
  if (!ID_PATTERN.test(form.id.trim()))
    return 'The id must start with a lowercase letter or digit and contain only lowercase letters, digits, dashes and underscores.'
  if (form.command.trim().length === 0)
    return 'A command is required — the executable the supervisor spawns.'
  if (portError.value !== null)
    return portError.value
  return null
}

async function submit(): Promise<void> {
  formError.value = null
  const invalid = validate()
  if (invalid !== null) {
    formError.value = invalid
    return
  }

  creating.value = true
  try {
    await control.create(body())
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
      </FieldGroup>

      <div class="flex flex-col gap-2 rounded-panel border border-line bg-panel-2/40 p-3">
        <ToggleSwitch v-model="form.autostart" label="Autostart with up" hint="Start it whenever the control plane comes up." />
        <p class="text-2xs leading-4 text-faint">
          Everything this entry does not set — restart, health, stop, resources — is inherited from <span class="font-mono">Settings → Defaults</span>, and can be overridden afterwards from the server's own editor.
        </p>
      </div>

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
