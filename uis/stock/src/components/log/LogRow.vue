<script setup lang="ts">
import type { LogLine } from '@shared/contracts'
import type { AnsiSpan } from '@/lib/ansi'
import { computed } from 'vue'
import { parseAnsi } from '@/lib/ansi'
import { formatClockMs } from '@/lib/format'

const props = defineProps<{
  line: LogLine
  query: string
  dark: boolean
  showTime: boolean
}>()

interface Chunk {
  text: string
  hit: boolean
  span: AnsiSpan
}

const spans = computed(() => parseAnsi(props.line.text, props.dark))

const chunks = computed<Chunk[]>(() => {
  const needle = props.query.trim().toLowerCase()
  const out: Chunk[] = []

  for (const span of spans.value) {
    if (needle.length === 0) {
      out.push({ text: span.text, hit: false, span })
      continue
    }

    const haystack = span.text.toLowerCase()
    let cursor = 0
    let at = haystack.indexOf(needle)
    while (at !== -1) {
      if (at > cursor)
        out.push({ text: span.text.slice(cursor, at), hit: false, span })
      out.push({ text: span.text.slice(at, at + needle.length), hit: true, span })
      cursor = at + needle.length
      at = haystack.indexOf(needle, cursor)
    }
    if (cursor < span.text.length)
      out.push({ text: span.text.slice(cursor), hit: false, span })
  }

  return out
})

const STREAM_CLASS = {
  stdout: 'bg-transparent',
  stderr: 'bg-danger',
  system: 'bg-info',
} as const

function styleOf(chunk: Chunk): Record<string, string> {
  const style: Record<string, string> = {}
  if (chunk.span.fg)
    style.color = chunk.span.fg
  if (chunk.span.bg)
    style.backgroundColor = chunk.span.bg
  if (chunk.span.bold)
    style.fontWeight = '600'
  if (chunk.span.dim)
    style.opacity = '0.62'
  if (chunk.span.italic)
    style.fontStyle = 'italic'
  if (chunk.span.underline)
    style.textDecoration = 'underline'
  if (chunk.hit) {
    style.backgroundColor = 'var(--warn)'
    style.color = 'var(--accent-ink)'
    style.borderRadius = '2px'
  }
  return style
}
</script>

<template>
  <div class="flex h-5 w-max min-w-full items-center gap-2 whitespace-pre px-2 font-mono text-xs leading-5">
    <span v-if="props.showTime" class="shrink-0 select-none text-faint">{{ formatClockMs(props.line.ts) }}</span>
    <span class="h-3.5 w-0.5 shrink-0 rounded-full" :class="[STREAM_CLASS[props.line.stream]]" aria-hidden="true" />
    <span class="min-w-0"><span v-for="(chunk, index) in chunks" :key="index" :style="styleOf(chunk)">{{ chunk.text }}</span></span>
  </div>
</template>
