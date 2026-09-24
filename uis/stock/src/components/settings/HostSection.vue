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
    title="Thresholds"
    description="A threshold of 0 disables that alert. Breaches notify once, and once more on recovery."
  >
    <template #actions>
      <AppButton size="xs" variant="ghost" :disabled="!props.dirty" @click="emit('reset')">
        Reset
      </AppButton>
    </template>

    <ToggleSwitch
      v-model="host.enabled"
      label="Sample this machine"
      hint="Load, memory, swap, disk and CPU temperature, on the interval below."
      class="sm:col-span-2"
    />
    <NumberField v-model="intervalMs" label="Interval (ms)" :min="5000" hint="How often the host is sampled and alerts are checked." />
    <TextField v-model="host.diskPaths" label="Disk paths" hint="Comma separated; templates like {home} are expanded." />
    <NumberField v-model="diskUsedPercent" label="Disk used (%)" :min="0" :max="100" hint="0 disables the alert." />
    <NumberField v-model="memoryUsedPercent" label="Memory used (%)" :min="0" :max="100" hint="0 disables the alert." />
    <NumberField v-model="swapUsedPercent" label="Swap used (%)" :min="0" :max="100" hint="0 disables the alert." />
    <NumberField v-model="loadPerCpu" label="Load per CPU" :min="0" hint="1-minute load average divided by the core count." />
    <NumberField v-model="tempCelsius" label="CPU temperature (°C)" :min="0" hint="Linux only; ignored where the OS does not expose it." />
  </FieldGroup>

  <div v-if="props.alerts.length > 0" class="mt-3 flex flex-wrap items-center gap-1.5">
    <span class="text-xs text-muted">Breaching now:</span>
    <ToneBadge v-for="alert in props.alerts" :key="alert" tone="danger" dot>
      {{ alert }}
    </ToneBadge>
  </div>
  <p v-else-if="host.enabled" class="mt-3 text-xs text-muted">
    Nothing is breaching right now.
  </p>
</template>
