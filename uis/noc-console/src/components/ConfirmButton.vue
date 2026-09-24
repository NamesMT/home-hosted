<script setup lang="ts">
import { onScopeDispose, ref } from 'vue'

const props = withDefaults(defineProps<{
  label: string
  confirmLabel?: string
  tone?: 'ghost' | 'danger'
  disabled?: boolean
  title?: string
}>(), { confirmLabel: 'confirm?', tone: 'ghost' })

const emit = defineEmits<{ confirm: [] }>()

const armed = ref(false)
let timer: ReturnType<typeof setTimeout> | null = null

function disarm(): void {
  armed.value = false
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}

function click(): void {
  if (armed.value) {
    disarm()
    emit('confirm')
    return
  }
  armed.value = true
  timer = setTimeout(disarm, 4000)
}

onScopeDispose(disarm)
</script>

<template>
  <button
    type="button"
    class="btn btn--xs"
    :class="armed ? 'btn--armed' : `btn--${props.tone}`"
    :disabled="disabled"
    :title="title"
    @click="click"
  >
    {{ armed ? confirmLabel : label }}
  </button>
</template>
