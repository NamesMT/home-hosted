<script setup lang="ts">
import type { WorkspacePage } from '@/router'
import { computed, nextTick, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { workspaceOpen } from '@/composables/useUi'
import { useWorkspaces } from '@/composables/useWorkspaces'
import { workspacePath } from '@/router'

/**
 * The workspace control: pick one, create one, rename it or delete it. Everything
 * it changes comes straight from the state frame, so the pages behind it follow
 * without a reload.
 */
const { workspaces, selected, activeId, select, create, rename, remove, creating } = useWorkspaces()
const route = useRoute()
const router = useRouter()

type Mode = 'list' | 'create' | 'rename' | 'remove'

const mode = ref<Mode>('list')
const targetId = ref('')
const label = ref('')
const busy = ref(false)
const error = ref<string | null>(null)
const nameField = ref<HTMLInputElement | null>(null)

const target = computed(() => workspaces.value.find(workspace => workspace.id === targetId.value) ?? selected.value)
/** What the panel would derive the id from, so the URL part is never a surprise. */
const derivedId = computed(() => label.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40))

watch(workspaceOpen, (open) => {
  if (!open) {
    mode.value = 'list'
    error.value = null
  }
})

watch(mode, async (next) => {
  if (next === 'create' || next === 'rename') {
    await nextTick()
    nameField.value?.focus()
    nameField.value?.select()
  }
})

function openPanel(): void {
  mode.value = 'list'
  error.value = null
  workspaceOpen.value = true
}

/** Keeps the page a person is on and swaps only the workspace in the URL. */
function choose(id: string): void {
  select(id)
  workspaceOpen.value = false
  const name = String(route.name ?? '')
  if (name === 'servers' || name === 'logs' || name === 'settings') {
    void router.push(workspacePath(id, name as WorkspacePage))
    return
  }
  if (name === 'server-config') {
    const serverId = String(route.params.id ?? '')
    void router.push(serverId.length > 0 ? workspacePath(id, 'servers', serverId) : workspacePath(id, 'servers'))
  }
}

async function submit(): Promise<void> {
  const value = label.value.trim()
  if (value.length === 0) {
    error.value = 'a workspace needs a name'
    return
  }
  busy.value = true
  error.value = null
  try {
    if (mode.value === 'create') {
      const workspace = await create(value)
      if (workspace === undefined) {
        error.value = 'the workspace could not be created'
        return
      }
      workspaceOpen.value = false
      void router.push(workspacePath(workspace.id, 'servers'))
      return
    }
    const workspace = target.value
    if (workspace === null)
      return
    if (!(await rename(workspace.id, value))) {
      error.value = 'the workspace could not be renamed'
      return
    }
    workspaceOpen.value = false
  }
  finally {
    busy.value = false
  }
}

/**
 * Deleting the workspace the URL names would leave the page pointing at an id
 * that no longer exists, so it moves to the workspace that took its place.
 */
async function confirmRemove(): Promise<void> {
  const workspace = target.value
  if (workspace === null)
    return
  busy.value = true
  error.value = null
  try {
    const removedId = workspace.id
    if (!(await remove(removedId))) {
      error.value = 'the workspace could not be deleted'
      return
    }
    workspaceOpen.value = false
    const current = String(route.params.workspaceId ?? '') || activeId.value
    if (current !== removedId)
      return
    const name = String(route.name ?? '')
    if (name === 'servers' || name === 'logs' || name === 'settings')
      void router.push(workspacePath(activeId.value, name as WorkspacePage))
    else if (name === 'server-config')
      void router.push(workspacePath(activeId.value, 'servers'))
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <button
    type="button"
    class="ws__trigger"
    :title="`workspace: ${selected?.label ?? 'none'}`"
    @click="openPanel"
  >
    <span class="ws__mark" />
    <span class="ws__label truncate">{{ selected?.label ?? 'no workspace' }}</span>
    <span class="ws__count">{{ selected?.runningCount ?? 0 }}/{{ selected?.serverCount ?? 0 }}</span>
  </button>

  <div v-if="workspaceOpen" class="overlay" @click.self="workspaceOpen = false">
    <div class="overlay__panel ws__panel" role="dialog" aria-label="workspaces">
      <div class="overlay__head">
        <span class="overlay__title">workspaces</span>
        <span class="view__spacer" />
        <kbd class="kbd">esc</kbd>
        <button type="button" class="btn btn--xs btn--ghost" @click="workspaceOpen = false">
          close
        </button>
      </div>

      <div class="overlay__body">
        <template v-if="mode === 'list'">
          <div class="ws__list">
            <button
              v-for="workspace in workspaces"
              :key="workspace.id"
              type="button"
              class="ws__row"
              :class="{ 'ws__row--active': workspace.id === activeId }"
              @click="choose(workspace.id)"
            >
              <span class="ws__check">{{ workspace.id === activeId ? '▪' : '' }}</span>
              <span class="ws__rowlabel truncate">{{ workspace.label }}</span>
              <span class="ws__rowid truncate mono">{{ workspace.id }}</span>
              <span class="ws__rowcount mono">{{ workspace.runningCount }}/{{ workspace.serverCount }}</span>
            </button>
            <p v-if="workspaces.length === 0" class="empty">
              the panel serves no workspace yet
            </p>
          </div>

          <div class="actions ws__actions">
            <button type="button" class="btn btn--sm btn--primary" @click="mode = 'create'; label = ''">
              new workspace
            </button>
            <button v-if="selected" type="button" class="btn btn--sm" @click="mode = 'rename'; targetId = selected.id; label = selected.label">
              rename
            </button>
            <button v-if="selected" type="button" class="btn btn--sm btn--danger" @click="mode = 'remove'; targetId = selected.id">
              delete
            </button>
          </div>
          <p v-if="error" class="note note--error">
            {{ error }}
          </p>
        </template>

        <template v-else-if="mode === 'remove'">
          <p class="note note--warn">
            Delete “{{ target?.label }}”? Its servers are stopped, and its config, settings, logs,
            secrets and nanny state are removed from disk. A backup taken first is the only way back.
          </p>
          <div class="actions">
            <button type="button" class="btn btn--sm btn--primary" :disabled="busy" @click="mode = 'list'">
              keep it
            </button>
            <button type="button" class="btn btn--sm btn--danger" :disabled="busy" @click="confirmRemove">
              {{ busy ? 'deleting…' : 'delete workspace' }}
            </button>
          </div>
          <p v-if="error" class="note note--error">
            {{ error }}
          </p>
        </template>

        <template v-else>
          <label class="field">
            <span class="field__label">{{ mode === 'create' ? 'name' : `rename “${target?.label}”` }}</span>
            <input ref="nameField" v-model="label" maxlength="60" placeholder="Home lab" @keydown.enter.prevent="submit">
            <span v-if="mode === 'create' && derivedId.length > 0" class="field__hint">shown everywhere · id: {{ derivedId }}</span>
            <span v-else-if="mode === 'create'" class="field__hint">shown everywhere.</span>
            <span v-else class="field__hint">only the name changes; the workspace id stays.</span>
          </label>

          <div class="actions">
            <button type="button" class="btn btn--sm" :disabled="busy" @click="mode = 'list'">
              cancel
            </button>
            <button type="button" class="btn btn--sm btn--primary" :disabled="busy || creating" @click="submit">
              {{ mode === 'create' ? 'create workspace' : 'rename' }}
            </button>
          </div>
          <p v-if="error" class="note note--error">
            {{ error }}
          </p>
        </template>
      </div>
    </div>
  </div>
</template>
