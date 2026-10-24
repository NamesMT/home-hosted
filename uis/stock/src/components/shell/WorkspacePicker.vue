<script setup lang="ts">
import type { WorkspaceView } from '@shared/contracts'
import { Check, ChevronsUpDown, Layers, Pencil, Plus, Trash2 } from '@lucide/vue'
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui'
import { computed, nextTick, ref } from 'vue'
import AppButton from '@/components/ui/AppButton.vue'
import { t } from '@/i18n'
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
          'flex h-8 min-w-0 max-w-36 items-center gap-1.5 rounded-control border border-line bg-panel-2 px-2 text-xs transition-colors duration-150 hover:border-line hover:text-ink sm:max-w-52',
          focusRing,
        )"
        :aria-label="t('topbar.workspaceLabel', { name: selected?.label ?? t('common.none') })"
      >
        <Layers class="size-3.5 shrink-0 text-faint" />
        <!--
          Below 360 px the trigger is the icon and the chevron only: four 44 px targets plus a
          labelled trigger is 326 px of chrome on a 320 px phone, which scrolled the header
          sideways and squeezed the page title to 0 px. The label is still what the popover
          opens and what `aria-label` announces.
        -->
        <span class="hidden min-w-0 truncate font-medium text-ink min-[360px]:inline">{{ selected?.label ?? t('workspace.none') }}</span>
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
            {{ t('workspace.listHeading') }}
          </p>

          <ul v-if="workspaces.length > 0" class="max-h-64 overflow-y-auto">
            <li v-for="workspace in workspaces" :key="workspace.id">
              <button
                type="button"
                :class="cn(
                  'flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left transition-colors duration-100',
                  workspace.id === selectedId ? 'bg-accent-soft text-ink' : 'text-muted hover:bg-hover',
                  focusRing,
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
            {{ t('workspace.emptyList') }}
          </p>

          <div class="my-1 h-px bg-line" />

          <button
            type="button"
            :class="cn('flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-xs text-muted transition-colors duration-100 hover:bg-hover hover:text-ink', focusRing)"
            @click="startCreate"
          >
            <Plus class="size-3.5" />
            {{ t('workspace.newAction') }}
          </button>

          <template v-if="selected">
            <button
              type="button"
              :class="cn('flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-xs text-muted transition-colors duration-100 hover:bg-hover hover:text-ink', focusRing)"
              @click="startRename"
            >
              <Pencil class="size-3.5" />
              {{ t('workspace.renameActionFor', { name: selected.label }) }}
            </button>
            <button
              type="button"
              :class="cn('flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-xs text-danger transition-colors duration-100 hover:bg-danger-soft', focusRing)"
              @click="askRemove"
            >
              <Trash2 class="size-3.5" />
              {{ t('workspace.deleteActionFor', { name: selected.label }) }}
            </button>
          </template>
        </template>

        <template v-else>
          <p class="px-2 pt-1.5 text-xs font-semibold text-ink">
            {{ t('workspace.deleteTitle', { name: selected?.label ?? '' }) }}
          </p>
          <p class="mt-1 px-2 text-2xs leading-4 text-muted">
            {{ t('workspace.deleteBody') }}
          </p>
          <div class="mt-2 flex justify-end gap-1.5 px-1 pb-1">
            <AppButton size="xs" variant="ghost" @click="cancelRemove">
              {{ t('common.keepIt') }}
            </AppButton>
            <AppButton size="xs" variant="danger" @click="confirmRemove">
              <Trash2 class="size-3" />{{ t('workspace.delete') }}
            </AppButton>
          </div>
        </template>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
