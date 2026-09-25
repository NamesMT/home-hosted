<script setup lang="ts">
import type { ControlView } from '@shared/contracts'
import type { ListenerForm } from '@/components/settings/settingsForm'
import { parseBind } from '@shared/contracts'
import { computed } from 'vue'
import { numberModel } from '@/components/settings/settingsForm'
import AppButton from '@/components/ui/AppButton.vue'
import CopyButton from '@/components/ui/CopyButton.vue'
import FieldGroup from '@/components/ui/FieldGroup.vue'
import NumberField from '@/components/ui/NumberField.vue'
import SegmentedControl from '@/components/ui/SegmentedControl.vue'
import TextField from '@/components/ui/TextField.vue'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import ToneBadge from '@/components/ui/ToneBadge.vue'

const props = defineProps<{
  view: ControlView | null
  dirty: boolean
}>()

const emit = defineEmits<{ reset: [] }>()

const control = defineModel<ListenerForm>('control', { required: true })

const port = numberModel(() => control.value.port, value => (control.value.port = value), 3999)

const PRESET_BINDS = ['local', 'lan']

const bindMode = computed<string>({
  get: () => (PRESET_BINDS.includes(control.value.host) ? control.value.host : 'custom'),
  set: (mode) => {
    if (mode !== 'custom') {
      control.value.host = mode
      return
    }
    // Coming from a preset there is no address to keep, so seed one: the live address when it
    // is already specific, loopback otherwise.
    if (!PRESET_BINDS.includes(control.value.host))
      return
    const live = props.view?.bindHost ?? ''
    const specific = live !== '' && live !== '0.0.0.0' && live !== '127.0.0.1' && parseBind(live) !== null
    control.value.host = specific ? live : '127.0.0.1'
  },
})

const customBindError = computed(() => {
  if (bindMode.value !== 'custom' || parseBind(control.value.host) !== null)
    return undefined
  return 'Enter an IPv4 address, for example 192.168.1.20.'
})

const liveAddress = computed(() => props.view?.url ?? '—')
</script>

<template>
  <FieldGroup
    title="Listener"
    description="Where the panel answers. Moving this restarts the panel and sends this page to the new address."
  >
    <template #actions>
      <AppButton size="xs" variant="ghost" :disabled="!props.dirty" @click="emit('reset')">
        Reset
      </AppButton>
    </template>

    <NumberField v-model="port" label="Control port" :min="1" :max="65535" hint="Default 3999." />
    <div class="flex min-w-0 flex-col gap-1">
      <span class="text-xs font-medium text-muted">Bind</span>
      <SegmentedControl
        v-model="bindMode"
        :options="[
          { value: 'local', label: 'Local' },
          { value: 'lan', label: 'LAN' },
          { value: 'custom', label: 'Custom' },
        ]"
      />
      <p class="text-2xs leading-4 text-faint">
        {{ bindMode === 'lan' ? '0.0.0.0 — reachable from the whole network.' : bindMode === 'local' ? '127.0.0.1 — this machine only.' : 'A specific interface address you type in below.' }}
      </p>
    </div>
    <TextField
      v-if="bindMode === 'custom'"
      v-model="control.host"
      label="IPv4 address"
      placeholder="192.168.1.20"
      :error="customBindError"
      hint="Binding beyond 127.0.0.1 needs a real password."
    />
    <ToggleSwitch v-model="control.openBrowser" label="Open a browser when the panel comes up" wide />

    <div class="flex min-w-0 flex-col gap-1 sm:col-span-2">
      <span class="text-xs font-medium text-muted">Live address</span>
      <div class="flex items-center gap-1.5 rounded-control border border-line bg-page/60 px-2.5 py-1.5">
        <span class="min-w-0 flex-1 truncate font-mono text-xs tabular-nums text-ink">{{ liveAddress }}</span>
        <ToneBadge v-if="props.view?.restartRequired" tone="warn" dot>
          restart required
        </ToneBadge>
        <CopyButton :value="liveAddress" label="Copy the live address" />
      </div>
      <p class="text-2xs leading-4 text-faint">
        What the listener is bound to right now; saved changes take effect after the panel rebinds.
      </p>
    </div>
  </FieldGroup>
</template>
