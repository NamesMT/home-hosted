<script setup lang="ts">
import type { LogsForm } from '@/components/settings/settingsForm'
import { computed } from 'vue'
import { numberModel } from '@/components/settings/settingsForm'
import AppButton from '@/components/ui/AppButton.vue'
import CopyButton from '@/components/ui/CopyButton.vue'
import FieldGroup from '@/components/ui/FieldGroup.vue'
import NumberField from '@/components/ui/NumberField.vue'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'

const props = defineProps<{
  logsDir: string | null
  dirty: boolean
}>()

const emit = defineEmits<{ reset: [] }>()

const logs = defineModel<LogsForm>('logs', { required: true })

const maxBytes = numberModel(() => logs.value.maxBytes, value => (logs.value.maxBytes = value), 2_000_000)
const keep = numberModel(() => logs.value.keep, value => (logs.value.keep = value), 3)

const directory = computed(() => props.logsDir ?? '—')
</script>

<template>
  <FieldGroup
    title="Retention"
    description="The live view always comes from memory; these files survive a restart and feed the Logs page."
  >
    <template #actions>
      <AppButton size="xs" variant="ghost" :disabled="!props.dirty" @click="emit('reset')">
        Reset
      </AppButton>
    </template>

    <ToggleSwitch
      v-model="logs.persist"
      label="Keep logs on disk"
      hint="Turn off to hold everything in memory only."
      class="sm:col-span-2"
    />
    <NumberField v-model="maxBytes" label="Rotate at (bytes)" :min="10000" :max="100000000" hint="Per server, before rolling to .1, .2, …" />
    <NumberField v-model="keep" label="Keep rotated files" :min="1" :max="10" />

    <div class="flex min-w-0 flex-col gap-1 sm:col-span-2">
      <span class="text-xs font-medium text-muted">Logs directory</span>
      <div class="flex items-center gap-1.5 rounded-control border border-line bg-page/60 px-2.5 py-1.5">
        <span class="min-w-0 flex-1 truncate font-mono text-xs text-ink">{{ directory }}</span>
        <CopyButton :value="directory" label="Copy the logs directory" />
      </div>
      <p class="text-2xs leading-4 text-faint">
        Browse and download these files on the
        <RouterLink to="/logs" class="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent">
          Logs
        </RouterLink>
        page.
      </p>
    </div>
  </FieldGroup>
</template>
