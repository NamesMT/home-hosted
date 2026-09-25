<script setup lang="ts">
import { computed, onMounted, onScopeDispose, watch } from 'vue'
import { useRouter } from 'vue-router'
import AddServerDialog from '@/components/AddServerDialog.vue'
import HelpOverlay from '@/components/HelpOverlay.vue'
import HostRail from '@/components/HostRail.vue'
import LogDrawer from '@/components/LogDrawer.vue'
import { connect, disconnect, useControlPlane } from '@/composables/useControlPlane'
import { isTyping, runKeyHandlers } from '@/composables/useKeymap'
import { streamDecision, useSession } from '@/composables/useSession'
import { useUi } from '@/composables/useUi'

const router = useRouter()
const control = useControlPlane()
const { session, logout } = useSession()
const { selectedId, drawerOpen, helpOpen, addOpen, changesOpen, configChangesOpen, keyPrefix, toast } = useUi()

const servers = computed(() => control.servers.value)
const connectionLabel = computed(() => ({
  connecting: 'connecting',
  open: 'live',
  closed: 'reconnecting',
}[control.connection.value]))

const selected = computed(() => control.serverById(selectedId.value))
const authenticated = computed(() => session.value?.authenticated === true)
const authRequired = computed(() => session.value?.authRequired === true)
const dataRoot = computed(() => control.appState.value?.dataRoot ?? '')

let prefixTimer: ReturnType<typeof setTimeout> | null = null

const goto: Record<string, string> = { s: 'servers', l: 'logs', v: 'vitals', t: 'settings' }

function focusFilter(): void {
  const field = document.querySelector<HTMLInputElement>('[data-filter]')
  field?.focus()
  field?.select()
}

function onKeydown(event: KeyboardEvent): void {
  const key = event.key

  if (key === 'Escape') {
    if (helpOpen.value) {
      helpOpen.value = false
      event.preventDefault()
      return
    }
    if (addOpen.value) {
      addOpen.value = false
      event.preventDefault()
      return
    }
    if (drawerOpen.value) {
      drawerOpen.value = false
      event.preventDefault()
      return
    }
    if (changesOpen.value) {
      changesOpen.value = false
      event.preventDefault()
      return
    }
    if (configChangesOpen.value) {
      configChangesOpen.value = false
      event.preventDefault()
      return
    }
    if (isTyping(event))
      (event.target as HTMLElement).blur()
    keyPrefix.value = null
    return
  }

  if (helpOpen.value || addOpen.value || changesOpen.value || configChangesOpen.value || isTyping(event))
    return
  if (event.metaKey || event.ctrlKey || event.altKey)
    return

  if (keyPrefix.value === 'g') {
    keyPrefix.value = null
    if (prefixTimer)
      clearTimeout(prefixTimer)
    const target = goto[key]
    if (target) {
      event.preventDefault()
      void router.push({ name: target })
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
        console
      </div>
      <RouterLink to="/" class="nav__item" active-class="nav__item--active" exact-active-class="nav__item--active">
        servers
        <span class="nav__key">g s</span>
      </RouterLink>
      <RouterLink to="/logs" class="nav__item" active-class="nav__item--active">
        logs
        <span class="nav__key">g l</span>
      </RouterLink>
      <RouterLink to="/vitals" class="nav__item" active-class="nav__item--active">
        host vitals
        <span class="nav__key">g v</span>
      </RouterLink>
      <RouterLink to="/settings" class="nav__item" active-class="nav__item--active">
        settings
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
      <LogDrawer v-if="drawerOpen && selectedId" :server-id="selectedId" />
    </div>

    <footer class="status">
      <span class="status__seg">
        <span class="led" :class="`led--${control.connection.value}`" />
        <span class="status__v" :class="{ 'status__v--danger': control.connection.value === 'closed' }">{{ connectionLabel }}</span>
      </span>
      <span class="status__seg">
        <span class="status__k">run</span>
        <span class="status__v">{{ control.runningCount.value }}/{{ servers.length }}</span>
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
