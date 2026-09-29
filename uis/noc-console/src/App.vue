<script setup lang="ts">
import type { WorkspacePage } from '@/router'
import { computed, onMounted, onScopeDispose, watch } from 'vue'
import { useRouter } from 'vue-router'
import AddServerDialog from '@/components/AddServerDialog.vue'
import HelpOverlay from '@/components/HelpOverlay.vue'
import HostRail from '@/components/HostRail.vue'
import LogDrawer from '@/components/LogDrawer.vue'
import WorkspaceSwitcher from '@/components/WorkspaceSwitcher.vue'
import { connect, disconnect, useControlPlane } from '@/composables/useControlPlane'
import { isTyping, runKeyHandlers } from '@/composables/useKeymap'
import { streamDecision, useSession } from '@/composables/useSession'
import { useUi } from '@/composables/useUi'
import { useWorkspaces } from '@/composables/useWorkspaces'
import { workspacePath } from '@/router'

const router = useRouter()
const control = useControlPlane()
const workspace = useWorkspaces()
const { session, logout } = useSession()
const { selectedId, drawerOpen, helpOpen, addOpen, workspaceOpen, changesOpen, configChangesOpen, keyPrefix, toast } = useUi()

const servers = computed(() => workspace.servers.value)
const activeId = computed(() => workspace.activeId.value)
const workspaceLabel = computed(() => workspace.selected.value?.label ?? '—')
const connectionLabel = computed(() => ({
  connecting: 'connecting',
  open: 'live',
  closed: 'reconnecting',
}[control.connection.value]))

const selected = computed(() => workspace.serverById(selectedId.value))
const authenticated = computed(() => session.value?.authenticated === true)
const authRequired = computed(() => session.value?.authRequired === true)
const dataRoot = computed(() => control.dataRoot.value)

/** Falls back to the global overview until the first frame names a workspace. */
function path(page: WorkspacePage): string {
  return activeId.value.length > 0 ? workspacePath(activeId.value, page) : '/global/overview'
}

const serversPath = computed(() => path('servers'))
const logsPath = computed(() => path('logs'))
const settingsPath = computed(() => path('settings'))

let prefixTimer: ReturnType<typeof setTimeout> | null = null

function go(page: 'overview' | 'global-settings' | WorkspacePage): void {
  if (page === 'overview') {
    void router.push('/global/overview')
    return
  }
  if (page === 'global-settings') {
    void router.push('/global/settings')
    return
  }
  if (activeId.value.length === 0)
    return
  void router.push(workspacePath(activeId.value, page))
}

const GOTO: Record<string, 'overview' | 'global-settings' | WorkspacePage> = {
  o: 'overview',
  g: 'global-settings',
  s: 'servers',
  l: 'logs',
  t: 'settings',
}

function focusFilter(): void {
  const field = document.querySelector<HTMLInputElement>('[data-filter]')
  field?.focus()
  field?.select()
}

function closeOverlays(): void {
  if (helpOpen.value) {
    helpOpen.value = false
    return
  }
  if (addOpen.value) {
    addOpen.value = false
    return
  }
  if (drawerOpen.value) {
    drawerOpen.value = false
    return
  }
  if (workspaceOpen.value) {
    workspaceOpen.value = false
    return
  }
  if (changesOpen.value) {
    changesOpen.value = false
    return
  }
  if (configChangesOpen.value)
    configChangesOpen.value = false
}

function onKeydown(event: KeyboardEvent): void {
  const key = event.key

  if (key === 'Escape') {
    closeOverlays()
    if (isTyping(event))
      (event.target as HTMLElement).blur()
    keyPrefix.value = null
    return
  }

  if (helpOpen.value || addOpen.value || workspaceOpen.value || changesOpen.value || configChangesOpen.value || isTyping(event))
    return
  if (event.metaKey || event.ctrlKey || event.altKey)
    return

  if (keyPrefix.value === 'g') {
    keyPrefix.value = null
    if (prefixTimer)
      clearTimeout(prefixTimer)
    const target = GOTO[key]
    if (target) {
      event.preventDefault()
      go(target)
    }
    return
  }

  if (key === 'g') {
    keyPrefix.value = 'g'
    if (prefixTimer)
      clearTimeout(prefixTimer)
    prefixTimer = setTimeout(() => {
      keyPrefix.value = null
    }, 1300)
    return
  }

  if (key === '?') {
    helpOpen.value = true
    event.preventDefault()
    return
  }

  if (key === '/') {
    focusFilter()
    event.preventDefault()
    return
  }

  if (runKeyHandlers(key, event)) {
    event.preventDefault()
    return
  }

  if (key === 'a') {
    addOpen.value = true
    event.preventDefault()
  }
}

// A dropped session (or a 401 from any call) must land on the login view.
const stream = computed(() => streamDecision(session.value))

watch(stream, (decision) => {
  if (decision === 'wait')
    return
  if (decision === 'login') {
    disconnect()
    void router.push({ name: 'login' })
    return
  }
  connect()
}, { immediate: true })

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  if (!authRequired.value || authenticated.value)
    await control.refresh()
})

onScopeDispose(() => {
  window.removeEventListener('keydown', onKeydown)
  disconnect()
})
</script>

<template>
  <div class="shell">
    <div class="brand">
      <span class="brand__mark" />
      <span class="brand__name" :title="control.control.value?.label">{{ control.control.value?.label ?? 'home-hosted' }}</span>
    </div>

    <HostRail />

    <nav class="nav">
      <div class="nav__group">
        global
      </div>
      <RouterLink to="/global/overview" class="nav__item" active-class="nav__item--active">
        overview
        <span class="nav__key">g o</span>
      </RouterLink>
      <RouterLink to="/global/settings" class="nav__item" active-class="nav__item--active">
        global settings
        <span class="nav__key">g g</span>
      </RouterLink>

      <div class="nav__group">
        workspace · {{ workspaceLabel }}
      </div>
      <WorkspaceSwitcher />
      <RouterLink :to="serversPath" class="nav__item" active-class="nav__item--active">
        servers
        <span class="nav__key">g s</span>
      </RouterLink>
      <RouterLink :to="logsPath" class="nav__item" active-class="nav__item--active">
        logs
        <span class="nav__key">g l</span>
      </RouterLink>
      <RouterLink :to="settingsPath" class="nav__item" active-class="nav__item--active">
        workspace settings
        <span class="nav__key">g t</span>
      </RouterLink>

      <button type="button" class="nav__item" @click="helpOpen = true">
        keyboard
        <span class="nav__key">?</span>
      </button>

      <div class="nav__foot">
        <span v-if="authenticated" class="row">
          <button type="button" class="btn btn--xs btn--ghost" @click="logout()">
            sign out
          </button>
        </span>
        <span class="truncate" :title="dataRoot"><code>{{ dataRoot || '—' }}</code></span>
      </div>
    </nav>

    <div class="main">
      <RouterView />
      <LogDrawer v-if="drawerOpen && selectedId && activeId" :server-id="selectedId" :workspace-id="activeId" />
    </div>

    <footer class="status">
      <span class="status__seg">
        <span class="led" :class="`led--${control.connection.value}`" />
        <span class="status__v" :class="{ 'status__v--danger': control.connection.value === 'closed' }">{{ connectionLabel }}</span>
      </span>
      <span class="status__seg">
        <span class="status__k">ws</span>
        <span class="status__v status__v--accent">{{ workspaceLabel }}</span>
      </span>
      <span class="status__seg">
        <span class="status__k">run</span>
        <span class="status__v">{{ workspace.runningCount.value }}/{{ servers.length }}</span>
      </span>
      <span class="status__seg">
        <span class="status__k">sel</span>
        <span class="status__v status__v--accent">{{ selected?.id ?? '—' }}</span>
        <span v-if="selected" class="faint">{{ selected.status }}</span>
      </span>
      <span v-if="keyPrefix" class="status__seg">
        <span class="status__v status__v--warn">{{ keyPrefix }}…</span>
      </span>
      <span class="status__seg status__seg--grow" />
      <span class="status__hint">
        <kbd class="kbd">j</kbd><kbd class="kbd">k</kbd> move
        · <kbd class="kbd">s</kbd> start
        · <kbd class="kbd">x</kbd> stop
        · <kbd class="kbd">r</kbd> restart
        · <kbd class="kbd">l</kbd> logs
        · <kbd class="kbd">e</kbd> edit
        · <kbd class="kbd">/</kbd> filter
        · <kbd class="kbd">?</kbd> keys
      </span>
    </footer>
  </div>

  <HelpOverlay />
  <AddServerDialog :open="addOpen" @close="addOpen = false" />
  <div v-if="toast" class="toast" :class="{ 'toast--error': toast.kind === 'error' }">
    {{ toast.text }}
  </div>
</template>
