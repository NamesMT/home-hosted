<script setup lang="ts">
import { PopoverClose, PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui'
import { ref } from 'vue'
import AppButton from '@/components/ui/AppButton.vue'

/**
 * A destructive action behind an explicit confirmation popover.
 *
 * Deliberately *not* an armed two-press button. Arming reuses the same spot, so a second
 * click lands on the same pixels — an impatient double click fires it, which is why the
 * port kill was moved to this pattern. Here the second click only reaches the trigger
 * again and closes the popover; the destructive button sits in the panel below, and the
 * safe choice comes first in tab order.
 */
const props = withDefaults(defineProps<{
  label: string
  confirmLabel?: string
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost'
  confirmVariant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost'
  size?: 'xs' | 'sm' | 'md'
  disabled?: boolean
  loading?: boolean
  /** What the popover asks; falls back to the confirm label. */
  title?: string
  /** One line saying what the action does, for an irreversible one. */
  hint?: string
}>(), {
  confirmLabel: 'Confirm',
  variant: 'danger-ghost',
  confirmVariant: 'danger',
  size: 'sm',
  disabled: false,
  loading: false,
  title: undefined,
  hint: undefined,
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
      <AppButton :variant="props.variant" :size="props.size" :disabled="props.disabled" :loading="props.loading">
        {{ props.label }}
      </AppButton>
    </PopoverTrigger>

    <PopoverPortal>
      <PopoverContent
        :side-offset="6"
        align="end"
        class="z-50 w-64 rounded-panel border border-line bg-raise p-3 shadow-float focus-visible:outline-none data-[state=open]:animate-[hh-fade-in_120ms_ease-out]"
      >
        <p class="text-xs font-semibold text-ink">
          {{ props.title ?? `${props.confirmLabel}?` }}
        </p>
        <p v-if="props.hint" class="mt-1 text-2xs leading-4 text-muted">
          {{ props.hint }}
        </p>
        <div class="mt-2.5 flex justify-end gap-1.5">
          <PopoverClose as-child>
            <AppButton size="xs" variant="ghost">
              Cancel
            </AppButton>
          </PopoverClose>
          <AppButton size="xs" :variant="props.confirmVariant" :loading="props.loading" @click="confirm">
            {{ props.confirmLabel }}
          </AppButton>
        </div>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
