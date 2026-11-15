<script setup lang="ts">
import type { JobFieldSpec } from '@/lib/jobForm'
import { computed } from 'vue'

/**
 * One field of the job form, drawn from its catalogue entry.
 *
 * The console's server form splits this in two (`ServerFormField` + `ServerFormBlocks`); a job has
 * eight fields in two blocks, so one component carries both and the sheet keeps the grouping. The
 * value is `string | boolean` because the entry chooses a text box or a checkbox, and the narrowing
 * happens here once rather than in a `v-if` chain at the call site.
 *
 * `v-model` on a writable computed, so the element keeps its own IME composition handling — a
 * hand-written `@input` would break typing into these boxes with an input method.
 */
const props = defineProps<{
  spec: JobFieldSpec
  modelValue: string | boolean | undefined
  disabled?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [string | boolean] }>()

const asText = computed<string>({
  get: () => (props.modelValue === undefined ? '' : String(props.modelValue)),
  set: (value) => { emit('update:modelValue', value) },
})

const asChecked = computed<boolean>({
  get: () => props.modelValue === true,
  set: (value) => { emit('update:modelValue', value) },
})
</script>

<template>
  <label class="field" :class="{ 'field--check': props.spec.control === 'check', 'grid__full': props.spec.full }">
    <input
      v-if="props.spec.control === 'check'"
      v-model="asChecked"
      type="checkbox"
      :disabled="props.disabled"
    >
    <span class="field__label">{{ props.spec.label }}</span>

    <textarea
      v-if="props.spec.control === 'textarea'"
      v-model="asText"
      :rows="props.spec.rows"
      spellcheck="false"
      :placeholder="props.spec.placeholder"
      :disabled="props.disabled"
    />
    <input
      v-else-if="props.spec.control === 'text'"
      v-model="asText"
      :placeholder="props.spec.placeholder"
      :required="props.spec.required"
      :inputmode="props.spec.numeric ? 'numeric' : undefined"
      :disabled="props.disabled"
    >

    <span v-if="props.spec.hint" class="field__hint">
      {{ props.spec.hint }}
    </span>
  </label>
</template>
