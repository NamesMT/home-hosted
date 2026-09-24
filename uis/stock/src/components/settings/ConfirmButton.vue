<script setup lang="ts">
import { onScopeDispose, ref } from 'vue'
import AppButton from '@/components/ui/AppButton.vue'

/**
 * Two-press destructive action: the first press arms it, the second fires.
 * Mirrors the "Confirm clear" pattern every settings form already used.
 */
const props = withDefaults(defineProps<{
  label: string
  confirmLabel?: string
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost'
  confirmVariant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost'
  size?: 'xs' | 'sm' | 'md'
  disabled?: boolean
  loading?: boolean
}>(), {
  confirmLabel: 'Confirm',
  variant: 'danger-ghost',
  confirmVariant: 'danger',
  size: 'sm',
  disabled: false,
  loading: false,
})

const emit = defineEmits<{ confirm: [] }>()

const armed = ref(false)
let timer: ReturnType<typeof setTimeout> | null = null

function disarm(): void {
  if (timer)
    clearTimeout(timer)
  timer = null
  armed.value = false
}

function press(): void {
  if (!armed.value) {
    armed.value = true
    timer = setTimeout(disarm, 5000)
    return
  }
  disarm()
  emit('confirm')
}

onScopeDispose(disarm)
</script>

<template>
  <AppButton
    :variant="armed ? props.confirmVariant : props.variant"
    :size="props.size"
    :disabled="props.disabled"
    :loading="props.loading"
    @click="press"
  >
    {{ armed ? props.confirmLabel : props.label }}
  </AppButton>
</template>
