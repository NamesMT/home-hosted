<script setup lang="ts">
import { PopoverClose, PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui'
import { ref } from 'vue'
import AppButton from '@/components/ui/AppButton.vue'

/**
 * Asks the CA again for one route's certificate, behind an explicit confirmation.
 *
 * The engine is not restarted: the route briefly leaves the configuration so the
 * engine lets go of the certificate it fell back to, and the stored pair is dropped
 * while it is out. Every other route keeps serving, but the name itself is between
 * certificates for as long as the CA takes, so this still asks first.
 */
const props = withDefaults(defineProps<{
  host: string
  /** How long the engine takes to try the CA again by itself, e.g. "about 8 hours". */
  retryIn: string
  busy?: boolean
}>(), {
  busy: false,
})

const emit = defineEmits<{ confirm: [] }>()

const open = ref(false)

function confirm(): void {
  open.value = false
  emit('confirm')
}
</script>

<template>
  <PopoverRoot v-model:open="open">
    <PopoverTrigger as-child>
      <AppButton size="xs" variant="secondary" :loading="props.busy" :disabled="props.busy">
        Force retry certificate
      </AppButton>
    </PopoverTrigger>

    <PopoverPortal>
      <PopoverContent
        :side-offset="6"
        align="end"
        class="z-50 w-72 rounded-panel border border-line bg-raise p-3 shadow-float focus-visible:outline-none data-[state=open]:animate-[hh-fade-in_120ms_ease-out]"
      >
        <p class="text-xs font-semibold text-ink">
          Ask the CA again for {{ props.host }}?
        </p>
        <p class="mt-1 text-2xs leading-4 text-muted">
          The engine failed to obtain a CA certificate for this hostname previously and is using
          its local CA. It retries automatically every {{ props.retryIn }}.
        </p>
        <p class="mt-1 text-2xs leading-4 text-warn">
          Retrying now will kill this route and make it unavailable for a bit, are you sure to
          continue?
        </p>
        <div class="mt-2.5 flex justify-end gap-1.5">
          <PopoverClose as-child>
            <AppButton size="xs" variant="ghost">
              Leave it
            </AppButton>
          </PopoverClose>
          <AppButton size="xs" variant="primary" :loading="props.busy" @click="confirm">
            Retry now
          </AppButton>
        </div>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
