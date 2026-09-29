<script setup lang="ts">
import type { BackupsView } from '@shared/contracts'
import type { EntryChoice } from '@/components/settings/backupSelection'
import { Boxes, Layers } from 'lucide-vue-next'
import { computed, ref, watch } from 'vue'
import { allLeavesSelected, captureEntries, includeIds, selectAll, selectionCount } from '@/components/settings/backupSelection'
import Notice from '@/components/settings/Notice.vue'
import AppButton from '@/components/ui/AppButton.vue'
import CheckField from '@/components/ui/CheckField.vue'
import Modal from '@/components/ui/Modal.vue'
import TextField from '@/components/ui/TextField.vue'
import * as api from '@/lib/api'

const props = defineProps<{ state: BackupsView | null }>()
const emit = defineEmits<{ created: [message: string] }>()

const open = defineModel<boolean>('open', { default: false })

const busy = ref(false)
const error = ref<string | null>(null)
const password = ref('')
const choices = ref<EntryChoice[]>([])

/** The workspace sub-dialog: its leaves are edited on a draft and applied at once. */
const subOpen = ref(false)
const subTarget = ref<EntryChoice | null>(null)
const subDraft = ref<Record<string, boolean>>({})

function rebuild(preserve: boolean): void {
  choices.value = captureEntries(props.state?.entries ?? [], preserve ? choices.value : [])
}

const counts = computed(() => selectionCount(choices.value))
const configSelected = computed(() => choices.value.find(entry => entry.id === 'global:settings')?.selected ?? false)
const canCreate = computed(() => props.state !== null && counts.value.leaves > 0 && !busy.value)

const subSelected = computed(() => subTarget.value === null ? 0 : subTarget.value.leaves.filter(leaf => subDraft.value[leaf.id] === true).length)

watch(open, (isOpen) => {
  if (!isOpen)
    return
  password.value = ''
  error.value = null
  rebuild(false)
}, { immediate: true })

// The declared paths land after the first frame; keep whatever the person already ticked.
watch(() => props.state, () => {
  if (open.value)
    rebuild(true)
})

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
  // A workspace whose items were all unticked is not captured, even if it was listed.
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

async function submit(): Promise<void> {
  if (!canCreate.value)
    return
  busy.value = true
  error.value = null
  try {
    await api.createBackup(password.value, includeIds(choices.value))
    open.value = false
    emit('created', 'Backup created.')
  }
  catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <Modal
    v-model:open="open"
    title="Create a backup"
    description="Pick what this archive captures. Nothing is written until you create it."
    width="w-[min(92vw,40rem)]"
  >
    <div class="space-y-3">
      <div class="flex items-center justify-between gap-2">
        <span class="text-xs font-medium text-muted">
          {{ counts.entries }} entr{{ counts.entries === 1 ? 'y' : 'ies' }} · {{ counts.leaves }} item{{ counts.leaves === 1 ? '' : 's' }} selected
        </span>
        <div class="flex items-center gap-1.5">
          <AppButton size="xs" variant="ghost" :disabled="busy" @click="selectAll(choices, true)">
            Select all
          </AppButton>
          <AppButton size="xs" variant="ghost" :disabled="busy" @click="selectAll(choices, false)">
            Select none
          </AppButton>
        </div>
      </div>

      <ul class="max-h-80 space-y-1.5 overflow-auto">
        <li
          v-for="entry in choices"
          :key="entry.id"
          class="rounded-control border border-line-soft bg-panel-2/30 px-2.5 py-2"
        >
          <div class="flex items-start gap-2.5">
            <div class="min-w-0 flex-1">
              <CheckField
                v-model="entry.selected"
                :label="entry.label"
                :hint="entry.hint"
                :disabled="busy"
              />
            </div>
            <div v-if="entry.kind === 'workspace'" class="flex shrink-0 items-center gap-1.5 pt-0.5">
              <span class="font-mono text-2xs text-faint">{{ entry.leaves.filter(l => l.selected).length }}/{{ entry.leaves.length }}</span>
              <AppButton size="xs" variant="secondary" :disabled="busy" @click="openSub(entry)">
                <Boxes class="size-3" />Choose items
              </AppButton>
            </div>
            <span
              v-else
              class="shrink-0 rounded-control border border-line px-1.5 py-0.5 text-2xs text-faint"
            >{{ entry.kind }}</span>
          </div>

          <p
            v-if="entry.kind === 'workspace' && entry.selected && !allLeavesSelected(entry) && entry.leaves.some(l => l.selected)"
            class="mt-1 flex items-center gap-1 pl-6 text-2xs text-warn"
          >
            <Layers class="size-3" />
            Only the chosen items are captured.
          </p>
        </li>
      </ul>

      <Notice v-if="!configSelected" tone="warn">
        Without the global settings, a restore can only place a workspace where the target panel already declares it.
      </Notice>

      <TextField
        v-model="password"
        type="password"
        autocomplete="new-password"
        label="Password (optional)"
        hint="Encrypts the archive; restoring it asks for the same password."
        wide
      />

      <Notice v-if="error" tone="danger">
        {{ error }}
      </Notice>
    </div>

    <template #footer>
      <AppButton size="sm" variant="ghost" :disabled="busy" @click="open = false">
        Cancel
      </AppButton>
      <AppButton size="sm" variant="primary" :disabled="!canCreate" :loading="busy" @click="submit">
        Create backup
      </AppButton>
    </template>
  </Modal>

  <Modal
    v-model:open="subOpen"
    :title="subTarget === null ? 'Choose items' : `${subTarget.label} — choose items`"
    description="A workspace can be captured whole or only its settings, servers, secrets and declared data paths."
    width="w-[min(92vw,34rem)]"
  >
    <div class="space-y-3">
      <div class="flex items-center justify-between gap-2">
        <span class="text-xs font-medium text-muted">{{ subSelected }} of {{ subTarget?.leaves.length ?? 0 }} selected</span>
        <div class="flex items-center gap-1.5">
          <AppButton size="xs" variant="ghost" @click="toggleAllSub(true)">
            Select all
          </AppButton>
          <AppButton size="xs" variant="ghost" @click="toggleAllSub(false)">
            Select none
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
        This workspace declares nothing selectable yet.
      </p>
    </div>

    <template #footer>
      <AppButton size="sm" variant="ghost" @click="subOpen = false">
        Cancel
      </AppButton>
      <AppButton size="sm" variant="primary" @click="applySub">
        Apply
      </AppButton>
    </template>
  </Modal>
</template>
