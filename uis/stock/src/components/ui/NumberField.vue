<script setup lang="ts">
import { computed, useId } from 'vue'
import { cn } from '@/lib/cn'
import { numberText, readNumber } from '@/lib/numeric'
import { hintClass, inputClass, labelClass } from '@/lib/ui'

defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{
  label?: string
  hint?: string
  error?: string | null
  wide?: boolean
  /** Render an empty field as `null` rather than 0. */
  nullable?: boolean
  step?: number | string
  min?: number
  max?: number
}>(), {
  label: undefined,
  hint: undefined,
  error: null,
  wide: false,
  nullable: false,
  step: undefined,
  min: undefined,
  max: undefined,
})

const model = defineModel<number | null>({ default: null })
const id = useId()
/**
 * Points the input at its own message, the way `TextField` already does.
 *
 * `aria-invalid` alone tells a screen reader *that* the field is wrong; the sentence saying why sat in a
 * sibling `<p>` with no id, so it was announced as unrelated content after it. Measured on
 * `/global/settings`: the two components rendered the same markup except for this association.
 */
const describedBy = computed(() => (props.hint || props.error ? `${id}-hint` : undefined))

/** Keeps a partially typed value (`1.`) from being clobbered mid-edit. */
const text = computed({
  get: () => numberText(model.value),
  set: (raw: unknown) => {
    model.value = readNumber(raw, props.nullable)
  },
})

const invalid = computed(() => model.value !== null && Number.isNaN(model.value))
</script>

<template>
  <div :class="cn('flex min-w-0 flex-col gap-1', props.wide && 'sm:col-span-2')">
    <label v-if="props.label" :for="id" :class="labelClass">{{ props.label }}</label>
    <input
      :id="id"
      v-model="text"
      type="number"
      inputmode="numeric"
      :step="props.step"
      :min="props.min"
      :max="props.max"
      :class="cn(inputClass, 'font-mono tabular-nums', (props.error || invalid) && 'border-danger')"
      :aria-invalid="props.error || invalid ? true : undefined"
      :aria-describedby="describedBy"
      v-bind="$attrs"
    >
    <p v-if="props.error" :id="`${id}-hint`" class="text-2xs text-danger">
      {{ props.error }}
    </p>
    <p v-else-if="props.hint" :id="`${id}-hint`" :class="hintClass">
      {{ props.hint }}
    </p>
  </div>
</template>
