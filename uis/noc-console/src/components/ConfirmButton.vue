<script setup lang="ts">
import { ref } from 'vue'
import { useModalLayer } from '@/composables/useModalLayer'

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
  /**
   * An offered alternative, for an action that has two honest answers rather than one.
   *
   * "Stop every server" is the case: persistent entries keep running by default, and ending
   * them is a separate, narrower choice. Two labelled buttons say which is which, where one
   * confirm would have to either hide the choice or make it by surprise.
   */
  alternativeLabel?: string
}>(), { confirmLabel: 'confirm?', tone: 'ghost', title: undefined, hint: undefined, alternativeLabel: undefined })

const emit = defineEmits<{ confirm: [], alternative: [] }>()

const open = ref(false)

function cancel(): void {
  open.value = false
}

useModalLayer(() => open.value, cancel)

function confirm(): void {
  open.value = false
  emit('confirm')
}

function alternative(): void {
  open.value = false
  emit('alternative')
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
          <!-- The safe choice first in tab order; the wider one is the deliberate second. -->
          <button type="button" class="btn btn--sm" @click="cancel">
            cancel
          </button>
          <button type="button" class="btn btn--sm" @click="confirm">
            {{ props.confirmLabel }}
          </button>
          <button v-if="props.alternativeLabel" type="button" class="btn btn--sm btn--danger" @click="alternative">
            {{ props.alternativeLabel }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
