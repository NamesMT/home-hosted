<script setup lang="ts">
import type { ServerStatus } from '@shared/contracts'
import type { Component } from 'vue'
import type { ThemePreference } from '@/composables/useTheme'
import {
  ChevronRight,
  Globe,
  Layers,
  LayoutDashboard,
  Monitor,
  Moon,
  Play,
  RotateCw,
  ScrollText,
  Search,
  Server,
  Settings2,
  SlidersHorizontal,
  Square,
  Sun,
  Terminal,
  Waypoints,
} from 'lucide-vue-next'
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import { computed, nextTick, onMounted, onScopeDispose, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useControlPlane } from '@/composables/useControlPlane'
import { useTheme } from '@/composables/useTheme'
import { useWorkspaces } from '@/composables/useWorkspaces'
import { cn } from '@/lib/cn'
import { STATUS_META } from '@/lib/status'
import { workspacePath } from '@/router'

interface PaletteCommand {
  id: string
  title: string
  group: string
  icon: Component
  detail?: string
  keywords?: string
  run: () => void
}

const open = defineModel<boolean>('open', { default: false })

const router = useRouter()
const control = useControlPlane()
const workspace = useWorkspaces()
const theme = useTheme()

const query = ref('')
const activeIndex = ref(0)
const input = ref<HTMLInputElement | null>(null)
const list = ref<HTMLElement | null>(null)

function go(to: string): void {
  void router.push(to)
}

/** Picking a workspace keeps the page and swaps the id, exactly like the header. */
function switchWorkspace(id: string): void {
  workspace.select(id)
  const name = String(router.currentRoute.value.name ?? '')
  if (name === 'overview' || name === 'servers' || name === 'logs' || name === 'settings')
    go(workspacePath(id, name))
  else if (name === 'server-detail')
    go(workspacePath(id, 'servers'))
}

function act(run: () => void): void {
  run()
  open.value = false
}

const STARTABLE: ServerStatus[] = ['stopped', 'crashed', 'conflict']
const STOPPABLE: ServerStatus[] = ['running', 'starting', 'backoff']

const commands = computed<PaletteCommand[]>(() => {
  const out: PaletteCommand[] = []
  const entries = control.allServers.value

  /** Server routes carry the workspace id, so switch scope and go in one step. */
  function inWorkspace(workspaceId: string, to: string): void {
    workspace.select(workspaceId)
    go(to)
  }
  /** The page the palette is open on, for the workspace-scoped "Go to …" entries. */
  const here = (page: 'overview' | 'servers' | 'logs' | 'settings'): string =>
    workspacePath(workspace.activeId.value, page)

  for (const { workspace: owner, server } of entries) {
    const label = server.config.label ?? server.id
    const status = STATUS_META[server.status].label
    out.push({
      id: `open:${owner.id}:${server.id}`,
      title: `Open ${label}`,
      group: 'Servers',
      icon: Server,
      detail: `${owner.label} · ${server.id} · ${status}`,
      keywords: `server detail ${server.id} ${owner.label} show`,
      run: () => inWorkspace(owner.id, workspacePath(owner.id, 'servers', server.id)),
    })
    out.push({
      id: `logs:${owner.id}:${server.id}`,
      title: `Logs for ${label}`,
      group: 'Servers',
      icon: Terminal,
      detail: `${owner.label} · ${server.id}`,
      keywords: `log tail output ${server.id} ${owner.label}`,
      run: () => inWorkspace(owner.id, `${workspacePath(owner.id, 'logs')}?server=${encodeURIComponent(server.id)}`),
    })
    if (STARTABLE.includes(server.status) && server.config.enabled) {
      out.push({
        id: `start:${owner.id}:${server.id}`,
        title: `Start ${label}`,
        group: 'Actions',
        icon: Play,
        detail: `${owner.label} · ${server.id}`,
        keywords: `run launch ${server.id} ${owner.label}`,
        run: () => act(() => void control.start(owner.id, server.id)),
      })
    }
    if (STOPPABLE.includes(server.status)) {
      out.push({
        id: `stop:${owner.id}:${server.id}`,
        title: `Stop ${label}`,
        group: 'Actions',
        icon: Square,
        detail: `${owner.label} · ${server.id}`,
        keywords: `halt kill ${server.id} ${owner.label}`,
        run: () => act(() => void control.stop(owner.id, server.id)),
      })
    }
    if (server.config.enabled) {
      out.push({
        id: `restart:${owner.id}:${server.id}`,
        title: `Restart ${label}`,
        group: 'Actions',
        icon: RotateCw,
        detail: `${owner.label} · ${server.id}`,
        keywords: `bounce reload ${server.id} ${owner.label}`,
        run: () => act(() => void control.restart(owner.id, server.id)),
      })
    }
  }

  out.push(
    { id: 'nav:overview', title: 'Go to Overview', group: 'Navigate', icon: LayoutDashboard, keywords: 'dashboard home workspace', run: () => go(here('overview')) },
    { id: 'nav:global', title: 'Go to Global Overview', group: 'Navigate', icon: Globe, keywords: 'dashboard home host vitals every workspace', run: () => go('/global/overview') },
    { id: 'nav:global-settings', title: 'Go to Global settings', group: 'Navigate', icon: SlidersHorizontal, keywords: 'panel listener auth tls backups host', run: () => go('/global/settings') },
    { id: 'nav:proxy', title: 'Go to Reverse Proxy', group: 'Navigate', icon: Waypoints, keywords: 'caddy domain route acme certificate https expose', run: () => go('/proxy') },
    { id: 'nav:servers', title: 'Go to Servers', group: 'Navigate', icon: Server, keywords: 'processes list workspace', run: () => go(here('servers')) },
    { id: 'nav:logs', title: 'Go to Logs', group: 'Navigate', icon: ScrollText, keywords: 'output files tail workspace', run: () => go(here('logs')) },
    { id: 'nav:settings', title: 'Go to Workspace settings', group: 'Navigate', icon: Settings2, keywords: 'defaults notifications ddns config workspace', run: () => go(here('settings')) },
    { id: 'act:start-all', title: 'Start every enabled server here', group: 'Actions', icon: Play, keywords: 'boot all workspace', run: () => act(() => void control.startAll(workspace.activeId.value)) },
    { id: 'act:stop-all', title: 'Stop every server here', group: 'Actions', icon: Square, keywords: 'halt all workspace', run: () => act(() => void control.stopAll(workspace.activeId.value)) },
  )

  for (const owner of workspace.workspaces.value) {
    out.push({
      id: `ws:${owner.id}`,
      title: `Switch to ${owner.label}`,
      group: 'Workspaces',
      icon: Layers,
      detail: owner.id,
      keywords: `workspace switch scope ${owner.label}`,
      run: () => act(() => switchWorkspace(owner.id)),
    })
  }

  const globalSections = [
    ['listener', 'Listener'],
    ['authentication', 'Authentication'],
    ['host', 'Host vitals'],
    ['backups', 'Backups'],
    ['tls', 'TLS'],
    ['interface', 'Interface'],
    ['paths', 'Paths'],
  ] as const
  for (const [id, label] of globalSections) {
    out.push({
      id: `gset:${id}`,
      title: `Global setting: ${label}`,
      group: 'Global settings',
      icon: Globe,
      keywords: `configure panel ${id}`,
      run: () => go(`/global/settings?section=${id}`),
    })
  }

  const workspaceSections = [
    ['defaults', 'Server defaults'],
    ['logs', 'Log storage'],
    ['notifications', 'Telegram notifications'],
    ['ddns', 'Dynamic DNS'],
  ] as const
  for (const [id, label] of workspaceSections) {
    out.push({
      id: `wset:${id}`,
      title: `Workspace setting: ${label}`,
      group: 'Workspace settings',
      icon: Settings2,
      keywords: `configure workspace ${id}`,
      run: () => go(`${workspacePath(workspace.activeId.value, 'settings')}?section=${id}`),
    })
  }

  const themes: Array<[ThemePreference, string, Component]> = [
    ['light', 'Light', Sun],
    ['dark', 'Dark', Moon],
    ['system', 'System', Monitor],
  ]
  for (const [value, label, icon] of themes) {
    out.push({
      id: `theme:${value}`,
      title: `${label} theme`,
      group: 'Appearance',
      icon,
      keywords: 'colour color dark light mode appearance',
      run: () => act(() => theme.setPreference(value)),
    })
  }

  return out
})

const results = computed(() => {
  const tokens = query.value.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0)
    return commands.value.slice(0, 40)

  const scored = commands.value
    .map((command) => {
      const haystack = `${command.title} ${command.detail ?? ''} ${command.keywords ?? ''} ${command.group}`.toLowerCase()
      let score = 0
      for (const token of tokens) {
        const at = haystack.indexOf(token)
        if (at === -1)
          return null
        score += at === 0 ? 0 : at
      }
      return { command, score }
    })
    .filter((entry): entry is { command: PaletteCommand, score: number } => entry !== null)
    .sort((a, b) => a.score - b.score)

  return scored.slice(0, 40).map(entry => entry.command)
})

const grouped = computed(() => {
  const groups = new Map<string, PaletteCommand[]>()
  for (const command of results.value) {
    const bucket = groups.get(command.group) ?? []
    bucket.push(command)
    groups.set(command.group, bucket)
  }
  return [...groups.entries()]
})

/** Flat order matches the rendered order, so arrow keys track the highlight. */
const flat = computed(() => grouped.value.flatMap(([, items]) => items))

watch(results, () => {
  activeIndex.value = 0
})

watch(open, async (isOpen) => {
  if (isOpen) {
    query.value = ''
    activeIndex.value = 0
    await nextTick()
    input.value?.focus()
  }
})

function move(delta: number): void {
  const total = flat.value.length
  if (total === 0)
    return
  activeIndex.value = (activeIndex.value + delta + total) % total
  void nextTick(() => {
    list.value?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  })
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    move(1)
  }
  else if (event.key === 'ArrowUp') {
    event.preventDefault()
    move(-1)
  }
  else if (event.key === 'Enter') {
    event.preventDefault()
    flat.value[activeIndex.value]?.run()
  }
}

function onGlobalKey(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    open.value = !open.value
  }
}

onMounted(() => window.addEventListener('keydown', onGlobalKey))
onScopeDispose(() => window.removeEventListener('keydown', onGlobalKey))
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-black/40 backdrop-blur-[1px] data-[state=open]:animate-[hh-fade-in_120ms_ease-out]" />
      <DialogContent
        class="fixed left-1/2 top-[10vh] z-50 w-[min(94vw,38rem)] -translate-x-1/2 overflow-hidden rounded-panel border border-line bg-panel shadow-float data-[state=open]:animate-[hh-pop-in_150ms_var(--ease-out-quick)]"
        @open-auto-focus.prevent
        @keydown="onKeydown"
      >
        <DialogTitle class="sr-only">
          Command palette
        </DialogTitle>

        <div class="flex items-center gap-2.5 border-b border-line px-3.5">
          <Search class="size-4 shrink-0 text-faint" />
          <input
            ref="input"
            v-model="query"
            type="text"
            placeholder="Jump to a server, run an action, open a setting…"
            class="h-12 w-full bg-transparent text-sm text-ink outline-none placeholder:text-faint"
            autocomplete="off"
            spellcheck="false"
          >
          <kbd class="shrink-0 rounded border border-line bg-page px-1.5 py-0.5 font-mono text-2xs text-faint">esc</kbd>
        </div>

        <div ref="list" class="max-h-[min(60vh,26rem)] overflow-y-auto p-1.5">
          <p v-if="flat.length === 0" class="px-3 py-8 text-center text-xs text-muted">
            Nothing matches “{{ query }}”.
          </p>

          <template v-for="[group, items] in grouped" :key="group">
            <p class="px-2.5 pb-1 pt-2.5 text-2xs font-medium text-faint">
              {{ group }}
            </p>
            <button
              v-for="command in items"
              :key="command.id"
              type="button"
              :data-active="flat[activeIndex]?.id === command.id"
              :class="cn(
                'flex w-full items-center gap-2.5 rounded-control px-2.5 py-2 text-left transition-colors duration-100',
                flat[activeIndex]?.id === command.id ? 'bg-accent-soft text-ink' : 'text-muted hover:bg-hover',
              )"
              @mousemove="activeIndex = flat.findIndex(entry => entry.id === command.id)"
              @click="command.run()"
            >
              <component :is="command.icon" class="size-4 shrink-0" :class="flat[activeIndex]?.id === command.id ? 'text-accent' : 'text-faint'" />
              <span class="min-w-0 flex-1 truncate text-sm">{{ command.title }}</span>
              <span v-if="command.detail" class="shrink-0 font-mono text-2xs text-faint">{{ command.detail }}</span>
              <ChevronRight class="size-3.5 shrink-0 text-faint opacity-0 transition-opacity duration-100" :class="{ 'opacity-100': flat[activeIndex]?.id === command.id }" />
            </button>
          </template>
        </div>

        <div class="flex items-center gap-3 border-t border-line bg-panel-2 px-3.5 py-2 text-2xs text-faint">
          <span><kbd class="font-mono">↑↓</kbd> navigate</span>
          <span><kbd class="font-mono">↵</kbd> run</span>
          <span class="ml-auto font-mono">{{ flat.length }} results</span>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
