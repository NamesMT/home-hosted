<script setup lang="ts">
import type { Tone } from '@/lib/status'
import { CircleCheck, CircleX, Info, TriangleAlert, X } from 'lucide-vue-next'
import { computed } from 'vue'
import { useToasts } from '@/composables/useToasts'
import { cn } from '@/lib/cn'

const { toasts, dismiss } = useToasts()

const ICONS = {
  ok: CircleCheck,
  danger: CircleX,
  warn: TriangleAlert,
  info: Info,
  accent: Info,
  neutral: Info,
} as const

const SURFACE: Record<Tone, string> = {
  ok: 'text-ok',
  danger: 'text-danger',
  warn: 'text-warn',
  info: 'text-info',
  neutral: 'text-muted',
  accent: 'text-accent',
}

const items = computed(() => toasts.value)
</script>

<template>
  <div class="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(92vw,22rem)] flex-col gap-2" role="status" aria-live="polite">
    <TransitionGroup
      enter-active-class="transition duration-150 ease-out"
      enter-from-class="translate-x-2 opacity-0"
      leave-active-class="transition duration-100 ease-in"
      leave-to-class="translate-x-2 opacity-0"
    >
      <div
        v-for="toast in items"
        :key="toast.id"
        class="pointer-events-auto flex items-start gap-2.5 rounded-panel border border-line bg-raise p-3 shadow-float"
      >
        <component :is="ICONS[toast.tone]" :class="cn('mt-0.5 size-4 shrink-0', SURFACE[toast.tone])" />
        <div class="min-w-0 flex-1">
          <p class="text-xs font-medium text-ink">
            {{ toast.title }}
          </p>
          <p v-if="toast.description" class="mt-0.5 break-words text-2xs leading-4 text-muted">
            {{ toast.description }}
          </p>
        </div>
        <button
          type="button"
          class="-mr-1 -mt-0.5 grid size-6 shrink-0 place-items-center rounded-control text-faint transition-colors duration-150 hover:bg-hover hover:text-ink"
          aria-label="Dismiss"
          @click="dismiss(toast.id)"
        >
          <X class="size-3.5" />
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>
