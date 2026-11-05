<script setup lang="ts">
import { parseBind } from '@shared/contracts'
import { computed, ref } from 'vue'
import SelectField from '@/components/ui/SelectField.vue'
import TextField from '@/components/ui/TextField.vue'
import { t } from '@/i18n'

/** A server's bind: `local`, `lan`, or one specific IPv4 address of this machine. */
const props = defineProps<{ label: string, hint?: string }>()
const bind = defineModel<string>({ required: true })

const PRESETS = ['local', 'lan']
const lastCustom = ref(PRESETS.includes(bind.value) ? '' : bind.value)

const mode = computed<string>({
  get: () => (PRESETS.includes(bind.value) ? bind.value : 'custom'),
  set: (next) => {
    if (next === 'custom')
      bind.value = lastCustom.value !== '' ? lastCustom.value : '192.168.1.20'
    else
      bind.value = next
  },
})

const address = computed<string>({
  get: () => (PRESETS.includes(bind.value) ? '' : bind.value),
  set: (next) => {
    lastCustom.value = next.trim()
    bind.value = next.trim()
  },
})

const error = computed(() => (mode.value === 'custom' && parseBind(bind.value) === null ? t('settings.listener.ipv4Error') : undefined))

const options = computed(() => [
  { value: 'local', label: t('bind.local') },
  { value: 'lan', label: t('bind.lan') },
  { value: 'custom', label: t('bind.custom') },
])
</script>

<template>
  <div class="flex min-w-0 flex-col gap-2">
    <SelectField v-model="mode" :label="props.label" :options="options" :hint="mode === 'custom' ? t('bind.customHint') : props.hint" />
    <TextField
      v-if="mode === 'custom'"
      v-model="address"
      :label="t('settings.listener.ipv4')"
      :placeholder="t('settings.listener.ipv4Placeholder')"
      :error="error"
    />
  </div>
</template>
