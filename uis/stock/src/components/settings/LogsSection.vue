<script setup lang="ts">
import type { LogsForm } from '@/components/settings/settingsForm'
import { computed } from 'vue'
import { numberModel } from '@/components/settings/settingsForm'
import AppButton from '@/components/ui/AppButton.vue'
import CopyButton from '@/components/ui/CopyButton.vue'
import FieldGroup from '@/components/ui/FieldGroup.vue'
import NumberField from '@/components/ui/NumberField.vue'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import TransText from '@/components/ui/TransText.vue'
import { useWorkspaces } from '@/composables/useWorkspaces'
import { t } from '@/i18n'
import { workspacePath } from '@/router'

const props = defineProps<{
  logsDir: string | null
  dirty: boolean
}>()

const emit = defineEmits<{ reset: [] }>()

const logs = defineModel<LogsForm>('logs', { required: true })

const workspace = useWorkspaces()

const maxBytes = numberModel(() => logs.value.maxBytes, value => (logs.value.maxBytes = value), 2_000_000)
const keep = numberModel(() => logs.value.keep, value => (logs.value.keep = value), 3)

const directory = computed(() => props.logsDir ?? '—')
</script>

<template>
  <FieldGroup
    :title="t('settings.logs.title')"
    :description="t('settings.logs.description')"
  >
    <template #actions>
      <AppButton size="xs" variant="ghost" :disabled="!props.dirty" @click="emit('reset')">
        {{ t('common.reset') }}
      </AppButton>
    </template>

    <ToggleSwitch
      v-model="logs.persist"
      :label="t('settings.logs.persist')"
      :hint="t('settings.logs.persistHint')"
      class="sm:col-span-2"
    />
    <NumberField v-model="maxBytes" :label="t('settings.logs.maxBytes')" :min="10000" :max="100000000" :hint="t('settings.logs.maxBytesHint')" />
    <NumberField v-model="keep" :label="t('settings.logs.keep')" :min="1" :max="10" />

    <div class="flex min-w-0 flex-col gap-1 sm:col-span-2">
      <span class="text-xs font-medium text-muted">{{ t('settings.logs.directory') }}</span>
      <div class="flex items-center gap-1.5 rounded-control border border-line bg-page/60 px-2.5 py-1.5">
        <span class="min-w-0 flex-1 truncate font-mono text-xs text-ink">{{ directory }}</span>
        <CopyButton :value="directory" :label="t('settings.logs.copyDirectory')" />
      </div>
      <p class="text-2xs leading-4 text-faint">
        <TransText k="settings.logs.browseHint">
          <template #logs>
            <RouterLink :to="workspacePath(workspace.activeId.value, 'logs')" class="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent">
              {{ t('nav.logs') }}
            </RouterLink>
          </template>
        </TransText>
      </p>
    </div>
  </FieldGroup>
</template>
