<script setup lang="ts">
import type { HealthConfig, RestartConfig, StopConfig } from '@shared/contracts'
import { computed } from 'vue'

// Models hold the caller's reactive objects, so editing a field updates the form
// the parent will submit.
const restart = defineModel<RestartConfig>('restart', { required: true })
const health = defineModel<HealthConfig>('health', { required: true })
const stop = defineModel<StopConfig>('stop', { required: true })

/**
 * The contract accepts `null` to clear an exact-status check; a blank input maps
 * to `null`, never to an empty string or a dropped key (a nested merge would
 * keep the previous value).
 */
const expectStatus = computed<string>({
  get: () => health.value.http.expectStatus == null ? '' : String(health.value.http.expectStatus),
  set: (raw) => {
    health.value.http.expectStatus = raw.trim() === '' ? null : Number(raw)
  },
})

const signals: Array<StopConfig['signal']> = ['SIGTERM', 'SIGINT', 'SIGKILL']
</script>

<template>
  <div class="group">
    <div class="group__head">
      <span class="group__title">restart</span>
      <span class="faint">applies to entries that do not override it</span>
    </div>
    <div class="grid">
      <label class="field field--check">
        <input v-model="restart.enabled" type="checkbox">
        <span class="field__label">enabled</span>
      </label>
      <label class="field">
        <span class="field__label">max retries</span>
        <input v-model.number="restart.maxRetries" inputmode="numeric">
      </label>
      <label class="field">
        <span class="field__label">base delay (ms)</span>
        <input v-model.number="restart.baseDelayMs" inputmode="numeric">
      </label>
      <label class="field">
        <span class="field__label">factor</span>
        <input v-model.number="restart.factor" inputmode="numeric">
      </label>
      <label class="field">
        <span class="field__label">max delay (ms)</span>
        <input v-model.number="restart.maxDelayMs" inputmode="numeric">
      </label>
      <label class="field">
        <span class="field__label">reset after (ms)</span>
        <input v-model.number="restart.resetAfterMs" inputmode="numeric">
      </label>
    </div>
  </div>

  <div class="group">
    <div class="group__head">
      <span class="group__title">port health</span>
      <span class="faint">readiness and liveness probes</span>
    </div>
    <div class="grid">
      <label class="field field--check">
        <input v-model="health.enabled" type="checkbox">
        <span class="field__label">enabled</span>
      </label>
      <label class="field">
        <span class="field__label">check</span>
        <select v-model="health.mode">
          <option value="port">tcp port</option>
          <option value="http">http request</option>
        </select>
      </label>
      <label class="field">
        <span class="field__label">interval (ms)</span>
        <input v-model.number="health.intervalMs" inputmode="numeric">
      </label>
      <label class="field">
        <span class="field__label">timeout (ms)</span>
        <input v-model.number="health.timeoutMs" inputmode="numeric">
      </label>
      <label class="field">
        <span class="field__label">unhealthy after</span>
        <input v-model.number="health.unhealthyThreshold" inputmode="numeric">
      </label>
      <label class="field">
        <span class="field__label">force restart after (ms, 0 = never)</span>
        <input v-model.number="health.forceRestartAfterMs" inputmode="numeric">
      </label>
      <label class="field">
        <span class="field__label">start timeout (ms)</span>
        <input v-model.number="health.startTimeoutMs" inputmode="numeric">
      </label>
    </div>

    <div v-if="health.http" class="grid grid--wide">
      <label class="field">
        <span class="field__label">http path</span>
        <input v-model="health.http.path" placeholder="/healthz">
      </label>
      <label class="field">
        <span class="field__label">method</span>
        <select v-model="health.http.method">
          <option value="GET">GET</option>
          <option value="HEAD">HEAD</option>
        </select>
      </label>
      <label class="field">
        <span class="field__label">exact status (blank = below)</span>
        <input v-model="expectStatus" inputmode="numeric" placeholder="any">
      </label>
      <label class="field">
        <span class="field__label">healthy below status</span>
        <input v-model.number="health.http.expectStatusBelow" inputmode="numeric">
      </label>
      <label class="field">
        <span class="field__label">body must contain</span>
        <input v-model="health.http.expectBody" placeholder="optional substring">
      </label>
    </div>
  </div>

  <div class="group">
    <div class="group__head">
      <span class="group__title">stop</span>
    </div>
    <div class="grid">
      <label class="field">
        <span class="field__label">signal</span>
        <select v-model="stop.signal">
          <option v-for="signal in signals" :key="signal" :value="signal">{{ signal }}</option>
        </select>
      </label>
      <label class="field">
        <span class="field__label">grace (ms)</span>
        <input v-model.number="stop.graceMs" inputmode="numeric">
      </label>
      <label class="field field--check">
        <input v-model="stop.killGroup" type="checkbox">
        <span class="field__label">kill process group</span>
      </label>
      <label class="field field--check">
        <input v-model="stop.killPortHolders" type="checkbox">
        <span class="field__label">kill port holders</span>
      </label>
    </div>
  </div>
</template>
