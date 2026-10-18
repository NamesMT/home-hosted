<script setup lang="ts">
import { Check, Copy } from '@lucide/vue'
import { onScopeDispose, ref } from 'vue'
import { t } from '@/i18n'
import { cn } from '@/lib/cn'
import { focusRing } from '@/lib/ui'

const props = withDefaults(defineProps<{
  value: string
  label?: string
  class?: string
}>(), {
  // Left undefined so the default follows the active language; `t()` cannot run in a prop default.
  label: undefined,
  class: undefined,
})

const copied = ref(false)
let timer: ReturnType<typeof setTimeout> | null = null

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.value)
    copied.value = true
    if (timer)
      clearTimeout(timer)
    timer = setTimeout(() => {
      copied.value = false
    }, 1400)
  }
  catch {
    // Clipboard permission denied: leave the button in its resting state.
  }
}

onScopeDispose(() => {
  if (timer)
    clearTimeout(timer)
})
</script>

<template>
  <button
    type="button"
    :class="cn('inline-grid size-6 shrink-0 place-items-center rounded-control text-faint transition-colors duration-150 hover:bg-hover hover:text-ink', focusRing, props.class)"
    :aria-label="copied ? t('common.copied') : (props.label ?? t('common.copy'))"
    @click="copy"
  >
    <Check v-if="copied" class="size-3.5 text-ok" />
    <Copy v-else class="size-3.5" />
  </button>
</template>
