import type { Tone } from '@/lib/status'
import { readonly, ref } from 'vue'

export interface Toast {
  id: number
  tone: Tone
  title: string
  description?: string
}

const toasts = ref<Toast[]>([])
let nextId = 1

function dismiss(id: number): void {
  toasts.value = toasts.value.filter(toast => toast.id !== id)
}

function push(input: Omit<Toast, 'id'>, ttlMs = 4800): number {
  const id = nextId++
  toasts.value = [...toasts.value, { ...input, id }]
  if (ttlMs > 0)
    setTimeout(dismiss, ttlMs, id)
  return id
}

/** Transient results of an action; failures stay long enough to be read. */
export function useToasts() {
  return {
    toasts: readonly(toasts),
    dismiss,
    push,
    success: (title: string, description?: string): number => push({ tone: 'ok', title, description }),
    failure: (title: string, description?: string): number => push({ tone: 'danger', title, description }, 9000),
    info: (title: string, description?: string): number => push({ tone: 'info', title, description }),
    warn: (title: string, description?: string): number => push({ tone: 'warn', title, description }, 7000),
  }
}
