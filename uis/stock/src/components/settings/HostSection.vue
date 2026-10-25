<script setup lang="ts">
import type { HostConfig, WslTemperatureStatus } from '@shared/contracts'
import type { HostForm } from '@/components/settings/settingsForm'
import { errorMessage } from '@shared/error-message'
import { computed, onMounted, ref } from 'vue'
import Notice from '@/components/settings/Notice.vue'
import { numberModel } from '@/components/settings/settingsForm'
import AppButton from '@/components/ui/AppButton.vue'
import FieldGroup from '@/components/ui/FieldGroup.vue'
import NumberField from '@/components/ui/NumberField.vue'
import TextField from '@/components/ui/TextField.vue'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import ToneBadge from '@/components/ui/ToneBadge.vue'
import { t } from '@/i18n'
import * as api from '@/lib/api'

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
const tempCommandTimeout = numberModel(() => host.value.tempCommandTimeoutMs, value => (host.value.tempCommandTimeoutMs = value), 5000)

/**
 * The WSL2 bridge.
 *
 * A WSL2 guest cannot read a temperature, so the panel offers to install a Windows-side helper and
 * fill the command in. Only fetched on WSL — everywhere else the block is absent, because a button
 * that cannot work is worse than no button.
 */
const bridge = ref<WslTemperatureStatus | null>(null)
const bridgeBusy = ref(false)
const bridgeError = ref<string | null>(null)
const showBridge = computed(() => bridge.value?.supported === true)

onMounted(async () => {
  try {
    const status = await api.fetchWslTemperature()
    bridge.value = status
  }
  catch {
    // Not a WSL guest, or an older panel without the route: the block simply does not appear.
    bridge.value = null
  }
})

async function setupBridge(): Promise<void> {
  bridgeBusy.value = true
  bridgeError.value = null
  try {
    const status = await api.installWslTemperature()
    bridge.value = status
    // The helper sets the command on the panel; reflect it in the form so Save is not needed.
    if (status.tempCommand !== null && status.tempCommand !== undefined)
      host.value.tempCommand = status.tempCommand
  }
  catch (caught) {
    bridgeError.value = errorMessage(caught)
  }
  finally {
    bridgeBusy.value = false
  }
}

async function removeBridge(): Promise<void> {
  bridgeBusy.value = true
  bridgeError.value = null
  try {
    bridge.value = await api.removeWslTemperature()
    host.value.tempCommand = ''
  }
  catch (caught) {
    bridgeError.value = errorMessage(caught)
  }
  finally {
    bridgeBusy.value = false
  }
}
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
    <!--
      Where the platform exposes no sensor (a WSL2 guest above all) the tile reads "n/a", and this is
      how a person supplies the reading themselves. `docs/SERVERS.md` carries the WSL2 one-liner.
    -->
    <TextField
      v-model="host.tempCommand"
      :label="t('settings.host.tempCommand')"
      :hint="t('settings.host.tempCommandHint')"
      :placeholder="t('settings.host.tempCommandPlaceholder')"
      wide
    />
    <NumberField
      v-if="host.tempCommand.trim().length > 0"
      v-model="tempCommandTimeout"
      :label="t('settings.host.tempCommandTimeout')"
      :min="100"
      :max="30000"
      :hint="t('settings.host.tempCommandTimeoutHint')"
    />
  </FieldGroup>

  <!--
    The WSL2 bridge. A guest has no sensor the kernel can read, so the tile is honest but useless
    until someone bridges to the Windows host; this is that, behind one button.
  -->
  <FieldGroup
    v-if="showBridge"
    :title="t('settings.host.wslTitle')"
    :description="t('settings.host.wslDescription')"
  >
    <div class="flex flex-wrap items-center gap-2 sm:col-span-2">
      <AppButton
        v-if="!bridge?.configured"
        size="xs"
        variant="primary"
        :loading="bridgeBusy"
        @click="setupBridge()"
      >
        {{ t('settings.host.wslSetup') }}
      </AppButton>
      <AppButton
        v-else
        size="xs"
        variant="secondary"
        :loading="bridgeBusy"
        @click="removeBridge()"
      >
        {{ t('settings.host.wslRemove') }}
      </AppButton>
      <span v-if="bridge?.lastReadingCelsius !== null && bridge?.lastReadingCelsius !== undefined" class="text-2xs font-medium text-ok">
        {{ t('settings.host.wslReading', { celsius: bridge.lastReadingCelsius }) }}
      </span>
    </div>
    <p v-if="bridge?.lastError" class="text-2xs text-danger sm:col-span-2" role="status">
      {{ t('settings.host.wslFailed', { reason: bridge.lastError }) }}
    </p>
    <p v-else-if="bridge?.configured && !bridge?.libraryPresent" class="text-2xs text-warn sm:col-span-2">
      {{ t('settings.host.wslNeedsLibrary') }}
    </p>
    <Notice v-if="bridgeError" tone="danger">
      {{ bridgeError }}
    </Notice>
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
