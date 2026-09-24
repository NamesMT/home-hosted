<script setup lang="ts">
import { PopoverClose, PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui'
import { ref } from 'vue'
import AppButton from '@/components/ui/AppButton.vue'

/**
 * Frees the port a blocked entry wants, behind an explicit confirmation.
 *
 * A confirmation *popover* rather than an armed button: arming reuses the same
 * spot, so an impatient double click would fire the kill. Here the second click
 * only lands on the trigger again (toggling the popover shut) — the destructive
 * button sits in the panel below, and the safe choice comes first in tab order.
 */
const props = withDefaults(defineProps<{
  port: number
  busy?: boolean
}>(), {
  busy: false,
})

const emit = defineEmits<{ confirm: [] }>()

const open = ref(false)

function confirm(): void {
  open.value = false
  emit('confirm')
}
</script>

<template>
  <PopoverRoot v-model:open="open">
    <PopoverTrigger as-child>
      <AppButton variant="danger-ghost" size="xs" :loading="props.busy">
        Kill what holds port {{ props.port }}
      </AppButton>
    </PopoverTrigger>

    <PopoverPortal>
      <PopoverContent
        :side-offset="6"
        align="start"
        class="z-50 w-64 rounded-panel border border-line bg-raise p-3 shadow-float focus-visible:outline-none data-[state=open]:animate-[hh-fade-in_120ms_ease-out]"
      >
        <p class="text-xs font-semibold text-ink">
          Kill the process on port {{ props.port }}?
        </p>
        <p class="mt-1 text-2xs leading-4 text-muted">
          It is asked to stop first, and killed only if it ignores that. Anything this panel
          supervises is refused, so a managed server cannot be lost this way.
        </p>
        <div class="mt-2.5 flex justify-end gap-1.5">
          <PopoverClose as-child>
            <AppButton size="xs" variant="ghost">
              Keep it
            </AppButton>
          </PopoverClose>
          <AppButton size="xs" variant="danger" :loading="props.busy" @click="confirm">
            Kill it
          </AppButton>
        </div>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
