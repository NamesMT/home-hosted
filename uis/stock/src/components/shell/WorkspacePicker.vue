<script setup lang="ts">
import type { WorkspaceView } from '@shared/contracts'
import { Check, ChevronsUpDown, Layers, Pencil, Plus, Trash2 } from 'lucide-vue-next'
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui'
import { computed, nextTick, ref } from 'vue'
import AppButton from '@/components/ui/AppButton.vue'
import { cn } from '@/lib/cn'
import { focusRing } from '@/lib/ui'

const props = defineProps<{
  workspaces: WorkspaceView[]
  selectedId: string
}>()

const emit = defineEmits<{
  select: [id: string]
  create: []
  rename: [workspace: WorkspaceView]
  remove: [workspace: WorkspaceView]
}>()

const open = ref(false)
/** The popover is one surface with two views: the picker, then the delete confirmation. */
const confirming = ref(false)

const selected = computed(() => props.workspaces.find(workspace => workspace.id === props.selectedId) ?? null)

function choose(id: string): void {
  emit('select', id)
  open.value = false
}

function askRemove(): void {
  confirming.value = true
}

function cancelRemove(): void {
  confirming.value = false
}

function confirmRemove(): void {
  const target = selected.value
  confirming.value = false
  open.value = false
  if (target !== null)
    emit('remove', target)
}

function startCreate(): void {
  open.value = false
  emit('create')
}

function startRename(): void {
  open.value = false
  if (selected.value !== null)
    emit('rename', selected.value)
}

// A reopened popover always shows the picker, never a stale confirmation.
async function onOpenChange(value: boolean): Promise<void> {
  open.value = value
  if (value) {
    confirming.value = false
    await nextTick()
  }
}
</script>

<template>
  <PopoverRoot :open="open" @update:open="onOpenChange">
    <PopoverTrigger as-child>
      <button
        type="button"
        :class="cn(
          'flex h-8 max-w-36 items-center gap-1.5 rounded-control border border-line bg-panel-2 px-2 text-xs transition-colors duration-150 hover:border-line hover:text-ink sm:max-w-52',
          focusRing,
        )"
        :aria-label="`Workspace: ${selected?.label ?? 'none'}`"
      >
        <Layers class="size-3.5 shrink-0 text-faint" />
        <span class="min-w-0 truncate font-medium text-ink">{{ selected?.label ?? 'No workspace' }}</span>
        <span class="hidden shrink-0 font-mono text-2xs text-faint sm:inline">{{ selected?.runningCount ?? 0 }}/{{ selected?.serverCount ?? 0 }}</span>
        <ChevronsUpDown class="size-3 shrink-0 text-faint" />
      </button>
    </PopoverTrigger>

    <PopoverPortal>
      <PopoverContent
        :side-offset="6"
        align="end"
        class="z-50 w-72 rounded-panel border border-line bg-raise p-1 shadow-float focus-visible:outline-none data-[state=open]:animate-[hh-fade-in_120ms_ease-out]"
      >
        <template v-if="!confirming">
          <p class="px-2 pb-1 pt-1.5 text-2xs font-medium text-faint">
            Workspaces
          </p>

          <ul v-if="workspaces.length > 0" class="max-h-64 overflow-y-auto">
            <li v-for="workspace in workspaces" :key="workspace.id">
              <button
                type="button"
                :class="cn(
                  'flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left transition-colors duration-100',
                  workspace.id === selectedId ? 'bg-accent-soft text-ink' : 'text-muted hover:bg-hover',
                )"
                @click="choose(workspace.id)"
              >
                <Check class="size-3.5 shrink-0" :class="workspace.id === selectedId ? 'text-accent' : 'opacity-0'" />
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-xs">{{ workspace.label }}</span>
                  <span class="block truncate font-mono text-2xs text-faint">{{ workspace.id }}</span>
                </span>
                <span class="shrink-0 font-mono text-2xs text-faint">{{ workspace.runningCount }}/{{ workspace.serverCount }}</span>
              </button>
            </li>
          </ul>
          <p v-else class="px-2 py-2 text-xs text-muted">
            The panel serves no workspace yet.
          </p>

          <div class="my-1 h-px bg-line" />

          <button
            type="button"
            class="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-xs text-muted outline-none transition-colors duration-100 hover:bg-hover hover:text-ink"
            @click="startCreate"
          >
            <Plus class="size-3.5" />
            New workspace…
          </button>

          <template v-if="selected">
            <button
              type="button"
              class="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-xs text-muted outline-none transition-colors duration-100 hover:bg-hover hover:text-ink"
              @click="startRename"
            >
              <Pencil class="size-3.5" />
              Rename “{{ selected.label }}”…
            </button>
            <button
              type="button"
              class="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-xs text-danger outline-none transition-colors duration-100 hover:bg-danger-soft"
              @click="askRemove"
            >
              <Trash2 class="size-3.5" />
              Delete “{{ selected.label }}”…
            </button>
          </template>
        </template>

        <template v-else>
          <p class="px-2 pt-1.5 text-xs font-semibold text-ink">
            Delete “{{ selected?.label }}”?
          </p>
          <p class="mt-1 px-2 text-2xs leading-4 text-muted">
            Its servers are stopped, and its config, settings, logs, secrets and nanny state are removed
            from disk. A backup taken first is the only way back.
          </p>
          <div class="mt-2 flex justify-end gap-1.5 px-1 pb-1">
            <AppButton size="xs" variant="ghost" @click="cancelRemove">
              Keep it
            </AppButton>
            <AppButton size="xs" variant="danger" @click="confirmRemove">
              <Trash2 class="size-3" />Delete workspace
            </AppButton>
          </div>
        </template>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
