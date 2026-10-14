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
import { t } from '@/i18n'

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
  return t('settings.listener.ipv4Error')
})

const liveAddress = computed(() => props.view?.url ?? '—')

const bindHint = computed(() => {
  if (bindMode.value === 'lan')
    return t('settings.listener.bindLanHint')
  if (bindMode.value === 'local')
    return t('settings.listener.bindLocalHint')
  return t('settings.listener.bindCustomHint')
})
</script>

<template>
  <FieldGroup
    :title="t('settings.listener.title')"
    :description="t('settings.listener.description')"
  >
    <template #actions>
      <AppButton size="xs" variant="ghost" :disabled="!props.dirty" @click="emit('reset')">
        {{ t('common.reset') }}
      </AppButton>
    </template>

    <NumberField v-model="port" :label="t('settings.listener.port')" :min="1" :max="65535" :hint="t('settings.listener.portHint')" />
    <div class="flex min-w-0 flex-col gap-1">
      <span class="text-xs font-medium text-muted">{{ t('settings.listener.bind') }}</span>
      <SegmentedControl
        v-model="bindMode"
        :options="[
          { value: 'local', label: t('settings.listener.bindLocal') },
          { value: 'lan', label: t('settings.listener.bindLan') },
          { value: 'custom', label: t('settings.listener.bindCustom') },
        ]"
      />
      <p class="text-2xs leading-4 text-faint">
        {{ bindHint }}
      </p>
    </div>
    <TextField
      v-if="bindMode === 'custom'"
      v-model="control.host"
      :label="t('settings.listener.ipv4')"
      :placeholder="t('settings.listener.ipv4Placeholder')"
      :error="customBindError"
      :hint="t('settings.listener.ipv4Hint')"
    />
    <ToggleSwitch v-model="control.openBrowser" :label="t('settings.listener.openBrowser')" wide />

    <div class="flex min-w-0 flex-col gap-1 sm:col-span-2">
      <span class="text-xs font-medium text-muted">{{ t('settings.listener.liveAddress') }}</span>
      <div class="flex items-center gap-1.5 rounded-control border border-line bg-page/60 px-2.5 py-1.5">
        <span class="min-w-0 flex-1 truncate font-mono text-xs tabular-nums text-ink">{{ liveAddress }}</span>
        <ToneBadge v-if="props.view?.restartRequired" tone="warn" dot>
          {{ t('settings.listener.restartRequired') }}
        </ToneBadge>
        <CopyButton :value="liveAddress" :label="t('settings.listener.copyLiveAddress')" />
      </div>
      <p class="text-2xs leading-4 text-faint">
        {{ t('settings.listener.liveAddressHint') }}
      </p>
    </div>
  </FieldGroup>
</template>
