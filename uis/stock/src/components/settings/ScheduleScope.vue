<script setup lang="ts">
import type { BackupScope, BackupSelection } from '@shared/contracts'
import type { EntryChoice } from '@/components/settings/backupSelection'
import { scopeOf } from '@shared/backup-scope'
import { computed, ref, watch } from 'vue'
import { captureEntries } from '@/components/settings/backupSelection'
import CaptureTree from '@/components/settings/CaptureTree.vue'
import Notice from '@/components/settings/Notice.vue'
import AppButton from '@/components/ui/AppButton.vue'
import Modal from '@/components/ui/Modal.vue'
import SegmentedControl from '@/components/ui/SegmentedControl.vue'
import { t } from '@/i18n'

/**
 * What an automatic backup captures.
 *
 * The schedule used to take the full default scope and there was no way to change that. This edits
 * the same two-level tree the create dialog offers and stores the result in the CLI's own two
 * modes: "only these" is `--include`, "everything except" is `--all --exclude`.
 *
 * `null` is the whole default scope — every workspace plus `includePaths` — which is what an
 * untouched config has always meant, and what a workspace declared tomorrow will be captured by.
 *
 * The tree is edited on a draft inside the dialog, like the create dialog's: a live two-way binding
 * between the ticks and the stored scope would re-seed the tree from the value the tree produced.
 */
const props = defineProps<{
  /** The panel's capture tree; null until `/api/backups` lands, which is not the same as empty. */
  selection: BackupSelection | null
}>()

const scope = defineModel<BackupScope | null>('scope', { required: true })

const open = ref(false)
const draft = ref<EntryChoice[]>([])
const mode = ref<BackupScope['mode']>('only')

/** Applies a saved scope to a fresh tree, using the coarse-id rule the panel captures with. */
function seed(saved: BackupScope | null): EntryChoice[] {
  const tree = captureEntries(props.selection?.entries ?? [])
  if (saved === null)
    return tree
  // An id covers itself and everything under it, in both modes: `workspace:default` is every leaf,
  // and naming one leaf keeps its entry listed — otherwise a saved scope reopens showing nothing.
  const covers = (id: string): boolean => saved.ids.some(entry => id === entry || id.startsWith(`${entry}:`))
  const wanted = saved.mode === 'only'
  for (const entry of tree) {
    entry.selected = wanted ? covers(entry.id) || saved.ids.some(id => id.startsWith(`${entry.id}:`)) : !covers(entry.id)
    for (const leaf of entry.leaves) leaf.selected = wanted ? covers(leaf.id) : !covers(leaf.id)
  }
  return tree
}

watch(open, (isOpen) => {
  if (!isOpen)
    return
  draft.value = seed(scope.value)
  mode.value = scope.value?.mode ?? 'only'
}, { immediate: true })

const outcome = computed(() => scopeOf(draft.value, mode.value))
const nothingPicked = computed(() => outcome.value.kind === 'nothing')

/** Where the saved scope stands, as the section says it before the dialog is opened. */
const summary = computed(() => {
  const saved = scope.value
  if (saved === null)
    return t('settings.backups.scopeSummaryAll')
  return saved.mode === 'only'
    ? t('settings.backups.scopeSummaryOnly', { count: saved.ids.length })
    : t('settings.backups.scopeSummaryExcept', { count: saved.ids.length })
})

function apply(): void {
  if (nothingPicked.value)
    return
  // A tree with nothing left out stores as no scope at all: the two capture the same thing today,
  // and only the empty setting also covers a workspace declared tomorrow.
  scope.value = outcome.value.kind === 'scope' ? outcome.value.scope : null
  open.value = false
}
</script>

<template>
  <div class="flex flex-col gap-2 sm:col-span-2">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="min-w-0">
        <p class="text-xs font-medium text-ink">
          {{ t('settings.backups.scopeTitle') }}
        </p>
        <p class="mt-0.5 text-2xs leading-4 text-muted">
          {{ summary }}
        </p>
      </div>
      <AppButton size="xs" variant="secondary" :disabled="props.selection === null" @click="open = true">
        {{ t('settings.backups.scopeChoose') }}
      </AppButton>
    </div>
    <p class="text-2xs leading-4 text-faint">
      {{ t('settings.backups.scopeHint') }}
    </p>

    <Modal
      v-model:open="open"
      :title="t('settings.backups.scopeDialogTitle')"
      :description="t('settings.backups.scopeDialogDescription')"
      width="w-[min(92vw,40rem)]"
    >
      <div class="space-y-3">
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-xs font-medium text-muted">{{ t('settings.backups.scopeMode') }}</span>
          <SegmentedControl
            v-model="mode"
            :options="[
              { value: 'only', label: t('settings.backups.scopeOnly') },
              { value: 'except', label: t('settings.backups.scopeExcept') },
            ]"
          />
        </div>
        <p class="text-2xs leading-4 text-faint">
          {{ mode === 'only' ? t('settings.backups.scopeOnlyHint') : t('settings.backups.scopeExceptHint') }}
        </p>

        <div class="max-h-80 overflow-auto">
          <CaptureTree :choices="draft" show-count />
        </div>

        <Notice v-if="nothingPicked" tone="warn">
          {{ t('settings.backups.scopeNothing') }}
        </Notice>
      </div>

      <template #footer>
        <AppButton size="sm" variant="ghost" @click="open = false">
          {{ t('common.cancel') }}
        </AppButton>
        <AppButton size="sm" variant="primary" :disabled="nothingPicked" @click="apply">
          {{ t('settings.backup.apply') }}
        </AppButton>
      </template>
    </Modal>
  </div>
</template>
