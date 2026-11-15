<script setup lang="ts">
import type { LogLine } from '@shared/contracts'
import { computed, ref, watch } from 'vue'
import AppButton from '@/components/ui/AppButton.vue'
import Modal from '@/components/ui/Modal.vue'
import { t } from '@/i18n'
import * as api from '@/lib/api'
import { formatBytes, formatClockMs } from '@/lib/format'

/**
 * One job's own log, in a sheet.
 *
 * A run's output went to the panel log at DEBUG, which nobody enables — so a failed backup's own
 * output, the one thing a person debugging it needs, was readable nowhere. The service writes it to a
 * JSONL file per job id now, and this is the page's way in: the same lines, the same stream filter,
 * through the same route shape a server's log has.
 *
 * Fetched, not streamed. A job is run-to-completion: there is no live tail to follow, and the run
 * that just ended is what a person opened this to read. The refresh button is honest about that —
 * it re-reads the file rather than pretending to push.
 */
const props = withDefaults(defineProps<{
  open: boolean
  jobId: string
  /** The run this page started, so a line's time reads against a known instant. */
  now?: number
}>(), { now: undefined })

const emit = defineEmits<{ 'update:open': [value: boolean] }>()

const open = computed({
  get: () => props.open,
  set: (value: boolean) => emit('update:open', value),
})

const lines = ref<LogLine[]>([])
const enabled = ref(true)
const sizeBytes = ref(0)
const loading = ref(false)
const error = ref<string | null>(null)
/** `all` sends no filter: the route reads an empty string as a filter matching nothing. */
const stream = ref<'all' | 'stdout' | 'stderr' | 'system'>('all')

async function load(): Promise<void> {
  if (props.jobId.length === 0)
    return
  loading.value = true
  error.value = null
  try {
    const answer = await api.fetchJobLog(props.jobId, {
      tail: 500,
      ...(stream.value === 'all' ? {} : { stream: stream.value }),
    })
    lines.value = answer.lines
    enabled.value = answer.enabled
    sizeBytes.value = answer.sizeBytes
  }
  catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  }
  finally {
    loading.value = false
  }
}

/**
 * Re-read whenever the sheet opens, and whenever the job changes under it.
 *
 * Reading on open rather than on mount: the sheet is a `v-if` on the caller's open flag in practice,
 * but a `Modal` stays mounted while it animates closed, so a mount-time read would leave the next
 * open showing the previous run.
 */
watch(() => [props.open, props.jobId] as const, ([isOpen]) => {
  if (isOpen)
    void load()
}, { immediate: true })

watch(stream, () => {
  if (props.open)
    void load()
})
</script>

<template>
  <Modal v-model:open="open" :title="t('jobs.logTitle', { id: props.jobId })" :description="t('jobs.logDescription')" width="w-[min(94vw,60rem)]">
    <div class="flex flex-col gap-2">
      <div class="flex flex-wrap items-center gap-2">
        <AppButton size="xs" variant="ghost" :loading="loading" @click="load">
          {{ t('jobs.logRefresh') }}
        </AppButton>
        <select
          v-model="stream"
          class="rounded-control border border-line bg-page/60 px-2 py-1 text-2xs text-ink"
          :aria-label="t('jobs.logStream')"
        >
          <option value="all">
            {{ t('jobs.logAllStreams') }}
          </option>
          <option value="stdout">
            {{ t('logs.streamOut') }}
          </option>
          <option value="stderr">
            {{ t('logs.streamErr') }}
          </option>
          <option value="system">
            {{ t('jobs.logSystem') }}
          </option>
        </select>
        <span class="text-2xs text-faint">{{ t('jobs.logSize', { size: formatBytes(sizeBytes) }) }}</span>
        <span class="ml-auto text-2xs text-faint">{{ t('jobs.logLines', { count: lines.length }) }}</span>
      </div>

      <!-- `logs.persist` off means the panel keeps nothing, which is not the same as "it printed nothing". -->
      <p v-if="!enabled" class="text-2xs leading-4 text-warn">
        {{ t('jobs.logDisabled') }}
      </p>
      <p v-if="error" class="text-2xs leading-4 text-danger">
        {{ error }}
      </p>
      <!--
        A filtered view that comes back empty is not "this job never ran": saying so would send a
        person looking for a missing run when the answer is their own filter, so the two are told
        apart. The size readout above still says the file has bytes in it.
      -->
      <p v-else-if="!loading && lines.length === 0 && stream !== 'all'" class="text-2xs leading-4 text-faint">
        {{ t('jobs.logNoMatch') }}
      </p>
      <p v-else-if="!loading && lines.length === 0" class="text-2xs leading-4 text-faint">
        {{ t('jobs.logEmpty') }}
      </p>
      <ol v-else class="max-h-[60dvh] overflow-y-auto rounded-control border border-line bg-page/60 p-2 font-mono text-2xs leading-4">
        <li v-for="(line, index) in lines" :key="`${line.ts}-${index}`" class="flex gap-2 whitespace-pre-wrap break-all">
          <span class="shrink-0 text-faint">{{ formatClockMs(line.ts) }}</span>
          <span class="shrink-0" :class="line.stream === 'stderr' ? 'text-danger' : line.stream === 'system' ? 'text-accent' : 'text-muted'">{{ line.stream }}</span>
          <span class="min-w-0 text-ink">{{ line.text }}</span>
        </li>
      </ol>
    </div>
    <template #footer>
      <AppButton size="sm" variant="ghost" @click="open = false">
        {{ t('common.close') }}
      </AppButton>
    </template>
  </Modal>
</template>
