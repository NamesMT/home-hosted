<script setup lang="ts">
import { computed, useSlots } from 'vue'
import { t } from '@/i18n'

/**
 * A translated sentence with slots where its markup goes.
 *
 * A sentence carrying inline markup cannot be split into `t()` fragments without handing translators
 * half-sentences whose grammar only works in English, so the catalog keeps it whole with `{name}`
 * placeholders and this splits on them. No `v-html`: every piece is a text node or a component.
 */
const props = defineProps<{
  /** The catalog key holding the sentence, with `{name}` placeholders. */
  k: string
  /** Values for placeholders that are plain text rather than a slot. */
  params?: Record<string, unknown>
}>()

const slots = useSlots()

/** The placeholder names the caller supplies as markup slots. */
const slotNames = computed(() => Object.keys(slots))

interface Piece { text?: string, slot?: string }

const pieces = computed<Piece[]>(() => {
  // A slotted name is withheld from `t()`, so its placeholder survives for the split below —
  // otherwise `t()` substitutes it first and the markup is silently dropped.
  const kept: Record<string, unknown> = { ...props.params }
  for (const name of slotNames.value)
    delete kept[name]
  const message = t(props.k, kept)

  const out: Piece[] = []
  const pattern = /\{(\w+)\}/g
  let last = 0
  let match = pattern.exec(message)
  while (match !== null) {
    if (match.index > last)
      out.push({ text: message.slice(last, match.index) })
    const name = match[1]!
    out.push(slotNames.value.includes(name) ? { slot: name } : { text: match[0] })
    last = match.index + match[0].length
    match = pattern.exec(message)
  }
  if (last < message.length)
    out.push({ text: message.slice(last) })
  return out
})
</script>

<template>
  <span><template v-for="(piece, index) in pieces" :key="index"><slot v-if="piece.slot" :name="piece.slot" /><template v-else>{{ piece.text }}</template></template></span>
</template>
