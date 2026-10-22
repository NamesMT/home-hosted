<script setup lang="ts">
import type { UiStatus } from '@/lib/api'
import { errorMessage } from '@shared/error-message'
import { computed, ref } from 'vue'
import Notice from '@/components/settings/Notice.vue'
import AppButton from '@/components/ui/AppButton.vue'
import CopyButton from '@/components/ui/CopyButton.vue'
import FieldGroup from '@/components/ui/FieldGroup.vue'
import TextField from '@/components/ui/TextField.vue'
import TransText from '@/components/ui/TransText.vue'
import { t } from '@/i18n'
import * as api from '@/lib/api'
import { formatDateTime } from '@/lib/format'

const props = defineProps<{ ui: UiStatus | null, panelVersion: string | null, labelDirty: boolean }>()
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
    return t('common.unknown')
  if (!ui.custom)
    return t('settings.interface.sourceStock')
  const meta = ui.meta
  return meta === null
    ? t('settings.interface.sourceCustom')
    : `${t('settings.interface.sourceCustom')} · ${meta.name ?? t('settings.interface.unnamed')}${meta.version == null ? '' : ` ${meta.version}`}`
})

const uploaded = computed(() => {
  const meta = props.ui?.meta
  if (meta == null)
    return null
  const when = meta.uploadedAt === undefined ? null : formatDateTime(meta.uploadedAt)
  const count = t('settings.interface.fileCount', { count: meta.files ?? 0 })
  return `${count}${when === null ? '' : ` · ${when}`}`
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
    message.value = t('settings.interface.installed', { name: result.meta?.name ?? t('settings.interface.yourBuild') })
    file.value = null
    emit('changed')
  }
  catch (caught) {
    error.value = errorMessage(caught)
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
    message.value = result.removed ? t('settings.interface.restored') : t('settings.interface.nothingInstalled')
    emit('changed')
  }
  catch (caught) {
    error.value = errorMessage(caught)
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <FieldGroup
    :title="t('settings.interface.title')"
    :description="t('settings.interface.description')"
  >
    <div class="flex min-w-0 flex-col gap-1 sm:col-span-2">
      <span class="text-xs font-medium text-muted">{{ t('settings.interface.currentlyServing') }}</span>
      <div class="flex items-center gap-1.5 rounded-control border border-line bg-page/60 px-2.5 py-1.5">
        <span class="min-w-0 flex-1 truncate font-mono text-xs text-ink">{{ source }}</span>
        <CopyButton :value="ui?.dir ?? ''" :label="t('settings.interface.copyDirectory')" />
      </div>
      <p class="text-2xs leading-4 text-faint">
        <span v-if="uploaded">{{ uploaded }} · </span>
        <code>{{ ui?.dir ?? '—' }}</code>
      </p>
    </div>

    <div class="flex min-w-0 flex-col gap-1 sm:col-span-2">
      <span class="text-xs font-medium text-muted">{{ t('settings.interface.panelVersion') }}</span>
      <div class="flex items-center gap-1.5 rounded-control border border-line bg-page/60 px-2.5 py-1.5">
        <span class="min-w-0 flex-1 truncate font-mono text-xs text-ink">{{ t('app.name') }} {{ props.panelVersion ?? t('common.unknown') }}</span>
        <CopyButton v-if="props.panelVersion" :value="props.panelVersion" :label="t('settings.interface.copyPanelVersion')" />
      </div>
      <p class="text-2xs leading-4 text-faint">
        <TransText k="settings.interface.panelVersionHint">
          <template #command>
            <code>home-hosted status</code>
          </template>
        </TransText>
      </p>
    </div>

    <TextField
      v-model="label"
      :label="t('settings.interface.panelName')"
      :hint="t('settings.interface.panelNameHint')"
      wide
    />

    <label class="flex min-w-0 flex-col gap-1 sm:col-span-2">
      <span class="text-xs font-medium text-muted">{{ t('settings.interface.uploadLabel') }}</span>
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
      <TransText k="settings.interface.docsHint">
        <template #docs>
          <code>docs/UI_CREATION.md</code>
        </template>
        <template #command>
          <code>home-hosted ui-revert</code>
        </template>
      </TransText>
    </p>

    <template #actions>
      <AppButton size="xs" variant="ghost" :disabled="!props.labelDirty" @click="emit('resetLabel')">
        {{ t('settings.interface.resetName') }}
      </AppButton>
      <AppButton v-if="ui?.custom" size="xs" variant="ghost" :disabled="busy" @click="revert">
        {{ confirmingRevert ? t('settings.interface.confirmRevert') : t('settings.interface.revertToStock') }}
      </AppButton>
      <AppButton size="xs" variant="primary" :disabled="busy || file === null" @click="install">
        {{ t('settings.interface.install') }}
      </AppButton>
    </template>
  </FieldGroup>
</template>
