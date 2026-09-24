<script setup lang="ts">
import { useId } from 'vue'
import { cn } from '@/lib/cn'
import { hintClass, labelClass, monoInputClass } from '@/lib/ui'

defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{
  label?: string
  hint?: string
  error?: string | null
  rows?: number
  placeholder?: string
  wide?: boolean
  mono?: boolean
}>(), {
  label: undefined,
  hint: undefined,
  error: null,
  rows: 3,
  placeholder: undefined,
  wide: true,
  mono: true,
})

const model = defineModel<string>({ default: '' })
const id = useId()
</script>

<template>
  <div :class="cn('flex min-w-0 flex-col gap-1', props.wide && 'sm:col-span-2')">
    <label v-if="props.label" :for="id" :class="labelClass">{{ props.label }}</label>
    <textarea
      :id="id"
      v-model="model"
      :rows="props.rows"
      :placeholder="props.placeholder"
      spellcheck="false"
      :class="cn(props.mono ? monoInputClass : 'font-sans', 'resize-y leading-relaxed', props.error && 'border-danger')"
      v-bind="$attrs"
    />
    <p v-if="props.error" class="text-2xs text-danger">
      {{ props.error }}
    </p>
    <p v-else-if="props.hint" :class="hintClass">
      {{ props.hint }}
    </p>
  </div>
</template>
