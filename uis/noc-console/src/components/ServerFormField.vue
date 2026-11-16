<script setup lang="ts">
import type { FieldValue } from '@/lib/serverForm'
import { computed, useTemplateRef } from 'vue'

/**
 * One field of the server form, drawn from its catalogue entry.
 *
 * It exists so the catalogue can stay plain data. The value is `string | boolean`
 * because this draws either a text box or a toggle, chosen by the entry — the narrowing
 * happens here once, instead of a `v-if` chain at every call site.
 *
 * Each control binds through `v-model` on a writable computed, so the element keeps its
 * own input-method composition handling; a hand-written `@input` handler would break
 * typing into these boxes with an IME.
 */
const props = defineProps<{
  label: string
  control: 'text' | 'textarea' | 'select' | 'check' | 'readonly'
  hint?: string
  placeholder?: string
  rows?: number
  required?: boolean
  numeric?: boolean
  full?: boolean
  options?: Array<{ value: string, label: string }>
  modelValue: FieldValue | undefined
  /** Set while the section's own toggle is off, so its boxes are inert. */
  disabled?: boolean
  /** The `live bind address` readout, which is not a form value at all. */
  readout?: string
  /**
   * Drawn in a section's head beside its title, where the original markup cancelled the
   * `field--check` top padding rather than aligning the check with the fields below it.
   */
  head?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [FieldValue] }>()

const asText = computed<string>({
  get: () => (props.modelValue === undefined ? '' : String(props.modelValue)),
  set: (value) => { emit('update:modelValue', value) },
})
const asChecked = computed<boolean>({
  get: () => props.modelValue === true,
  set: (value) => { emit('update:modelValue', value) },
})

/** `field--check` lays the label beside its toggle; `grid__full` spans every column. */
const fieldClass = computed(() => ({
  'field--check': props.control === 'check',
  'grid__full': props.full === true,
}))

/** The hint, with its `` `code` `` spans split out, so the catalogue stays plain text. */
const hintParts = computed(() => (props.hint ?? '')
  .split('`')
  .map((text, index) => ({ text, code: index % 2 === 1 })))

const input = useTemplateRef<HTMLInputElement>('input')

defineExpose({ focus: () => input.value?.focus() })
</script>

<template>
  <label class="field" :class="fieldClass" :style="head ? 'padding-top: 0' : undefined">
    <input
      v-if="control === 'check'"
      v-model="asChecked"
      type="checkbox"
      :disabled="disabled"
    >
    <span class="field__label">{{ label }}</span>

    <!--
      A `check` field is the tick and its label, and nothing else.

      Without this branch the chain below fell through to its `v-else`: every checkbox was drawn
      *beside a text box bound to the same boolean*, so the config page showed `enabled [x] enabled
      [true]` — and that box accepted edits that went nowhere, because `asText` writes the raw
      string into a field the schema types as a boolean. The hint was also squeezed into the 41 px
      left over after the two inputs, which is what wrapped `keeps running when the panel stops…`
      into thirteen lines in a 1084 px row.
    -->
    <template v-if="control === 'check'" />
    <template v-else-if="control === 'textarea'">
      <textarea
        v-model="asText"
        :rows="rows"
        spellcheck="false"
        :placeholder="placeholder"
        :disabled="disabled"
      />
    </template>
    <template v-else-if="control === 'select'">
      <select v-model="asText" :disabled="disabled">
        <option v-for="option in options" :key="option.value" :value="option.value">
          {{ option.label }}
        </option>
      </select>
    </template>
    <template v-else-if="control === 'readonly'">
      <input ref="input" :value="readout" disabled>
    </template>
    <template v-else>
      <input
        ref="input"
        v-model="asText"
        :placeholder="placeholder"
        :required="required"
        :disabled="disabled"
        :inputmode="numeric ? 'numeric' : undefined"
      >
    </template>

    <span v-if="hint" class="field__hint">
      <template v-for="(part, index) in hintParts" :key="index">
        <code v-if="part.code">{{ part.text }}</code>
        <template v-else>{{ part.text }}</template>
      </template>
    </span>
  </label>
</template>
