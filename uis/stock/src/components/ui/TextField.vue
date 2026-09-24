<script setup lang="ts">
import { computed, useId } from 'vue'
import { cn } from '@/lib/cn'
import { hintClass, inputClass, labelClass } from '@/lib/ui'

defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{
  label?: string
  hint?: string
  error?: string | null
  wide?: boolean
}>(), {
  label: undefined,
  hint: undefined,
  error: null,
  wide: false,
})

const model = defineModel<string>({ default: '' })
const id = useId()
const describedBy = computed(() => (props.hint || props.error ? `${id}-hint` : undefined))
</script>

<template>
  <div :class="cn('flex min-w-0 flex-col gap-1', props.wide && 'sm:col-span-2')">
    <label v-if="props.label" :for="id" :class="labelClass">{{ props.label }}</label>
    <input
      :id="id"
      v-model="model"
      :class="cn(inputClass, props.error && 'border-danger')"
      :aria-invalid="props.error ? true : undefined"
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
