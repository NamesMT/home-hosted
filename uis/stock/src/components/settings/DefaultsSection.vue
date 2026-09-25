<script setup lang="ts">
import type { DefaultsForm } from '@/components/settings/settingsForm'
import LifecycleFields from '@/components/server/LifecycleFields.vue'
import { numberModel } from '@/components/settings/settingsForm'
import AppButton from '@/components/ui/AppButton.vue'
import FieldGroup from '@/components/ui/FieldGroup.vue'
import NumberField from '@/components/ui/NumberField.vue'
import SelectField from '@/components/ui/SelectField.vue'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'

const props = defineProps<{ dirty: boolean }>()

const emit = defineEmits<{ reset: [] }>()

const defaults = defineModel<DefaultsForm>('defaults', { required: true })

const logBufferLines = numberModel(() => defaults.value.logBufferLines, value => (defaults.value.logBufferLines = value), 500)
</script>

<template>
  <FieldGroup
    title="Server defaults"
    description="Applied to every entry that does not set its own value."
  >
    <template #actions>
      <AppButton size="xs" variant="ghost" :disabled="!props.dirty" @click="emit('reset')">
        Reset
      </AppButton>
    </template>

    <ToggleSwitch v-model="defaults.enabled" label="Enabled" hint="New entries start enabled." wide />
    <ToggleSwitch v-model="defaults.autostart" label="Autostart with the panel" />
    <SelectField
      v-model="defaults.bind"
      label="Bind"
      :options="[
        { value: 'local', label: 'Local — 127.0.0.1' },
        { value: 'lan', label: 'LAN — 0.0.0.0' },
      ]"
    />
    <SelectField
      v-model="defaults.onPortConflict"
      label="On port conflict"
      :options="[
        { value: 'block', label: 'Block the start' },
        { value: 'warn', label: 'Warn and start anyway' },
        { value: 'follow', label: 'Follow a detached restart of itself' },
        { value: 'reclaim', label: 'Replace a detached restart with a supervised copy' },
      ]"
    />
    <NumberField v-model="logBufferLines" label="Log buffer lines" :min="50" :max="100000" hint="Kept in memory per server." />
  </FieldGroup>

  <div class="mt-3 space-y-3">
    <LifecycleFields
      v-model:restart="defaults.restart"
      v-model:health="defaults.health"
      v-model:stop="defaults.stop"
    />
  </div>
</template>
