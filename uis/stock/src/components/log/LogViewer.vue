<script setup lang="ts">
import type { LogLine } from '@shared/contracts'
import { ArrowDownToLine, ChevronDown, ChevronUp, Circle, Pause, Play, Search, Trash2, X } from 'lucide-vue-next'
import { computed, onMounted, onScopeDispose, ref, watch } from 'vue'
import LogRow from '@/components/log/LogRow.vue'
import AppButton from '@/components/ui/AppButton.vue'
import SegmentedControl from '@/components/ui/SegmentedControl.vue'
import Tip from '@/components/ui/Tip.vue'
import { useTheme } from '@/composables/useTheme'
import { cn } from '@/lib/cn'
import { inputClass } from '@/lib/ui'

const props = withDefaults(defineProps<{
  lines: LogLine[]
  /** Changes whenever `lines` gained content; the array itself is mutated in place. */
  version?: number
  live?: boolean
  emptyHint?: string
  clearable?: boolean
  downloadUrl?: string
  downloadName?: string
  minHeight?: string
}>(), {
  version: 0,
  live: false,
  emptyHint: 'No output yet.',
  clearable: false,
  downloadUrl: undefined,
  downloadName: undefined,
  minHeight: '16rem',
})

const emit = defineEmits<{ clear: [] }>()

/** Fixed row height is what makes 8000 lines cost nothing to scroll. */
const ROW_H = 20
const OVERSCAN = 12

const theme = useTheme()

const scroller = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const viewport = ref(320)
const follow = ref(true)
const stream = ref('all')
const query = ref('')
const showTime = ref(true)
const currentMatch = ref(0)

const filtered = computed<LogLine[]>(() => {
  // `version` is the invalidation signal for the in-place buffer.
  void props.version
  const needle = query.value.trim().toLowerCase()
  const streamFilter = stream.value
  if (needle.length === 0 && streamFilter === 'all')
    return props.lines
  return props.lines.filter((line) => {
    if (streamFilter !== 'all' && line.stream !== streamFilter)
      return false
    if (needle.length > 0 && !line.text.toLowerCase().includes(needle))
      return false
    return true
  })
})

const total = computed(() => filtered.value.length)

const matches = computed<number[]>(() => {
  const needle = query.value.trim().toLowerCase()
  if (needle.length === 0)
    return []
  const out: number[] = []
  const rows = filtered.value
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index]!.text.toLowerCase().includes(needle))
      out.push(index)
  }
  return out
})

const start = computed(() => Math.max(0, Math.floor(scrollTop.value / ROW_H) - OVERSCAN))
const end = computed(() => Math.min(total.value, Math.ceil((scrollTop.value + viewport.value) / ROW_H) + OVERSCAN))
const window_ = computed(() => filtered.value.slice(start.value, end.value))

const activeMatchIndex = computed(() => matches.value[currentMatch.value] ?? -1)

function onScroll(): void {
  const element = scroller.value
  if (!element)
    return
  scrollTop.value = element.scrollTop
  const distance = element.scrollHeight - element.scrollTop - element.clientHeight
  follow.value = distance < 12
}

function scrollToBottom(): void {
  const element = scroller.value
  if (!element)
    return
  element.scrollTop = element.scrollHeight
  scrollTop.value = element.scrollTop
  follow.value = true
}

function scrollToRow(index: number): void {
  const element = scroller.value
  if (!element)
    return
  element.scrollTop = Math.max(0, index * ROW_H - element.clientHeight / 2)
  scrollTop.value = element.scrollTop
  follow.value = false
}

function stepMatch(delta: number): void {
  const count = matches.value.length
  if (count === 0)
    return
  currentMatch.value = (currentMatch.value + delta + count) % count
  scrollToRow(matches.value[currentMatch.value]!)
}

watch(total, () => {
  if (follow.value) {
    currentMatch.value = 0
    requestAnimationFrame(scrollToBottom)
  }
})

watch(matches, () => {
  currentMatch.value = 0
  if (matches.value.length > 0 && query.value.trim().length > 0)
    requestAnimationFrame(() => scrollToRow(matches.value[0]!))
})

watch(stream, () => {
  follow.value = true
  requestAnimationFrame(scrollToBottom)
})

let observer: ResizeObserver | null = null

onMounted(() => {
  const element = scroller.value
  if (!element)
    return
  viewport.value = element.clientHeight
  observer = new ResizeObserver(() => {
    if (scroller.value)
      viewport.value = scroller.value.clientHeight
  })
  observer.observe(element)
  scrollToBottom()
})

onScopeDispose(() => {
  observer?.disconnect()
  observer = null
})

const streamOptions = [
  { value: 'all', label: 'All' },
  { value: 'stdout', label: 'out' },
  { value: 'stderr', label: 'err' },
  { value: 'system', label: 'sys' },
]
</script>

<template>
  <div class="flex min-h-0 flex-col overflow-hidden rounded-panel border border-line bg-panel">
    <header class="flex flex-wrap items-center gap-2 border-b border-line bg-panel-2/60 px-2.5 py-2">
      <SegmentedControl v-model="stream" :options="streamOptions" />

      <div class="relative min-w-40 flex-1 sm:max-w-72">
        <Search class="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
        <input
          v-model="query"
          type="search"
          placeholder="Search this output"
          class="h-7 py-0 pl-7 text-xs" :class="[inputClass]"
          aria-label="Search the log output"
          @keydown.enter.prevent="stepMatch($event.shiftKey ? -1 : 1)"
        >
        <div class="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
          <span v-if="query.trim().length > 0" class="px-1 font-mono text-2xs tabular-nums text-faint">
            {{ matches.length === 0 ? '0' : `${currentMatch + 1}/${matches.length}` }}
          </span>
          <button
            v-if="query.length > 0"
            type="button"
            class="grid size-5 place-items-center rounded text-faint hover:text-ink"
            aria-label="Clear the search"
            @click="query = ''"
          >
            <X class="size-3" />
          </button>
          <button
            v-if="matches.length > 0"
            type="button"
            class="grid size-5 place-items-center rounded text-faint hover:text-ink"
            aria-label="Previous match"
            @click="stepMatch(-1)"
          >
            <ChevronUp class="size-3" />
          </button>
          <button
            v-if="matches.length > 0"
            type="button"
            class="grid size-5 place-items-center rounded text-faint hover:text-ink"
            aria-label="Next match"
            @click="stepMatch(1)"
          >
            <ChevronDown class="size-3" />
          </button>
        </div>
      </div>

      <div class="ml-auto flex items-center gap-1.5">
        <Tip :label="showTime ? 'Hide timestamps' : 'Show timestamps'">
          <AppButton size="xs" variant="ghost" @click="showTime = !showTime">
            <Circle :class="cn('size-3', showTime ? 'fill-accent text-accent' : 'text-faint')" />
            ts
          </AppButton>
        </Tip>

        <AppButton
          size="xs"
          :variant="follow ? 'secondary' : 'primary'"
          @click="follow ? (follow = false) : scrollToBottom()"
        >
          <component :is="follow ? Pause : Play" class="size-3" />
          {{ follow ? 'Pause' : 'Follow' }}
        </AppButton>

        <Tip v-if="props.clearable" label="Clear the in-memory buffer">
          <AppButton size="icon-sm" variant="ghost" aria-label="Clear the log buffer" @click="emit('clear')">
            <Trash2 class="size-3.5" />
          </AppButton>
        </Tip>

        <Tip v-if="props.downloadUrl" label="Download the persisted file">
          <a :href="props.downloadUrl" :download="props.downloadName">
            <AppButton size="icon-sm" variant="ghost" aria-label="Download the log file">
              <ArrowDownToLine class="size-3.5" />
            </AppButton>
          </a>
        </Tip>
      </div>
    </header>

    <div class="relative min-h-0 flex-1">
      <div
        ref="scroller"
        class="h-full overflow-auto overscroll-contain bg-page/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50"
        :style="{ minHeight: props.minHeight }"
        tabindex="0"
        role="log"
        aria-label="Log output"
        @scroll.passive="onScroll"
      >
        <p v-if="total === 0" class="px-3 py-6 text-center text-xs text-faint">
          {{ props.lines.length === 0 ? props.emptyHint : 'Nothing matches that search or stream filter.' }}
        </p>

        <div v-else class="relative w-full" :style="{ height: `${total * ROW_H}px` }">
          <div
            v-for="(line, index) in window_"
            :key="start + index"
            class="absolute left-0 top-0"
            :style="{ transform: `translateY(${(start + index) * ROW_H}px)` }"
            :class="start + index === activeMatchIndex && 'bg-warn/10'"
          >
            <LogRow :line="line" :query="query" :dark="theme.isDark.value" :show-time="showTime" />
          </div>
        </div>
      </div>

      <Transition
        enter-active-class="transition duration-150"
        leave-active-class="transition duration-100"
        enter-from-class="opacity-0 translate-y-1"
        leave-to-class="opacity-0 translate-y-1"
      >
        <button
          v-if="!follow && total > 0"
          type="button"
          class="absolute bottom-3 right-4 flex items-center gap-1.5 rounded-full border border-line bg-raise px-2.5 py-1 text-2xs text-muted shadow-float transition-colors duration-150 hover:text-ink"
          @click="scrollToBottom"
        >
          <ArrowDownToLine class="size-3" />
          Jump to latest
        </button>
      </Transition>
    </div>

    <footer class="flex items-center gap-3 border-t border-line bg-panel-2/60 px-2.5 py-1.5 text-2xs text-faint">
      <span class="flex items-center gap-1.5">
        <span :class="cn('size-1.5 rounded-full', props.live ? (follow ? 'bg-ok' : 'bg-warn') : 'bg-faint')" />
        {{ props.live ? (follow ? 'streaming' : 'paused') : 'snapshot' }}
      </span>
      <span class="font-mono tabular-nums">
        {{ total === props.lines.length ? `${total} lines` : `${total} of ${props.lines.length} lines` }}
      </span>
      <span v-if="query.trim().length > 0" class="font-mono tabular-nums">{{ matches.length }} matches</span>
      <span class="ml-auto hidden font-mono tabular-nums sm:inline">row height {{ ROW_H }}px · windowed</span>
    </footer>
  </div>
</template>
