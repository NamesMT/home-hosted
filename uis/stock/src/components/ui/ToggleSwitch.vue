<script setup lang="ts">
import { SwitchRoot, SwitchThumb } from 'reka-ui'
import { cn } from '@/lib/cn'
import { focusRing } from '@/lib/ui'

const props = withDefaults(defineProps<{
  label: string
  hint?: string
  disabled?: boolean
  /** Put the switch after the text instead of before it. */
  trailing?: boolean
}>(), {
  hint: undefined,
  disabled: false,
  trailing: false,
})

const model = defineModel<boolean>({ default: false })
</script>

<template>
  <div :class="cn('flex items-center gap-2.5', props.trailing && 'flex-row-reverse justify-end')">
    <SwitchRoot
      v-model="model"
      :disabled="props.disabled"
      :class="cn(
        'relative inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full border transition-colors duration-150',
        'data-[state=checked]:border-accent data-[state=checked]:bg-accent',
        'data-[state=unchecked]:border-line data-[state=unchecked]:bg-line-soft',
        'disabled:cursor-not-allowed disabled:opacity-45',
        focusRing,
      )"
    >
      <SwitchThumb
        class="block size-3 translate-x-[3px] rounded-full bg-white shadow-sm transition-transform duration-150 ease-out data-[state=checked]:translate-x-[16px]"
      />
    </SwitchRoot>
    <label class="min-w-0 cursor-pointer select-none" @click="!props.disabled && (model = !model)">
      <span class="block text-xs text-ink">{{ props.label }}</span>
      <span v-if="props.hint" class="block text-2xs text-faint">{{ props.hint }}</span>
    </label>
  </div>
</template>
