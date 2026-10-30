<script setup lang="ts">
import type { PolicyForm } from '@/components/settings/settingsForm'
import { msToSeconds, secondsToMsOr } from '@shared/ui-format'
import { computed } from 'vue'
import NumberField from '@/components/ui/NumberField.vue'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import { t } from '@/i18n'

/**
 * The event toggles and the throttle, for whichever policy is being edited.
 *
 * One component because these render in two places — the general block, and a destination that
 * has opted into its own settings — and the two must stay the same set. A field added to one and
 * not the other would leave that event unreachable in one of the modes.
 */
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

<!--
  A single root element, not a fragment: these fields are slotted into a `FieldGroup`'s grid, and
  a bare `<template v-for>` beside another root makes the component render **nothing at all** — the
  page showed an empty Notifications section with no error anywhere.
-->
<template>
  <div class="contents">
    <ToggleSwitch
      v-for="toggle in toggles"
      :key="toggle.key"
      v-model="policy[toggle.key]"
      :label="toggle.label"
      :hint="toggle.hint"
    />
    <!--
      Shown in seconds, stored in ms. The form keeps milliseconds and the patch compares
      milliseconds, so this conversion is display-only: visiting a page cannot rewrite a value.
      A cleared box keeps what the field held: `NumberField` reports `NaN` here, not `null`, and
      `secondsToMs(NaN)` is `NaN`, which the patch schema refuses for the whole save.
    -->
    <NumberField
      :model-value="msToSeconds(policy.cooldownMs)"
      :label="t('settings.telegram.cooldown')"
      :min="0"
      :hint="t('settings.telegram.cooldownHint')"
      @update:model-value="policy.cooldownMs = secondsToMsOr($event, policy.cooldownMs)"
    />
  </div>
</template>
