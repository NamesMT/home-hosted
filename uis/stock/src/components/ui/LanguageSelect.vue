<script setup lang="ts">
import type { SelectOption } from './SelectField.vue'
import { computed, ref } from 'vue'
import SelectField from '@/components/ui/SelectField.vue'
import { currentLocale, setLocale, t } from '@/i18n'
import { LOCALES } from '@/i18n/locales'

/**
 * The language picker, shared by the login page and Global settings.
 *
 * A `<select>` rather than a custom listbox: it is one control in two places, it works with the
 * keyboard and screen readers for free, and a native menu renders the endonyms in the platform's
 * own font — which matters when the label is `日本語` and the page font has no CJK coverage.
 *
 * Switching is async (a catalog is a chunk), so the control shows the pending choice immediately
 * and only clears it once the catalog is in place — never snapping back to the old language.
 */
const props = withDefaults(defineProps<{
  /** Stacked label for the settings form; a bare control for the login corner. */
  labelled?: boolean
  wide?: boolean
}>(), {
  labelled: true,
  wide: false,
})
const busy = ref(false)

const options = computed<SelectOption[]>(() => LOCALES.map(locale => ({ value: locale.code, label: locale.name })))

// While a catalog loads the switch is in flight; the select shows the target, not the old value.
const pending = ref<string | null>(null)
const value = computed<string>({
  get: () => pending.value ?? currentLocale(),
  set: (next) => {
    if (next === currentLocale())
      return
    pending.value = next
    busy.value = true
    void setLocale(next).finally(() => {
      pending.value = null
      busy.value = false
    })
  },
})
</script>

<template>
  <SelectField
    v-model="value"
    :label="props.labelled ? t('language.label') : undefined"
    :options="options"
    :wide="props.wide"
    :disabled="busy"
    :aria-label="props.labelled ? undefined : t('language.select')"
    data-testid="language-select"
  />
</template>
