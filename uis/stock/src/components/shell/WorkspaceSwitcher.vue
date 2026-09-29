<script setup lang="ts">
import type { WorkspaceView } from '@shared/contracts'
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import WorkspaceDialog from '@/components/shell/WorkspaceDialog.vue'
import WorkspacePicker from '@/components/shell/WorkspacePicker.vue'
import { useWorkspaces } from '@/composables/useWorkspaces'
import { workspacePath } from '@/router'

/**
 * The workspace control at the right edge of the header: pick one, create one,
 * rename it or delete it. Everything it changes comes straight from the state
 * frame, so the pages behind it follow without a reload.
 */
const { workspaces, activeId, select, create, rename, remove } = useWorkspaces()
const route = useRoute()
const router = useRouter()

const dialogOpen = ref(false)
const dialogMode = ref<'create' | 'rename'>('create')
const renameTarget = ref<WorkspaceView | null>(null)

/**
 * Picking a workspace while on a workspace page keeps the page and swaps the id
 * in the URL; on a global page only the stored preference changes, because that
 * page reads every workspace anyway.
 */
function choose(id: string): void {
  select(id)
  const name = String(route.name ?? '')
  if (name === 'overview' || name === 'servers' || name === 'logs' || name === 'settings') {
    void router.push(workspacePath(id, name))
    return
  }
  if (name === 'server-detail')
    void router.push(workspacePath(id, 'servers'))
}

function openCreate(): void {
  dialogMode.value = 'create'
  renameTarget.value = null
  dialogOpen.value = true
}

function openRename(workspace: WorkspaceView): void {
  dialogMode.value = 'rename'
  renameTarget.value = workspace
  dialogOpen.value = true
}

async function submit(label: string): Promise<boolean> {
  if (dialogMode.value === 'create')
    return (await create(label)) !== undefined
  const target = renameTarget.value
  return target === null ? false : rename(target.id, label)
}

/**
 * Deleting the workspace the URL names would leave the page pointing at an id
 * that no longer exists, so it moves to the workspace that took its place.
 */
async function removeWorkspace(target: WorkspaceView): Promise<void> {
  const current = String(route.params.workspaceId ?? '') || activeId.value
  if (!(await remove(target.id)) || current !== target.id)
    return
  const name = String(route.name ?? '')
  if (name === 'overview' || name === 'servers' || name === 'logs' || name === 'settings')
    void router.push(workspacePath(activeId.value, name))
}
</script>

<template>
  <WorkspacePicker
    :workspaces="workspaces"
    :selected-id="activeId"
    @select="choose"
    @create="openCreate"
    @rename="openRename"
    @remove="removeWorkspace"
  />

  <WorkspaceDialog
    v-model:open="dialogOpen"
    :mode="dialogMode"
    :initial="renameTarget?.label ?? ''"
    :submit="submit"
  />
</template>
