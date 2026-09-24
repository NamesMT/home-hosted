<script setup lang="ts">
import type { ControlView } from '@shared/contracts'
import { CircleAlert, TriangleAlert } from 'lucide-vue-next'
import { computed } from 'vue'

const props = defineProps<{
  control: ControlView | null
  configError: string | null
  configPath: string | undefined
}>()

interface Notice {
  id: string
  tone: 'warn' | 'danger' | 'info'
  text: string
  hint?: string
}

const notices = computed<Notice[]>(() => {
  const out: Notice[] = []
  const auth = props.control?.auth

  if (props.configError) {
    out.push({
      id: 'config',
      tone: 'danger',
      text: `The config could not be read: ${props.configError}`,
      hint: `Fix ${props.configPath ?? 'servers.config.json'} and restart the panel.`,
    })
  }

  if (auth) {
    if (auth.blockedReason) {
      out.push({ id: 'blocked', tone: 'danger', text: auth.blockedReason })
    }
    if (auth.usingDefaultPassword) {
      out.push({
        id: 'default-password',
        tone: 'warn',
        text: 'This panel is still on its default password.',
        hint: 'Change it in Settings — binding beyond 127.0.0.1 stays refused until you do.',
      })
    }
    else if (auth.enabled && !auth.passwordSet) {
      out.push({
        id: 'no-password',
        tone: 'warn',
        text: 'Authentication is on but no password is set, so nothing is being asked for.',
        hint: 'Set one in Settings to actually lock the panel.',
      })
    }
    if (auth.exposed) {
      out.push({
        id: 'exposed',
        tone: 'warn',
        text: 'This panel is reachable beyond 127.0.0.1.',
        hint: 'Keep the password strong, or put a TLS-terminating proxy in front of it.',
      })
    }
    if (!auth.enabled && !auth.exposed) {
      out.push({
        id: 'auth-off',
        tone: 'info',
        text: 'Authentication is disabled — the panel is only protected by its loopback bind.',
      })
    }
  }

  return out
})

const TONE = {
  warn: { wrap: 'border-warn/25 bg-warn-soft text-warn', icon: TriangleAlert },
  danger: { wrap: 'border-danger/25 bg-danger-soft text-danger', icon: CircleAlert },
  info: { wrap: 'border-line bg-panel-2 text-muted', icon: CircleAlert },
} as const
</script>

<template>
  <div v-if="notices.length > 0" class="flex flex-col gap-px border-b border-line bg-panel/60">
    <div
      v-for="notice in notices"
      :key="notice.id"
      class="flex items-start gap-2 px-3 py-1.5 sm:px-4"
      :class="TONE[notice.tone].wrap"
    >
      <component :is="TONE[notice.tone].icon" class="mt-0.5 size-3.5 shrink-0" />
      <p class="text-2xs leading-4">
        <span class="font-medium">{{ notice.text }}</span>
        <span v-if="notice.hint" class="opacity-80"> {{ notice.hint }}</span>
      </p>
    </div>
  </div>
</template>
