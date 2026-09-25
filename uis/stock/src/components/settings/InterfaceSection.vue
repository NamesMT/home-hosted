<script setup lang="ts">
import type { UiStatus } from '@/lib/api'
import { computed, ref } from 'vue'
import Notice from '@/components/settings/Notice.vue'
import AppButton from '@/components/ui/AppButton.vue'
import CopyButton from '@/components/ui/CopyButton.vue'
import FieldGroup from '@/components/ui/FieldGroup.vue'
import TextField from '@/components/ui/TextField.vue'
import * as api from '@/lib/api'

const props = defineProps<{ ui: UiStatus | null, labelDirty: boolean }>()
const emit = defineEmits<{ changed: [], resetLabel: [] }>()

/** `control.label`: what this panel calls itself in the shell. */
const label = defineModel<string>('label', { required: true })

const file = ref<File | null>(null)
const busy = ref(false)
const message = ref<string | null>(null)
const error = ref<string | null>(null)
const confirmingRevert = ref(false)

const source = computed(() => {
  const ui = props.ui
  if (ui === null)
    return 'unknown'
  if (!ui.custom)
    return 'stock'
  const meta = ui.meta
  return meta === null ? 'custom' : `custom · ${meta.name}${meta.version === null ? '' : ` ${meta.version}`}`
})

const uploaded = computed(() => {
  const meta = props.ui?.meta
  return meta == null ? null : `${meta.files} files · ${new Date(meta.uploadedAt).toLocaleString()}`
})

function pick(event: Event): void {
  file.value = (event.target as HTMLInputElement).files?.[0] ?? null
  message.value = null
  error.value = null
}

async function install(): Promise<void> {
  if (file.value === null)
    return
  busy.value = true
  error.value = null
  message.value = null
  try {
    const result = await api.uploadUi(file.value)
    message.value = `UI replaced with ${result.meta?.name ?? 'your build'} — refresh the page`
    file.value = null
    emit('changed')
  }
  catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  }
  finally {
    busy.value = false
  }
}

async function revert(): Promise<void> {
  if (!confirmingRevert.value) {
    confirmingRevert.value = true
    setTimeout(() => {
      confirmingRevert.value = false
    }, 5000)
    return
  }
  confirmingRevert.value = false
  busy.value = true
  error.value = null
  try {
    const result = await api.revertUi()
    message.value = result.removed ? 'stock UI restored — refresh the page' : 'no custom UI was installed'
    emit('changed')
  }
  catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <FieldGroup
    title="Interface"
    description="The panel is a static site: keep the stock one, or serve your own build from the state directory."
  >
    <div class="flex min-w-0 flex-col gap-1 sm:col-span-2">
      <span class="text-xs font-medium text-muted">Currently serving</span>
      <div class="flex items-center gap-1.5 rounded-control border border-line bg-page/60 px-2.5 py-1.5">
        <span class="min-w-0 flex-1 truncate font-mono text-xs text-ink">{{ source }}</span>
        <CopyButton :value="ui?.dir ?? ''" label="Copy the UI directory" />
      </div>
      <p class="text-2xs leading-4 text-faint">
        <span v-if="uploaded">{{ uploaded }} · </span>
        <code>{{ ui?.dir ?? '—' }}</code>
      </p>
    </div>

    <TextField
      v-model="label"
      label="Panel name"
      hint="Shown in the sidebar by the stock UI. A custom UI may show its own name instead."
      wide
    />

    <label class="flex min-w-0 flex-col gap-1 sm:col-span-2">
      <span class="text-xs font-medium text-muted">Upload a UI build (.zip with an index.html)</span>
      <input
        type="file"
        accept=".zip,application/zip"
        class="rounded-control border border-line bg-page/60 px-2.5 py-1.5 text-xs text-ink file:mr-2 file:rounded file:border-0 file:bg-line file:px-2 file:py-1 file:text-xs"
        :disabled="busy"
        @change="pick"
      >
    </label>

    <Notice v-if="error" tone="warn" :title="error" />
    <Notice v-else-if="message" tone="ok" :title="message" />

    <p class="text-2xs leading-4 text-faint sm:col-span-2">
      See <code>docs/UI_CREATION.md</code> for the API contract. If a custom UI breaks the panel,
      <code>home-hosted ui-revert</code> puts the stock one back from the terminal.
    </p>

    <template #actions>
      <AppButton size="xs" variant="ghost" :disabled="!props.labelDirty" @click="emit('resetLabel')">
        Reset name
      </AppButton>
      <AppButton v-if="ui?.custom" size="xs" variant="ghost" :disabled="busy" @click="revert">
        {{ confirmingRevert ? 'Confirm revert' : 'Revert to stock' }}
      </AppButton>
      <AppButton size="xs" variant="primary" :disabled="busy || file === null" @click="install">
        Install UI
      </AppButton>
    </template>
  </FieldGroup>
</template>
