<script setup lang="ts">
import type { DefaultsForm } from '@/components/settings/settingsForm'
import LifecycleFields from '@/components/server/LifecycleFields.vue'
import { numberModel } from '@/components/settings/settingsForm'
import AppButton from '@/components/ui/AppButton.vue'
import FieldGroup from '@/components/ui/FieldGroup.vue'
import NumberField from '@/components/ui/NumberField.vue'
import SelectField from '@/components/ui/SelectField.vue'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import { t } from '@/i18n'

const props = defineProps<{ dirty: boolean }>()

const emit = defineEmits<{ reset: [] }>()

const defaults = defineModel<DefaultsForm>('defaults', { required: true })

const logBufferLines = numberModel(() => defaults.value.logBufferLines, value => (defaults.value.logBufferLines = value), 500)
</script>

<template>
  <FieldGroup
    :title="t('settings.defaults.title')"
    :description="t('settings.defaults.description')"
  >
    <template #actions>
      <AppButton size="xs" variant="ghost" :disabled="!props.dirty" @click="emit('reset')">
        {{ t('common.reset') }}
      </AppButton>
    </template>

    <ToggleSwitch v-model="defaults.enabled" :label="t('common.enabled')" :hint="t('settings.defaults.enabledHint')" wide />
    <ToggleSwitch v-model="defaults.autostart" :label="t('settings.defaults.autostart')" />
    <SelectField
      v-model="defaults.bind"
      :label="t('settings.defaults.bind')"
      :options="[
        { value: 'local', label: t('settings.defaults.bindLocal') },
        { value: 'lan', label: t('settings.defaults.bindLan') },
      ]"
    />
    <SelectField
      v-model="defaults.onPortConflict"
      :label="t('settings.defaults.onPortConflict')"
      :options="[
        { value: 'block', label: t('settings.defaults.conflictBlock') },
        { value: 'warn', label: t('settings.defaults.conflictWarn') },
        { value: 'follow', label: t('settings.defaults.conflictFollow') },
        { value: 'reclaim', label: t('settings.defaults.conflictReclaim') },
        { value: 'kill', label: t('settings.defaults.conflictKill') },
      ]"
    />
    <NumberField v-model="logBufferLines" :label="t('settings.defaults.logBufferLines')" :min="50" :max="100000" :hint="t('settings.defaults.logBufferLinesHint')" />
  </FieldGroup>

  <div class="mt-3 space-y-3">
    <LifecycleFields
      v-model:restart="defaults.restart"
      v-model:health="defaults.health"
      v-model:stop="defaults.stop"
    />
  </div>
</template>
