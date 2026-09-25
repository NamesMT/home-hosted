<script setup lang="ts">
import type { HealthConfig, RestartConfig, StopConfig } from '@shared/contracts'
import { computed } from 'vue'
import FieldGroup from '@/components/ui/FieldGroup.vue'
import NumberField from '@/components/ui/NumberField.vue'
import SelectField from '@/components/ui/SelectField.vue'
import TextField from '@/components/ui/TextField.vue'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'

/**
 * The three nested policy groups shared by the global defaults and every
 * server entry: restart backoff, health probing and stop behaviour.
 */
withDefaults(defineProps<{ showHttp?: boolean }>(), { showHttp: true })

const restart = defineModel<RestartConfig>('restart', { required: true })
const health = defineModel<HealthConfig>('health', { required: true })
const stop = defineModel<StopConfig>('stop', { required: true })

/** NumberField speaks `number | null`; stored config never carries null here. */
function required(get: () => number, set: (value: number) => void, fallback = 0) {
  return computed<number | null>({
    get,
    set: value => set(value ?? fallback),
  })
}

const maxRetries = required(() => restart.value.maxRetries, value => (restart.value.maxRetries = value))
const baseDelayMs = required(() => restart.value.baseDelayMs, value => (restart.value.baseDelayMs = value))
const factor = required(() => restart.value.factor, value => (restart.value.factor = value), 1)
const maxDelayMs = required(() => restart.value.maxDelayMs, value => (restart.value.maxDelayMs = value))
const resetAfterMs = required(() => restart.value.resetAfterMs, value => (restart.value.resetAfterMs = value))

const intervalMs = required(() => health.value.intervalMs, value => (health.value.intervalMs = value), 500)
const timeoutMs = required(() => health.value.timeoutMs, value => (health.value.timeoutMs = value), 100)
const unhealthyThreshold = required(() => health.value.unhealthyThreshold, value => (health.value.unhealthyThreshold = value), 1)
const forceRestartAfterMs = required(() => health.value.forceRestartAfterMs, value => (health.value.forceRestartAfterMs = value))
const startTimeoutMs = required(() => health.value.startTimeoutMs, value => (health.value.startTimeoutMs = value))
const expectStatus = computed<number | null>({
  get: () => health.value.http.expectStatus ?? null,
  set: (value) => {
    if (value === null || Number.isNaN(value))
      delete health.value.http.expectStatus
    else health.value.http.expectStatus = value
  },
})
const expectStatusBelow = required(() => health.value.http.expectStatusBelow, value => (health.value.http.expectStatusBelow = value), 400)

const graceMs = required(() => stop.value.graceMs, value => (stop.value.graceMs = value))

const signalOptions = [
  { value: 'SIGTERM', label: 'SIGTERM — ask it to stop' },
  { value: 'SIGINT', label: 'SIGINT — interrupt (Ctrl-C)' },
  { value: 'SIGKILL', label: 'SIGKILL — kill immediately' },
]
</script>

<template>
  <FieldGroup
    title="Restart policy"
    description="Backoff between attempts after a crash."
    :columns="3"
  >
    <ToggleSwitch v-model="restart.enabled" label="Restart on crash" wide />
    <NumberField v-model="maxRetries" label="Max retries" :min="0" hint="Attempts before the server is left crashed." />
    <NumberField v-model="baseDelayMs" label="Base delay (ms)" :min="0" />
    <NumberField v-model="factor" label="Backoff factor" :min="1" :step="0.1" />
    <NumberField v-model="maxDelayMs" label="Max delay (ms)" :min="0" />
    <NumberField v-model="resetAfterMs" label="Reset after (ms)" :min="0" hint="A run this long clears the retry counter." />
  </FieldGroup>

  <FieldGroup
    title="Health check"
    description="How readiness is probed once the process is up."
    :columns="3"
  >
    <ToggleSwitch v-model="health.enabled" label="Probe this server" wide />
    <SelectField
      v-model="health.mode"
      label="Probe type"
      :options="[
        { value: 'port', label: 'TCP port — connection only' },
        { value: 'http', label: 'HTTP request — assert a response' },
      ]"
    />
    <NumberField v-model="intervalMs" label="Interval (ms)" :min="500" :step="100" />
    <NumberField v-model="timeoutMs" label="Timeout (ms)" :min="100" :step="100" />
    <NumberField v-model="unhealthyThreshold" label="Unhealthy after" :min="1" hint="Consecutive failed probes." />
    <NumberField v-model="forceRestartAfterMs" label="Force restart after (ms)" :min="0" hint="0 disables it." />
    <NumberField v-model="startTimeoutMs" label="Start timeout (ms)" :min="0" />

    <template v-if="showHttp && health.mode === 'http'">
      <TextField v-model="health.http.path" label="HTTP path" placeholder="/healthz" />
      <SelectField
        v-model="health.http.method"
        label="HTTP method"
        :options="[
          { value: 'GET', label: 'GET' },
          { value: 'HEAD', label: 'HEAD' },
        ]"
      />
      <NumberField v-model="expectStatus" label="Expect status" nullable hint="Blank accepts anything below." />
      <NumberField v-model="expectStatusBelow" label="Healthy below status" :min="100" />
      <TextField v-model="health.http.expectBody" label="Body must contain" placeholder="optional substring" wide />
    </template>
  </FieldGroup>

  <FieldGroup
    title="Stop behaviour"
    description="How the process tree is asked to go away."
    :columns="3"
  >
    <SelectField v-model="stop.signal" label="Signal" :options="signalOptions" />
    <NumberField v-model="graceMs" label="Grace period (ms)" :min="0" />
    <ToggleSwitch v-model="stop.killGroup" label="Kill the whole process group" />
    <ToggleSwitch v-model="stop.killPortHolders" label="Also kill whatever holds the port" wide />
  </FieldGroup>
</template>
