<script setup lang="ts">
import type { EntryChoice } from '@/components/settings/backupSelection'
import { Boxes, Layers } from '@lucide/vue'
import { computed, ref } from 'vue'
import AppButton from '@/components/ui/AppButton.vue'
import CheckField from '@/components/ui/CheckField.vue'
import Modal from '@/components/ui/Modal.vue'
import { t, tc } from '@/i18n'
import { kindLabel } from '@/lib/panel-text'

/**
 * The two-level capture tree, edited in place.
 *
 * One component for the create dialog and the schedule's scope editor: a second copy of "a
 * workspace can be taken whole or by leaf" is how the two would come to offer different choices
 * for the same archive. The `choices` array is mutated by design — it is the caller's local draft,
 * never the panel's live view.
 */
const props = withDefaults(defineProps<{
  choices: EntryChoice[]
  disabled?: boolean
  /** Show the running "entries · items selected" count above the list. */
  showCount?: boolean
}>(), {
  disabled: false,
  showCount: false,
})

const counts = computed(() => {
  let entries = 0
  let leaves = 0
  for (const entry of props.choices) {
    if (!entry.selected || (entry.leaves.length > 0 && !entry.leaves.some(leaf => leaf.selected)))
      continue
    entries += 1
    leaves += entry.leaves.length === 0 ? 1 : entry.leaves.filter(leaf => leaf.selected).length
  }
  return { entries, leaves }
})

function selectAll(selected: boolean): void {
  for (const entry of props.choices) {
    entry.selected = selected
    for (const leaf of entry.leaves) leaf.selected = selected
  }
}

/** The sub-dialog edits on a draft and applies at once, so a cancel changes nothing. */
const subOpen = ref(false)
const subTarget = ref<EntryChoice | null>(null)
const subDraft = ref<Record<string, boolean>>({})

const subSelected = computed(() => subTarget.value === null ? 0 : subTarget.value.leaves.filter(leaf => subDraft.value[leaf.id] === true).length)

function openSub(entry: EntryChoice): void {
  subTarget.value = entry
  subDraft.value = Object.fromEntries(entry.leaves.map(leaf => [leaf.id, leaf.selected]))
  subOpen.value = true
}

function applySub(): void {
  const entry = subTarget.value
  if (entry === null)
    return
  for (const leaf of entry.leaves)
    leaf.selected = subDraft.value[leaf.id] === true
  // An entry whose items were all unticked is not captured, even if it was listed.
  if (entry.leaves.some(leaf => leaf.selected))
    entry.selected = true
  subOpen.value = false
  subTarget.value = null
}

function toggleAllSub(selected: boolean): void {
  const entry = subTarget.value
  if (entry === null)
    return
  subDraft.value = Object.fromEntries(entry.leaves.map(leaf => [leaf.id, selected]))
}

function partiallySelected(entry: EntryChoice): boolean {
  return entry.selected && entry.leaves.length > 0 && entry.leaves.some(leaf => leaf.selected) && entry.leaves.some(leaf => !leaf.selected)
}
</script>

<template>
  <div class="space-y-3">
    <div class="flex items-center justify-between gap-2">
      <span v-if="props.showCount" class="text-xs font-medium text-muted">
        {{ tc('settings.backup.entriesCount', counts.entries) }} · {{ tc('settings.backup.itemsSelected', counts.leaves) }}
      </span>
      <div class="ml-auto flex items-center gap-1.5">
        <AppButton size="xs" variant="ghost" :disabled="props.disabled" @click="selectAll(true)">
          {{ t('common.selectAll') }}
        </AppButton>
        <AppButton size="xs" variant="ghost" :disabled="props.disabled" @click="selectAll(false)">
          {{ t('common.selectNone') }}
        </AppButton>
      </div>
    </div>

    <ul class="space-y-1.5">
      <li
        v-for="entry in props.choices"
        :key="entry.id"
        class="rounded-control border border-line-soft bg-panel-2/30 px-2.5 py-2"
      >
        <div class="flex items-start gap-2.5">
          <div class="min-w-0 flex-1">
            <CheckField
              v-model="entry.selected"
              :label="entry.label"
              :hint="entry.hint"
              :disabled="props.disabled"
            />
          </div>
          <div v-if="entry.leaves.length > 0" class="flex shrink-0 items-center gap-1.5 pt-0.5">
            <span class="font-mono text-2xs text-faint">{{ entry.leaves.filter(l => l.selected).length }}/{{ entry.leaves.length }}</span>
            <AppButton size="xs" variant="secondary" :disabled="props.disabled" @click="openSub(entry)">
              <Boxes class="size-3" />{{ t('settings.backup.chooseItems') }}
            </AppButton>
          </div>
          <span
            v-else
            class="shrink-0 rounded-control border border-line px-1.5 py-0.5 text-2xs text-faint"
          >{{ kindLabel(entry.kind) }}</span>
        </div>

        <p
          v-if="partiallySelected(entry)"
          class="mt-1 flex items-center gap-1 pl-6 text-2xs text-warn"
        >
          <Layers class="size-3" />
          {{ t('settings.backup.partialCapture') }}
        </p>
      </li>
    </ul>

    <Modal
      v-model:open="subOpen"
      :title="subTarget === null ? t('settings.backup.chooseItems') : t('settings.backup.chooseItemsFor', { label: subTarget.label })"
      :description="t('settings.backup.subDescription')"
      width="w-[min(92vw,34rem)]"
    >
      <div class="space-y-3">
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs font-medium text-muted">
            {{ t('settings.backup.selectedOf', { selected: subSelected, total: subTarget?.leaves.length ?? 0 }) }}
          </span>
          <div class="flex items-center gap-1.5">
            <AppButton size="xs" variant="ghost" @click="toggleAllSub(true)">
              {{ t('common.selectAll') }}
            </AppButton>
            <AppButton size="xs" variant="ghost" @click="toggleAllSub(false)">
              {{ t('common.selectNone') }}
            </AppButton>
          </div>
        </div>

        <ul class="max-h-72 space-y-1 overflow-auto">
          <li v-for="leaf in subTarget?.leaves ?? []" :key="leaf.id" class="rounded-control px-2 py-1.5 hover:bg-hover">
            <CheckField
              :model-value="subDraft[leaf.id] === true"
              :label="leaf.label"
              :hint="leaf.hint"
              @update:model-value="value => subDraft[leaf.id] = value === true"
            />
          </li>
        </ul>

        <p v-if="subTarget?.leaves.length === 0" class="text-xs text-muted">
          {{ t('settings.backup.nothingSelectable') }}
        </p>
      </div>

      <template #footer>
        <AppButton size="sm" variant="ghost" @click="subOpen = false">
          {{ t('common.cancel') }}
        </AppButton>
        <AppButton size="sm" variant="primary" @click="applySub">
          {{ t('settings.backup.apply') }}
        </AppButton>
      </template>
    </Modal>
  </div>
</template>
