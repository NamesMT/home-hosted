<script setup lang="ts">
import { ref } from 'vue'

/**
 * A destructive action behind an explicit confirmation step.
 *
 * Deliberately *not* an armed two-press button. Arming reuses the same spot, so a second
 * click lands on the same pixels and an impatient double click fires it — the reason the
 * stock UI's port kill became a popover. Here the second click only opens the sheet again;
 * the destructive button is a separate target inside it, with cancel first in tab order.
 */
const props = withDefaults(defineProps<{
  label: string
  confirmLabel?: string
  tone?: 'ghost' | 'danger'
  disabled?: boolean
  title?: string
  /** One line saying what the action does, for an irreversible one. */
  hint?: string
}>(), { confirmLabel: 'confirm?', tone: 'ghost', title: undefined, hint: undefined })

const emit = defineEmits<{ confirm: [] }>()

const open = ref(false)

function confirm(): void {
  open.value = false
  emit('confirm')
}

function cancel(): void {
  open.value = false
}
</script>

<template>
  <button
    type="button"
    class="btn btn--xs"
    :class="`btn--${props.tone}`"
    :disabled="disabled"
    :title="title ?? props.label"
    @click="open = true"
  >
    {{ props.label }}
  </button>

  <div v-if="open" class="overlay" @click.self="cancel">
    <div class="overlay__panel overlay__panel--sheet dialog" role="dialog" aria-modal="true" :aria-label="props.title ?? props.confirmLabel">
      <div class="overlay__head">
        <span class="overlay__title">{{ props.title ?? props.confirmLabel }}</span>
        <span class="view__spacer" />
        <kbd class="kbd">esc</kbd>
      </div>

      <div class="overlay__body">
        <p v-if="props.hint" class="note note--warn">
          {{ props.hint }}
        </p>
      </div>

      <div class="group sheet__foot">
        <div class="actions">
          <button type="button" class="btn btn--sm" @click="cancel">
            cancel
          </button>
          <button type="button" class="btn btn--sm btn--danger" @click="confirm">
            {{ props.confirmLabel }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
