<script setup lang="ts">
import type { PolicyForm } from '@/components/settings/settingsForm'
import { computed } from 'vue'
import NumberField from '@/components/ui/NumberField.vue'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import { t } from '@/i18n'

/**
 * The event toggles and the throttle, for whichever policy is being edited.
 *
 * One component because these render in two places — the general block, and a target that has
 * opted into its own settings — and the two must stay the same set. A field added to one and not
 * the other would leave that event unreachable for whichever mode the target is in.
 */
const props = defineProps<{
  /** `false` renders read-only, for a target that inherits the general block. */
  editable?: boolean
  /** The inherited values, shown as the current state when `editable` is off. */
  inherited?: boolean
}>()

const policy = defineModel<PolicyForm>({ required: true })

const toggles = computed(() => [
  { key: 'onCrash' as const, label: t('settings.telegram.onCrash') },
  { key: 'onUnhealthy' as const, label: t('settings.telegram.onUnhealthy') },
  { key: 'onForcedRestart' as const, label: t('settings.telegram.onForcedRestart') },
  { key: 'onRecovered' as const, label: t('settings.telegram.onRecovered') },
  { key: 'onHost' as const, label: t('settings.telegram.onHost'), hint: t('settings.telegram.onHostHint') },
  { key: 'onDdns' as const, label: t('settings.telegram.onDdns'), hint: t('settings.telegram.onDdnsHint') },
])
</script>

<template>
  <template v-for="toggle in toggles" :key="toggle.key">
    <ToggleSwitch
      v-model="policy[toggle.key]"
      :label="toggle.label"
      :hint="props.inherited ? t('settings.notifications.inheritedHint') : toggle.hint"
      :disabled="props.editable === false"
    />
  </template>
  <NumberField
    :model-value="policy.cooldownMs"
    :label="t('settings.telegram.cooldown')"
    :min="0"
    :hint="props.editable === false ? t('settings.notifications.inheritedHint') : t('settings.telegram.cooldownHint')"
    :disabled="props.editable === false"
    @update:model-value="policy.cooldownMs = $event ?? 0"
  />
</template>
