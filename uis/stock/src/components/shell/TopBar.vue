<script setup lang="ts">
import { Command, LogOut, Menu, Monitor, Moon, Search, Sun } from 'lucide-vue-next'
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuRoot, DropdownMenuSeparator, DropdownMenuTrigger } from 'reka-ui'
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import AppButton from '@/components/ui/AppButton.vue'
import Tip from '@/components/ui/Tip.vue'
import { useTheme } from '@/composables/useTheme'
import { cn } from '@/lib/cn'
import { focusRing } from '@/lib/ui'

const props = defineProps<{
  panelUrl: string
  connection: 'connecting' | 'open' | 'closed'
  authenticated: boolean
}>()

const emit = defineEmits<{ menu: [], palette: [], signOut: [] }>()

const route = useRoute()
const theme = useTheme()

const title = computed(() => {
  if (route.name === 'server-detail')
    return `Servers / ${String(route.params.id ?? '')}`
  return String(route.meta.title ?? 'home-hosted')
})

const themeIcon = computed(() => (theme.preference.value === 'dark' ? Moon : theme.preference.value === 'light' ? Sun : Monitor))
const themeLabel = computed(() => `Theme: ${theme.preference.value}`)

const dotClass = computed(() => ({
  open: 'bg-ok',
  connecting: 'bg-warn',
  closed: 'bg-danger',
}[props.connection]))

const connectionLabel = computed(() => ({
  open: 'Live updates',
  connecting: 'Connecting',
  closed: 'Reconnecting',
}[props.connection]))
</script>

<template>
  <header class="flex h-13 shrink-0 items-center gap-3 border-b border-line bg-panel/80 px-3 backdrop-blur-sm sm:px-4">
    <button
      type="button"
      class="grid size-8 shrink-0 place-items-center rounded-control text-muted hover:bg-hover hover:text-ink lg:hidden"
      aria-label="Open navigation"
      @click="emit('menu')"
    >
      <Menu class="size-4" />
    </button>

    <h1 class="truncate text-sm font-semibold tracking-tight text-ink">
      {{ title }}
    </h1>

    <div class="ml-auto flex items-center gap-1.5">
      <button
        type="button"
        :class="cn(
          'hidden h-8 items-center gap-2 rounded-control border border-line bg-panel-2 px-2.5 text-xs text-faint transition-colors duration-150 hover:border-line hover:text-muted sm:flex',
          focusRing,
        )"
        @click="emit('palette')"
      >
        <Search class="size-3.5" />
        <span class="pr-6">Search or run a command</span>
        <kbd class="rounded border border-line bg-page px-1 py-0.5 font-mono text-2xs text-faint">⌘K</kbd>
      </button>

      <Tip :label="connectionLabel">
        <span class="hidden items-center gap-1.5 rounded-control border border-line bg-panel-2 px-2 py-1.5 md:flex">
          <span :class="cn('size-1.5 rounded-full', dotClass)" />
          <span class="font-mono text-2xs text-muted">{{ panelUrl }}</span>
        </span>
      </Tip>

      <Tip :label="themeLabel">
        <AppButton variant="ghost" size="icon-sm" :aria-label="themeLabel" @click="theme.cycle()">
          <component :is="themeIcon" class="size-4" />
        </AppButton>
      </Tip>

      <DropdownMenuRoot v-if="props.authenticated">
        <DropdownMenuTrigger as-child>
          <AppButton variant="ghost" size="icon-sm" aria-label="Account">
            <span class="grid size-5 place-items-center rounded-full bg-accent-soft font-mono text-2xs font-semibold text-accent">hh</span>
          </AppButton>
        </DropdownMenuTrigger>
        <DropdownMenuPortal>
          <DropdownMenuContent
            :side-offset="6"
            align="end"
            class="z-50 min-w-44 rounded-panel border border-line bg-raise p-1 shadow-float data-[state=open]:animate-[hh-fade-in_120ms_ease-out]"
          >
            <div class="px-2 py-1.5">
              <p class="text-2xs text-faint">
                Signed in
              </p>
              <p class="truncate font-mono text-2xs text-muted">
                {{ props.panelUrl }}
              </p>
            </div>
            <DropdownMenuSeparator class="my-1 h-px bg-line" />
            <DropdownMenuItem
              class="flex cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 text-xs text-muted outline-none data-[highlighted]:bg-hover data-[highlighted]:text-ink"
              @select="emit('signOut')"
            >
              <LogOut class="size-3.5" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenuPortal>
      </DropdownMenuRoot>

      <Tip label="Command palette">
        <AppButton variant="ghost" size="icon-sm" class="sm:hidden" aria-label="Open the command palette" @click="emit('palette')">
          <Command class="size-4" />
        </AppButton>
      </Tip>
    </div>
  </header>
</template>
