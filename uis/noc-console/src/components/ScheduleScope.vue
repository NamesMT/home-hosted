<script setup lang="ts">
import type { ScopeChoice } from '@shared/backup-scope'
import type { BackupScope, BackupsView } from '@shared/contracts'
import type { CaptureChoice } from '@/lib/backupSelection'
import { scopeOf } from '@shared/backup-scope'
import { computed, ref, watch } from 'vue'
import { captureItems } from '@/lib/backupSelection'

/**
 * What an automatic backup captures.
 *
 * The schedule took the full default scope and nothing could change that. This offers the same
 * capture list the create dialog does and stores the result in the CLI's own two modes: "only
 * these" is `--include`, "everything except" is `--all --exclude`.
 *
 * `null` is the whole default scope — every workspace plus `paths` — which is what an untouched
 * config has always meant, and what a workspace declared tomorrow will be captured by.
 *
 * The ticks are a draft inside the panel, applied on "apply": binding them to the stored scope
 * directly would re-seed the list from the value the list just produced.
 */
const props = defineProps<{ open: boolean, state: BackupsView | null }>()
const emit = defineEmits<{ close: [] }>()
const scope = defineModel<BackupScope | null>('scope', { required: true })

const draft = ref<CaptureChoice[]>([])
const mode = ref<BackupScope['mode']>('only')

/** Applies a saved scope to the fresh list, using the coarse-id rule the panel captures with. */
function seed(saved: BackupScope | null): CaptureChoice[] {
  const items = captureItems(props.state).map(item => ({ ...item, selected: true }))
  if (saved === null)
    return items
  const covers = (id: string): boolean => saved.ids.some(entry => id === entry || id.startsWith(`${entry}:`))
  const wanted = saved.mode === 'only'
  return items.map(item => ({ ...item, selected: wanted ? covers(item.id) : !covers(item.id) }))
}

watch(() => props.open, (isOpen) => {
  if (!isOpen)
    return
  draft.value = seed(scope.value)
  mode.value = scope.value?.mode ?? 'only'
}, { immediate: true })

/**
 * The ticks as the shared scope rule reads them.
 *
 * noc-console's capture list is flat — one row per leaf id — so every row carries no sub-leaves and
 * the shared rule sees a list of individually selectable ids, which is exactly what it is.
 */
const flat = computed<ScopeChoice[]>(() => draft.value.map(item => ({ id: item.id, selected: item.selected, leaves: [] })))
const outcome = computed(() => scopeOf(flat.value, mode.value))
const nothingPicked = computed(() => outcome.value.kind === 'nothing')
const selectedCount = computed(() => draft.value.filter(item => item.selected).length)

function selectAll(selected: boolean): void {
  for (const item of draft.value) item.selected = selected
}

function apply(): void {
  if (nothingPicked.value)
    return
  // Nothing left out stores as no scope at all: the two capture the same thing today, and only the
  // empty setting also covers a workspace declared tomorrow.
  scope.value = outcome.value.kind === 'scope' ? outcome.value.scope : null
  emit('close')
}
</script>

<template>
  <div v-if="props.open" class="overlay" @click.self="emit('close')">
    <div class="overlay__panel overlay__panel--sheet dialog" role="dialog" aria-label="choose what an automatic backup captures">
      <div class="overlay__head">
        <span class="overlay__title">automatic backup contents</span>
        <span class="view__spacer" />
        <span class="faint">{{ selectedCount }} of {{ draft.length }} selected</span>
        <kbd class="kbd">esc</kbd>
      </div>

      <div class="overlay__body">
        <div class="actions actions--start">
          <button
            type="button"
            class="btn btn--xs"
            :class="mode === 'only' ? 'btn--primary' : ''"
            @click="mode = 'only'"
          >
            only these
          </button>
          <button
            type="button"
            class="btn btn--xs"
            :class="mode === 'except' ? 'btn--primary' : ''"
            @click="mode = 'except'"
          >
            everything except
          </button>
        </div>
        <p class="note">
          <template v-if="mode === 'only'">
            The archive carries only what is ticked. A workspace's data paths follow its own entry.
          </template>
          <template v-else>
            The archive carries everything except what is ticked — including workspaces added later.
          </template>
        </p>

        <div class="actions actions--start">
          <button type="button" class="btn btn--xs btn--ghost" @click="selectAll(true)">
            select all
          </button>
          <button type="button" class="btn btn--xs btn--ghost" @click="selectAll(false)">
            select none
          </button>
        </div>

        <div class="stack">
          <label v-for="item in draft" :key="item.id" class="field field--check">
            <input v-model="item.selected" type="checkbox">
            <span class="field__label">
              {{ item.label }}
              <em class="dim">— {{ item.hint }}</em>
            </span>
          </label>
        </div>

        <p v-if="nothingPicked" class="note note--warn">
          Nothing is ticked — an archive of nothing is refused, so tick at least one item or cancel.
        </p>
      </div>

      <div class="group sheet__foot">
        <div class="actions">
          <button type="button" class="btn btn--sm" @click="emit('close')">
            cancel
          </button>
          <button type="button" class="btn btn--sm btn--primary" :disabled="nothingPicked" @click="apply">
            apply
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
