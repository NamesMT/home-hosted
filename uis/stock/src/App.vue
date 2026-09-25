<script setup lang="ts">
import { TooltipProvider } from 'reka-ui'
import { computed, onMounted, onScopeDispose, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import CommandPalette from '@/components/shell/CommandPalette.vue'
import SideNav from '@/components/shell/SideNav.vue'
import SystemNotices from '@/components/shell/SystemNotices.vue'
import ToastStack from '@/components/shell/ToastStack.vue'
import TopBar from '@/components/shell/TopBar.vue'
import { connect, disconnect, useControlPlane } from '@/composables/useControlPlane'
import { streamDecision, useSession } from '@/composables/useSession'
import { cn } from '@/lib/cn'

const route = useRoute()
const router = useRouter()
const control = useControlPlane()
const { session, logout } = useSession()

const paletteOpen = ref(false)
const sidebarOpen = ref(false)

const authenticated = computed(() => session.value?.authenticated === true)
const authRequired = computed(() => session.value?.authRequired === true)
const isLogin = computed(() => route.name === 'login')
const isLogs = computed(() => route.name === 'logs')

const servers = computed(() => control.servers.value)
const running = computed(() => servers.value.filter(server => server.status === 'running').length)
const panelUrl = computed(() => control.control.value?.url ?? '—')
const host = computed(() => control.host.value)
/** The panel's own name, from its config; a custom UI is free to ignore it. */
const panelLabel = computed(() => control.control.value?.label ?? 'home-hosted')

// A dropped session (or a 401 from any call) must land on the login view, and the
// event stream follows the session arriving — see `streamDecision` for why this
// watches a decision and not the two flags.
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

watch(() => route.fullPath, () => {
  sidebarOpen.value = false
})

onMounted(async () => {
  if (!authRequired.value || authenticated.value)
    await control.refresh()
})

onScopeDispose(() => disconnect())
</script>

<template>
  <TooltipProvider :delay-duration="300">
    <RouterView v-if="isLogin" />

    <div v-else class="flex h-dvh overflow-hidden bg-page">
      <!-- Static rail on desktop, slide-over below it. -->
      <aside class="hidden w-60 shrink-0 border-r border-line bg-panel/50 lg:block">
        <SideNav
          :host="host"
          :connection="control.connection.value"
          :panel-label="panelLabel"
          :plan-label="panelUrl"
          :running="running"
          :total="servers.length"
        />
      </aside>

      <Transition
        enter-active-class="transition-opacity duration-150"
        leave-active-class="transition-opacity duration-100"
        enter-from-class="opacity-0"
        leave-to-class="opacity-0"
      >
        <div v-if="sidebarOpen" class="fixed inset-0 z-40 bg-black/45 lg:hidden" @click="sidebarOpen = false" />
      </Transition>
      <Transition
        enter-active-class="transition-transform duration-150 ease-out"
        leave-active-class="transition-transform duration-100 ease-in"
        enter-from-class="-translate-x-full"
        leave-to-class="-translate-x-full"
      >
        <aside v-if="sidebarOpen" class="fixed inset-y-0 left-0 z-40 w-64 border-r border-line bg-panel lg:hidden">
          <SideNav
            :host="host"
            :connection="control.connection.value"
            :panel-label="panelLabel"
            :plan-label="panelUrl"
            :running="running"
            :total="servers.length"
            @navigate="sidebarOpen = false"
            @close="sidebarOpen = false"
          />
        </aside>
      </Transition>

      <div class="flex min-w-0 flex-1 flex-col">
        <TopBar
          :panel-url="panelUrl"
          :connection="control.connection.value"
          :authenticated="authenticated"
          @menu="sidebarOpen = true"
          @palette="paletteOpen = true"
          @sign-out="logout()"
        />

        <!-- Gated on the login view, not on a session: a panel with authentication
             off has no session, and those are exactly the panels whose notices
             (a broken config, a default password) used to be invisible. -->
        <SystemNotices
          v-if="!isLogin"
          :control="control.control.value"
          :config-error="control.configError.value"
          :config-path="control.appState.value?.configPath"
        />

        <main :class="cn('min-h-0 flex-1', isLogs ? 'overflow-hidden' : 'overflow-y-auto')">
          <RouterView />
        </main>
      </div>
    </div>

    <CommandPalette v-model:open="paletteOpen" />
    <ToastStack />
  </TooltipProvider>
</template>
