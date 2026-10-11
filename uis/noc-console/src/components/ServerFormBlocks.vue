<script setup lang="ts">
import type { FieldKey, FieldPresentation, FieldValue, FormModel, FormSection, FormVariant } from '@/lib/serverForm'
import { computed } from 'vue'
import ServerFormField from '@/components/ServerFormField.vue'
import { fieldPresentation, fieldSpec } from '@/lib/serverForm'

/**
 * The blocks of the server form, one level at a time.
 *
 * `AddServerDialog.vue` and `ServerConfigView.vue` each carried this markup in full. It is a
 * separate component from `ServerFormFields.vue` so that the sheet's fold can draw its own
 * contents through **the same** renderer: recursing is what keeps the grid/group markup in
 * one place instead of a second copy inside the fold.
 */
const props = defineProps<{
  variant: FormVariant
  sections: FormSection[]
  /** The page's `live bind address` readout; the sheet has no such field. */
  liveBind?: string
  /** The workspace's own `logBufferLines`, for the sheet's inherited placeholder. */
  inheritedLogLines?: number
  /** The entry point's one focus registry, shared by every level of the recursion. */
  register?: (key: FieldKey, instance: unknown) => void
}>()

/**
 * The entry point's own form object, mutated in place.
 *
 * A `defineModel` rather than a prop: these fields *are* the entry point's live state, and
 * writing through a prop is exactly the mutation Vue forbids. The model hands back the same
 * object, so an edit lands where the entry point reads it.
 */
const form = defineModel<FormModel>('form', { required: true })

/** The bootstrap boxes go inert while the section's own toggle is off. */
const bootstrapOff = computed(() => form.value?.bootstrapEnabled !== true)

function update(key: FieldKey, value: FieldValue): void {
  if (form.value)
    form.value[key] = value
}

/** A block's fields, minus the ones this variant does not place there right now. */
function visible(section: FormSection): FieldKey[] {
  return section.fields.filter(key =>
    fieldSpec(props.variant, key).whenCustomBind !== true || form.value?.bind === 'custom')
}

/** Everything a drawn control needs: the catalogue entry, plus this form's own state. */
function drawn(key: FieldKey): FieldPresentation & { disabled: boolean, readout?: string } {
  const spec = fieldSpec(props.variant, key)
  return {
    ...fieldPresentation(props.variant, key),
    placeholder: spec.inheritedPlaceholder ? `inherited (${props.inheritedLogLines ?? 500})` : spec.placeholder,
    disabled: spec.withoutBootstrap === true && bootstrapOff.value,
    readout: key === 'liveBind' ? props.liveBind : undefined,
  }
}

/** The fields of one block, as the `v-for` each container needs. */
function registerField(key: FieldKey, instance: unknown): void {
  props.register?.(key, instance)
}
</script>

<template>
  <template v-for="(section, index) in sections" :key="index">
    <slot v-if="section.container === 'lifecycle'" name="lifecycle" />

    <details v-else-if="section.container === 'fold'" class="advanced">
      <summary class="advanced__summary">
        advanced
      </summary>
      <p class="field__hint advanced__note">
        {{ section.note }}
      </p>
      <ServerFormBlocks
        v-model:form="form"
        :variant="variant"
        :sections="section.sections ?? []"
        :live-bind="liveBind"
        :inherited-log-lines="inheritedLogLines"
        :register="register"
      >
        <template #lifecycle>
          <slot name="lifecycle" />
        </template>
      </ServerFormBlocks>
    </details>

    <div v-else-if="section.container === 'pane'" class="pane">
      <div class="pane__head">
        <span class="pane__title">{{ section.title }}</span>
        <ServerFormField
          v-if="section.toggle"
          v-bind="drawn(section.toggle)"
          :model-value="form[section.toggle]"
          head
          @update:model-value="update(section.toggle, $event)"
        />
      </div>
      <div class="pane__body" style="padding: 0.6rem 0.75rem">
        <div class="grid">
          <ServerFormField
            v-for="key in visible(section)"
            :key="key"
            :ref="(instance) => registerField(key, instance)"
            v-bind="drawn(key)"
            :model-value="form[key]"
            @update:model-value="update(key, $event)"
          />
        </div>
      </div>
    </div>

    <div v-else-if="section.container === 'group'" class="group">
      <div class="group__head">
        <span class="group__title">{{ section.title }}</span>
        <ServerFormField
          v-if="section.toggle"
          v-bind="drawn(section.toggle)"
          :model-value="form[section.toggle]"
          head
          @update:model-value="update(section.toggle, $event)"
        />
      </div>
      <div class="grid">
        <ServerFormField
          v-for="key in visible(section)"
          :key="key"
          :ref="(instance) => registerField(key, instance)"
          v-bind="drawn(key)"
          :model-value="form[key]"
          @update:model-value="update(key, $event)"
        />
      </div>
    </div>

    <div v-else class="grid">
      <ServerFormField
        v-for="key in visible(section)"
        :key="key"
        :ref="(instance) => registerField(key, instance)"
        v-bind="drawn(key)"
        :model-value="form[key]"
        @update:model-value="update(key, $event)"
      />
    </div>
  </template>
</template>
