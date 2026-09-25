<script setup lang="ts">
import { X } from 'lucide-vue-next'
import { DialogClose, DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import { cn } from '@/lib/cn'
import { focusRing } from '@/lib/ui'

const props = withDefaults(defineProps<{
  title: string
  description?: string
  /** Tailwind width utility for the sheet. */
  width?: string
}>(), {
  description: undefined,
  width: 'w-[min(92vw,34rem)]',
})

const open = defineModel<boolean>('open', { default: false })
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-black/45 backdrop-blur-[1px] data-[state=closed]:animate-[hh-fade-out_120ms_ease-in] data-[state=open]:animate-[hh-fade-in_150ms_ease-out]" />
      <DialogContent
        :class="cn(
          'fixed left-1/2 top-1/2 z-50 flex max-h-[88dvh] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden',
          'rounded-panel border border-line bg-panel shadow-float',
          'data-[state=closed]:animate-[hh-pop-out_120ms_ease-in] data-[state=open]:animate-[hh-pop-in_160ms_var(--ease-out-quick)]',
          props.width,
        )"
      >
        <header class="flex shrink-0 items-start justify-between gap-4 border-b border-line px-4 py-3">
          <div class="min-w-0">
            <DialogTitle class="text-sm font-semibold text-ink">
              {{ props.title }}
            </DialogTitle>
            <DialogDescription v-if="props.description" class="mt-0.5 text-xs text-muted">
              {{ props.description }}
            </DialogDescription>
          </div>
          <DialogClose
            :class="cn('-mr-1 -mt-0.5 grid size-7 shrink-0 place-items-center rounded-control text-muted transition-colors duration-150 hover:bg-hover hover:text-ink', focusRing)"
            aria-label="Close"
          >
            <X class="size-4" />
          </DialogClose>
        </header>
        <!-- The body scrolls, the footer keeps its height: a tall form must never
             push its own save button out of a clipped dialog. -->
        <div class="min-h-0 flex-1 overflow-y-auto px-4 py-3.5">
          <slot />
        </div>
        <footer v-if="$slots.footer" class="flex shrink-0 items-center justify-end gap-2 border-t border-line bg-panel-2 px-4 py-3">
          <slot name="footer" />
        </footer>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
