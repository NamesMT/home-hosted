<script setup lang="ts">
import { computed, useSlots } from 'vue'
import { t } from '@/i18n'

/**
 * A translated sentence with slots where its markup goes.
 *
 * A sentence carrying a `<code>` value ("still on the default password `abc`") cannot be split into
 * `t('…')` fragments without handing translators two half-sentences whose grammar only works in
 * English. So the catalog keeps the whole sentence with a `{password}` placeholder, and this splits
 * it on the placeholders, rendering a slot where one is provided and the plain parameter value
 * otherwise. No `v-html`: every piece stays a text node or a component.
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
  // Slotted names are withheld from `t()`, which leaves an unmatched placeholder as literal text
  // (`interpolate` only replaces a name it was given). That is the whole trick: passing the same
  // name as both a slot and a param used to let `t()` substitute it first, silently dropping the
  // markup and rendering the plain value instead.
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
