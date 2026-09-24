<script setup lang="ts">
import { ChevronDown } from 'lucide-vue-next'
import { useId } from 'vue'
import { cn } from '@/lib/cn'
import { hintClass, inputClass, labelClass } from '@/lib/ui'

defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{
  label?: string
  hint?: string
  error?: string | null
  options: SelectOption[]
  wide?: boolean
  mono?: boolean
}>(), {
  label: undefined,
  hint: undefined,
  error: null,
  wide: false,
  mono: false,
})

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

const model = defineModel<string>({ default: '' })
const id = useId()
</script>

<template>
  <div :class="cn('flex min-w-0 flex-col gap-1', props.wide && 'sm:col-span-2')">
    <label v-if="props.label" :for="id" :class="labelClass">{{ props.label }}</label>
    <div class="relative">
      <select
        :id="id"
        v-model="model"
        :class="cn(inputClass, 'cursor-pointer appearance-none pr-7', props.mono && 'font-mono text-xs', props.error && 'border-danger')"
        v-bind="$attrs"
      >
        <option v-for="option in props.options" :key="option.value" :value="option.value" :disabled="option.disabled">
          {{ option.label }}
        </option>
      </select>
      <ChevronDown class="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-faint" aria-hidden="true" />
    </div>
    <p v-if="props.error" class="text-2xs text-danger">
      {{ props.error }}
    </p>
    <p v-else-if="props.hint" :class="hintClass">
      {{ props.hint }}
    </p>
  </div>
</template>
