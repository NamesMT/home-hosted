<script setup lang="ts">
import type { HostView } from '@shared/contracts'
import { LayoutDashboard, ScrollText, Server, SlidersHorizontal, X } from 'lucide-vue-next'
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import InstrumentCluster from '@/components/shell/InstrumentCluster.vue'
import { cn } from '@/lib/cn'

const props = defineProps<{
  host: HostView | null
  connection: 'connecting' | 'open' | 'closed'
  /** The panel's own name (`control.label`), so a custom UI can rename itself. */
  panelLabel: string
  planLabel: string
  running: number
  total: number
}>()

const emit = defineEmits<{ navigate: [], close: [] }>()

const route = useRoute()

const items = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, exact: true },
  { to: '/servers', label: 'Servers', icon: Server, exact: false },
  { to: '/logs', label: 'Logs', icon: ScrollText, exact: false },
  { to: '/settings', label: 'Settings', icon: SlidersHorizontal, exact: false },
]

function isActive(item: typeof items[number]): boolean {
  return item.exact ? route.path === item.to : route.path === item.to || route.path.startsWith(`${item.to}/`)
}

const connectionMeta = computed(() => ({
  open: { label: 'Live', dot: 'bg-ok' },
  connecting: { label: 'Connecting', dot: 'bg-warn' },
  closed: { label: 'Reconnecting', dot: 'bg-danger' },
}[props.connection]))
</script>

<template>
  <div class="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3">
    <div class="flex items-center gap-2 px-1 pt-1">
      <span class="grid size-8 shrink-0 place-items-center rounded-[9px] border border-accent/30 bg-accent-soft text-accent">
        <svg viewBox="0 0 24 24" class="size-4.5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round">
          <path d="M4 15.5a8 8 0 1 1 16 0" />
          <path d="M12 15.5 15.6 10.2" />
          <circle cx="12" cy="15.5" r="1.3" fill="currentColor" stroke="none" />
        </svg>
      </span>
      <div class="min-w-0">
        <p class="truncate text-sm font-semibold tracking-tight text-ink">
          home-hosted
        </p>
        <p class="truncate text-2xs text-faint">
          {{ props.panelLabel }}
        </p>
      </div>
      <button
        type="button"
        class="ml-auto grid size-7 place-items-center rounded-control text-muted hover:bg-hover hover:text-ink lg:hidden"
        aria-label="Close navigation"
        @click="emit('close')"
      >
        <X class="size-4" />
      </button>
    </div>

    <nav class="flex flex-col gap-0.5">
      <RouterLink
        v-for="item in items"
        :key="item.to"
        :to="item.to"
        :class="cn(
          'group flex items-center gap-2.5 rounded-control px-2.5 py-1.5 text-sm transition-colors duration-150',
          isActive(item)
            ? 'bg-accent-soft font-medium text-accent'
            : 'text-muted hover:bg-hover hover:text-ink',
        )"
        @click="emit('navigate')"
      >
        <component :is="item.icon" class="size-4 shrink-0" :stroke-width="isActive(item) ? 2.1 : 1.8" />
        {{ item.label }}
        <span
          v-if="item.to === '/servers'"
          class="ml-auto font-mono text-2xs tabular-nums"
          :class="isActive(item) ? 'text-accent' : 'text-faint'"
        >{{ props.running }}/{{ props.total }}</span>
      </RouterLink>
    </nav>

    <div class="mt-auto flex flex-col gap-3">
      <InstrumentCluster :host="props.host" />

      <div class="flex items-center gap-2 rounded-control border border-line bg-panel-2/70 px-2.5 py-2">
        <span class="relative flex size-2 shrink-0">
          <span :class="cn('absolute inset-0 rounded-full', connectionMeta.dot, props.connection !== 'open' && 'animate-ping opacity-60')" />
          <span :class="cn('relative size-2 rounded-full', connectionMeta.dot)" />
        </span>
        <span class="text-2xs text-muted">{{ connectionMeta.label }}</span>
        <span class="ml-auto truncate font-mono text-2xs text-faint" :title="props.planLabel">{{ props.planLabel }}</span>
      </div>
    </div>
  </div>
</template>
