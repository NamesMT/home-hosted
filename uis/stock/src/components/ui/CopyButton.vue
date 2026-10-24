<script setup lang="ts">
import { Check, Copy, TriangleAlert } from '@lucide/vue'
import { onScopeDispose, ref } from 'vue'
import { useToasts } from '@/composables/useToasts'
import { t } from '@/i18n'
import { copyText } from '@/lib/clipboard'
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

const toasts = useToasts()

const copied = ref(false)
const failed = ref(false)
let timer: ReturnType<typeof setTimeout> | null = null

/** Show the verdict for a moment, then return to the resting icon. */
function flash(): void {
  if (timer)
    clearTimeout(timer)
  timer = setTimeout(() => {
    copied.value = false
    failed.value = false
  }, 1400)
}

async function copy(): Promise<void> {
  if (await copyText(props.value)) {
    failed.value = false
    copied.value = true
    flash()
    return
  }
  // A copy that did not happen has to say so. It used to swallow the error and keep
  // the resting icon, which on a phone reads as a click that missed the target.
  copied.value = false
  failed.value = true
  flash()
  toasts.failure(t('common.copyFailed'))
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
    :aria-label="copied ? t('common.copied') : failed ? t('common.copyFailed') : (props.label ?? t('common.copy'))"
    @click="copy"
  >
    <Check v-if="copied" class="size-3.5 text-ok" />
    <TriangleAlert v-else-if="failed" class="size-3.5 text-warn" />
    <Copy v-else class="size-3.5" />
  </button>
</template>
