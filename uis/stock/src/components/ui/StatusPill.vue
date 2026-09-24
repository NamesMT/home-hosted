<script setup lang="ts">
import type { HealthState, ServerStatus } from '@shared/contracts'
import { computed } from 'vue'
import { cn } from '@/lib/cn'
import { HEALTH_META, STATUS_META, TONE_DOT, TONE_SURFACE } from '@/lib/status'

const props = withDefaults(defineProps<{
  status: ServerStatus
  health?: HealthState | null
  showHealth?: boolean
}>(), {
  health: null,
  showHealth: true,
})

const meta = computed(() => STATUS_META[props.status])
/** Health only earns its own chip when it disagrees with the lifecycle state. */
const healthMeta = computed(() => (props.health ? HEALTH_META[props.health] : null))
const showHealthChip = computed(() => props.showHealth
  && healthMeta.value !== null
  && props.health !== 'disabled'
  && props.health !== 'unknown'
  && (healthMeta.value.tone === 'danger' || healthMeta.value.tone === 'warn'))

const pulse = computed(() => meta.value.transitional)
</script>

<template>
  <span class="inline-flex flex-wrap items-center gap-1.5">
    <span
      :class="cn('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-2xs font-medium', TONE_SURFACE[meta.tone])"
    >
      <span class="relative flex size-1.5">
        <span v-if="pulse" class="absolute inset-0 rounded-full bg-current opacity-60" style="animation: hh-pulse-ring 1.6s ease-out infinite" />
        <span :class="cn('relative size-1.5 rounded-full', TONE_DOT[meta.tone])" />
      </span>
      {{ meta.label }}
    </span>
    <span
      v-if="showHealthChip && healthMeta"
      :class="cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-medium', TONE_SURFACE[healthMeta.tone])"
    >
      {{ healthMeta.label }}
    </span>
  </span>
</template>
