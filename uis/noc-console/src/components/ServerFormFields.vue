<script setup lang="ts">
import type { FieldKey, FormModel, FormVariant } from '@/lib/serverForm'
import { computed } from 'vue'
import ServerFormBlocks from '@/components/ServerFormBlocks.vue'
import { FORM_LAYOUT } from '@/lib/serverForm'

/**
 * The server form — the whole of what `AddServerDialog.vue` and `ServerConfigView.vue` each
 * carried.
 *
 * Both entry points are a shell around this: the dialog makes it a scrolling sheet whose
 * advanced half folds away, the page a set of panes. Which fields exist in which block, what
 * each is called and how it is drawn all come from `@/lib/serverForm`, so a field the form
 * offers is added once.
 *
 * The `lifecycle` slot is where an entry point puts its own restart/health/stop markup: the
 * sheet binds `LifecycleFields` to typed nested groups while the page edits 22 flat string
 * boxes, and folding those into one component would change how a value is entered. That is
 * the one part of this form a single component cannot own.
 */
const props = defineProps<{
  variant: FormVariant
  /** The page's `live bind address` readout; the sheet has no such field. */
  liveBind?: string
  /** The workspace's own `logBufferLines`, for the sheet's inherited placeholder. */
  inheritedLogLines?: number
}>()

/**
 * The entry point's own form object, mutated in place.
 *
 * A `defineModel` rather than a prop: these fields *are* the entry point's live state, and
 * writing through a prop is exactly the mutation Vue forbids. The model hands back the same
 * object, so an edit lands where the entry point reads it.
 */
const form = defineModel<FormModel>('form', { required: true })

const sections = computed(() => FORM_LAYOUT[props.variant])

/**
 * The rendered fields by key, so an entry point can move the caret into one — the dialog
 * focuses its `id` box on open, as it did before. One registry for the whole tree, handed
 * down so the folded half registers into the same map as the grid above it.
 */
const fields = new Map<FieldKey, { focus: () => void }>()

function register(key: FieldKey, instance: unknown): void {
  if (instance && typeof (instance as { focus?: unknown }).focus === 'function')
    fields.set(key, instance as { focus: () => void })
  else
    fields.delete(key)
}

defineExpose({ focusField: (key: FieldKey): void => fields.get(key)?.focus() })
</script>

<template>
  <ServerFormBlocks
    v-model:form="form"
    :variant="variant"
    :sections="sections"
    :live-bind="liveBind"
    :inherited-log-lines="inheritedLogLines"
    :register="register"
  >
    <template #lifecycle>
      <slot name="lifecycle" />
    </template>
  </ServerFormBlocks>
</template>
