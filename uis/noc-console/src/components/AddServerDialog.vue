<script setup lang="ts">
import { nextTick, reactive, ref, watch } from 'vue'
import { useControlPlane } from '@/composables/useControlPlane'
import { flash, selectedId } from '@/composables/useUi'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const control = useControlPlane()
const error = ref<string | null>(null)
const busy = ref(false)
const idField = ref<HTMLInputElement | null>(null)

const form = reactive({
  id: '',
  label: '',
  command: '',
  args: '',
  cwd: '',
  port: '',
  bind: 'local',
  autostart: false,
})

watch(() => props.open, async (open) => {
  if (!open)
    return
  error.value = null
  await nextTick()
  idField.value?.focus()
})

async function submit(): Promise<void> {
  error.value = null

  if (!/^[a-z0-9][a-z0-9_-]*$/.test(form.id)) {
    error.value = 'id must start with a lowercase letter or digit, then letters, digits, dash or underscore'
    return
  }
  if (form.command.trim().length === 0) {
    error.value = 'a command is required'
    return
  }

  const port = form.port.trim().length === 0 ? undefined : Number.parseInt(form.port, 10)
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    error.value = 'port must be between 1 and 65535'
    return
  }

  busy.value = true
  try {
    await control.create({
      id: form.id,
      label: form.label.trim().length > 0 ? form.label.trim() : undefined,
      command: form.command.trim(),
      args: form.args.trim().length > 0 ? form.args.trim().split(/\s+/) : [],
      cwd: form.cwd.trim().length > 0 ? form.cwd.trim() : undefined,
      port,
      bind: form.bind,
      autostart: form.autostart,
    })

    if (control.lastError.value !== null) {
      error.value = control.lastError.value
      return
    }

    selectedId.value = form.id
    flash(`added ${form.id}`)
    Object.assign(form, { id: '', label: '', command: '', args: '', cwd: '', port: '', bind: 'local', autostart: false })
    emit('close')
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <div v-if="open" class="overlay" @click.self="emit('close')">
    <div class="overlay__panel dialog" role="dialog" aria-label="add a server">
      <div class="overlay__head">
        <span class="overlay__title">add server</span>
        <span class="view__spacer" />
        <span class="faint">writes to servers.config.json</span>
        <kbd class="kbd">esc</kbd>
      </div>

      <form class="overlay__body form" @submit.prevent="submit">
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

        <p v-if="error" class="note note--error">
          {{ error }}
        </p>

        <div class="actions">
          <button type="button" class="btn btn--sm" @click="emit('close')">
            cancel
          </button>
          <button type="submit" class="btn btn--sm btn--primary" :disabled="busy">
            add server
          </button>
        </div>
      </form>
    </div>
  </div>
</template>
