<script setup lang="ts">
import type { HostConfig } from '@shared/contracts'
import type { HostForm } from '@/components/settings/settingsForm'
import { numberModel } from '@/components/settings/settingsForm'
import AppButton from '@/components/ui/AppButton.vue'
import FieldGroup from '@/components/ui/FieldGroup.vue'
import NumberField from '@/components/ui/NumberField.vue'
import TextField from '@/components/ui/TextField.vue'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import ToneBadge from '@/components/ui/ToneBadge.vue'
import { t } from '@/i18n'

const props = defineProps<{
  /** The saved block, for the JSON preview and the dirty check. */
  config: HostConfig | null
  alerts: string[]
  dirty: boolean
}>()

const emit = defineEmits<{ reset: [] }>()

const host = defineModel<HostForm>('host', { required: true })

const intervalMs = numberModel(() => host.value.intervalMs, value => (host.value.intervalMs = value), 15_000)
const diskUsedPercent = numberModel(() => host.value.diskUsedPercent, value => (host.value.diskUsedPercent = value), 90)
const memoryUsedPercent = numberModel(() => host.value.memoryUsedPercent, value => (host.value.memoryUsedPercent = value), 90)
const swapUsedPercent = numberModel(() => host.value.swapUsedPercent, value => (host.value.swapUsedPercent = value), 50)
const loadPerCpu = numberModel(() => host.value.loadPerCpu, value => (host.value.loadPerCpu = value), 2)
const tempCelsius = numberModel(() => host.value.tempCelsius, value => (host.value.tempCelsius = value), 85)
</script>

<template>
  <FieldGroup
    :title="t('settings.host.title')"
    :description="t('settings.host.description')"
  >
    <template #actions>
      <AppButton size="xs" variant="ghost" :disabled="!props.dirty" @click="emit('reset')">
        {{ t('common.reset') }}
      </AppButton>
    </template>

    <ToggleSwitch
      v-model="host.enabled"
      :label="t('settings.host.enabled')"
      :hint="t('settings.host.enabledHint')"
      wide
    />
    <NumberField v-model="intervalMs" :label="t('settings.host.interval')" :min="5000" :hint="t('settings.host.intervalHint')" />
    <TextField v-model="host.diskPaths" :label="t('settings.host.diskPaths')" :hint="t('settings.host.diskPathsHint')" />
    <NumberField v-model="diskUsedPercent" :label="t('settings.host.diskUsed')" :min="0" :max="100" :hint="t('settings.host.zeroDisables')" />
    <NumberField v-model="memoryUsedPercent" :label="t('settings.host.memoryUsed')" :min="0" :max="100" :hint="t('settings.host.zeroDisables')" />
    <NumberField v-model="swapUsedPercent" :label="t('settings.host.swapUsed')" :min="0" :max="100" :hint="t('settings.host.zeroDisables')" />
    <NumberField v-model="loadPerCpu" :label="t('settings.host.loadPerCpu')" :min="0" :hint="t('settings.host.loadPerCpuHint')" />
    <NumberField v-model="tempCelsius" :label="t('settings.host.tempCelsius')" :min="0" :hint="t('settings.host.tempCelsiusHint')" />
  </FieldGroup>

  <div v-if="props.alerts.length > 0" class="mt-3 flex flex-wrap items-center gap-1.5">
    <span class="text-xs text-muted">{{ t('settings.host.breachingNow') }}</span>
    <ToneBadge v-for="alert in props.alerts" :key="alert" tone="danger" dot>
      {{ alert }}
    </ToneBadge>
  </div>
  <p v-else-if="host.enabled" class="mt-3 text-xs text-muted">
    {{ t('settings.host.nothingBreaching') }}
  </p>
</template>
