<script setup lang="ts">
import type { Component } from 'vue'
import type { Tone } from '@/lib/status'
import { AlertTriangle, CheckCircle2, Info, OctagonAlert, ShieldAlert } from 'lucide-vue-next'
import { computed } from 'vue'
import { cn } from '@/lib/cn'
import { TONE_SURFACE } from '@/lib/status'

const props = withDefaults(defineProps<{
  tone?: Tone
  title?: string
  class?: string
}>(), {
  tone: 'info',
  title: undefined,
  class: undefined,
})

const ICONS: Record<Tone, Component> = {
  ok: CheckCircle2,
  warn: AlertTriangle,
  danger: OctagonAlert,
  info: Info,
  neutral: Info,
  accent: ShieldAlert,
}

const icon = computed(() => ICONS[props.tone])
</script>

<template>
  <div :class="cn('flex items-start gap-2 rounded-panel border px-3 py-2', TONE_SURFACE[props.tone], props.class)">
    <component :is="icon" class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
    <div class="min-w-0 flex-1">
      <p v-if="props.title" class="text-xs font-semibold">
        {{ props.title }}
      </p>
      <div :class="cn('text-xs leading-relaxed text-ink/85', props.title && 'mt-0.5')">
        <slot />
      </div>
    </div>
  </div>
</template>
