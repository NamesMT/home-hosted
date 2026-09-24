<script setup lang="ts">
import type { LogLine } from '@shared/contracts'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { formatStamp } from '@/lib/format'

const props = withDefaults(defineProps<{
  lines: LogLine[]
  search?: string
  live?: boolean
  empty?: string
  max?: number
}>(), { search: '', live: false, empty: 'no output yet', max: 400 })

interface Segment {
  text: string
  hit: boolean
}

const scroller = ref<HTMLElement | null>(null)
const follow = ref(true)

const visible = computed<LogLine[]>(() => (props.lines.length > props.max ? props.lines.slice(-props.max) : props.lines))
const needle = computed(() => props.search.trim().toLowerCase())

const matchCount = computed(() => {
  const search = needle.value
  if (search.length === 0)
    return 0
  return visible.value.reduce((total, line) => (line.text.toLowerCase().includes(search) ? total + 1 : total), 0)
})

function segments(text: string): Segment[] {
  const search = needle.value
  if (search.length === 0)
    return [{ text, hit: false }]
  const lower = text.toLowerCase()
  const out: Segment[] = []
  let index = 0
  for (;;) {
    const at = lower.indexOf(search, index)
    if (at === -1) {
      out.push({ text: text.slice(index), hit: false })
      return out
    }
    if (at > index)
      out.push({ text: text.slice(index, at), hit: false })
    out.push({ text: text.slice(at, at + search.length), hit: true })
    index = at + search.length
  }
}

async function scrollToBottom(): Promise<void> {
  await nextTick()
  const element = scroller.value
  if (element)
    element.scrollTop = element.scrollHeight
}

watch(() => props.lines.length, () => {
  if (follow.value)
    void scrollToBottom()
})

watch(() => props.max, () => {
  if (follow.value)
    void scrollToBottom()
})

function onScroll(): void {
  const element = scroller.value
  if (!element)
    return
  follow.value = element.scrollHeight - element.scrollTop - element.clientHeight < 24
}

function jump(): void {
  follow.value = true
  void scrollToBottom()
}

onMounted(() => {
  if (follow.value)
    void scrollToBottom()
})

defineExpose({ jump })
</script>

<template>
  <div class="log">
    <div class="log__bar">
      <span class="led" :class="live ? 'led--running' : 'led--stopped'" />
      <span>{{ live ? 'live' : 'disk tail' }}</span>
      <span class="faint">{{ lines.length }} ln</span>
      <span v-if="needle.length > 0" class="accent">{{ matchCount }} hit</span>
      <span class="view__spacer" />
      <label class="row" style="gap: 0.25rem">
        <input v-model="follow" type="checkbox" @change="follow && jump()">
        <span class="faint">follow</span>
      </label>
      <button v-if="!follow" type="button" class="btn btn--xs" @click="jump">
        ↓ bottom
      </button>
    </div>

    <div ref="scroller" class="log__body" @scroll="onScroll">
      <p v-if="visible.length === 0" class="log__empty">
        {{ empty }}
      </p>
      <p
        v-for="(line, index) in visible"
        :key="index"
        class="log__line"
        :class="`log__line--${line.stream}`"
      >
        <span class="log__ts">{{ formatStamp(line.ts) }}</span>
        <span class="log__stream">{{ line.stream }}</span>
        <span class="log__text"><span
          v-for="(segment, at) in segments(line.text)"
          :key="at"
          :class="{ log__hit: segment.hit }"
        >{{ segment.text }}</span></span>
      </p>
    </div>
  </div>
</template>
