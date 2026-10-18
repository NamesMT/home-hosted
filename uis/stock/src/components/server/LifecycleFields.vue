<script setup lang="ts">
import type { HealthConfig, RestartConfig, StopConfig } from '@shared/contracts'
import { computed } from 'vue'
import FieldGroup from '@/components/ui/FieldGroup.vue'
import NumberField from '@/components/ui/NumberField.vue'
import SelectField from '@/components/ui/SelectField.vue'
import TextField from '@/components/ui/TextField.vue'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import { t } from '@/i18n'

/**
 * The three nested policy groups shared by the global defaults and every
 * server entry: restart backoff, health probing and stop behaviour.
 */
withDefaults(defineProps<{ showHttp?: boolean }>(), { showHttp: true })

const restart = defineModel<RestartConfig>('restart', { required: true })
const health = defineModel<HealthConfig>('health', { required: true })
const stop = defineModel<StopConfig>('stop', { required: true })

/**
 * NumberField speaks `number | null`; stored config never carries null here.
 *
 * A cleared, non-nullable field reads as `NaN`, not `null` (`readNumber`), so `??`
 * alone let it through: the saved payload then failed schema validation with
 * "maxRetries must be a number (was NaN)" and the whole form could not be saved.
 * Fall back rather than storing a value no schema accepts.
 */
function required(get: () => number, set: (value: number) => void, fallback = 0) {
  return computed<number | null>({
    get,
    set: value => set(value === null || Number.isNaN(value) ? fallback : value),
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

const signalOptions = computed(() => [
  { value: 'SIGTERM', label: t('lifecycle.signalTerm') },
  { value: 'SIGINT', label: t('lifecycle.signalInt') },
  { value: 'SIGKILL', label: t('lifecycle.signalKill') },
])
</script>

<template>
  <FieldGroup
    :title="t('lifecycle.restartTitle')"
    :description="t('lifecycle.restartDescription')"
    :columns="3"
  >
    <ToggleSwitch v-model="restart.enabled" :label="t('lifecycle.restartOnCrash')" wide />
    <NumberField v-model="maxRetries" :label="t('lifecycle.maxRetries')" :min="0" :hint="t('lifecycle.maxRetriesHint')" />
    <NumberField v-model="baseDelayMs" :label="t('lifecycle.baseDelay')" :min="0" />
    <NumberField v-model="factor" :label="t('lifecycle.factor')" :min="1" :step="0.1" />
    <NumberField v-model="maxDelayMs" :label="t('lifecycle.maxDelay')" :min="0" />
    <NumberField v-model="resetAfterMs" :label="t('lifecycle.resetAfter')" :min="0" :hint="t('lifecycle.resetAfterHint')" />
  </FieldGroup>

  <FieldGroup
    :title="t('lifecycle.healthTitle')"
    :description="t('lifecycle.healthDescription')"
    :columns="3"
  >
    <ToggleSwitch v-model="health.enabled" :label="t('lifecycle.probe')" wide />
    <SelectField
      v-model="health.mode"
      :label="t('lifecycle.probeType')"
      :options="[
        { value: 'port', label: t('lifecycle.probePort') },
        { value: 'http', label: t('lifecycle.probeHttp') },
      ]"
    />
    <NumberField v-model="intervalMs" :label="t('lifecycle.interval')" :min="500" :step="100" />
    <NumberField v-model="timeoutMs" :label="t('lifecycle.timeout')" :min="100" :step="100" />
    <NumberField v-model="unhealthyThreshold" :label="t('lifecycle.unhealthyAfter')" :min="1" :hint="t('lifecycle.unhealthyAfterHint')" />
    <NumberField v-model="forceRestartAfterMs" :label="t('lifecycle.forceRestartAfter')" :min="0" :hint="t('lifecycle.forceRestartAfterHint')" />
    <NumberField v-model="startTimeoutMs" :label="t('lifecycle.startTimeout')" :min="0" />

    <template v-if="showHttp && health.mode === 'http'">
      <SelectField
        v-model="health.http.scheme"
        :label="t('lifecycle.httpScheme')"
        :options="[
          { value: 'http', label: 'http' },
          { value: 'https', label: 'https' },
        ]"
      />
      <TextField v-model="health.http.path" :label="t('lifecycle.httpPath')" placeholder="/healthz" />
      <SelectField
        v-model="health.http.method"
        :label="t('lifecycle.httpMethod')"
        :options="[
          { value: 'GET', label: 'GET' },
          { value: 'HEAD', label: 'HEAD' },
        ]"
      />
      <NumberField v-model="expectStatus" :label="t('lifecycle.expectStatus')" nullable :hint="t('lifecycle.expectStatusHint')" />
      <NumberField v-model="expectStatusBelow" :label="t('lifecycle.expectStatusBelow')" :min="100" />
      <ToggleSwitch
        v-if="health.http.scheme === 'https'"
        v-model="health.http.allowInvalidCert"
        :label="t('lifecycle.allowInvalidCert')"
        :hint="t('lifecycle.allowInvalidCertHint')"
        wide
      />
      <TextField
        v-model="health.http.expectBody"
        :label="t('lifecycle.expectBody')"
        :placeholder="t('lifecycle.expectBodyPlaceholder')"
        wide
        :hint="health.http.method === 'HEAD' && health.http.expectBody.length > 0
          ? t('lifecycle.headBodyHint')
          : undefined"
      />
    </template>
  </FieldGroup>

  <FieldGroup
    :title="t('lifecycle.stopTitle')"
    :description="t('lifecycle.stopDescription')"
    :columns="3"
  >
    <SelectField v-model="stop.signal" :label="t('lifecycle.signal')" :options="signalOptions" />
    <NumberField v-model="graceMs" :label="t('lifecycle.grace')" :min="0" />
    <ToggleSwitch v-model="stop.killGroup" :label="t('lifecycle.killGroup')" />
    <ToggleSwitch v-model="stop.killPortHolders" :label="t('lifecycle.killPortHolders')" wide />
  </FieldGroup>
</template>
