<script setup lang="ts">
import type { LogLine } from '@shared/contracts'
import { computed, ref, watch } from 'vue'
import LogPane from '@/components/LogPane.vue'
import { vFocusTrap } from '@/composables/useFocusTrap'
import { useModalLayer } from '@/composables/useModalLayer'
import * as api from '@/lib/api'

/**
 * One job's own log, in the console's own sheet.
 *
 * A run's output went to the panel log at DEBUG, which nobody enables, so a failed backup's own output
 * was readable nowhere. The service writes it to a JSONL file per job id now, and this is the console's
 * way in — the same lines and the same stream filter through the same route shape a server's log has,
 * drawn by the same `LogPane` the server drawer uses.
 */
const props = defineProps<{
  open: boolean
  jobId: string
}>()

const emit = defineEmits<{ close: [] }>()

const lines = ref<LogLine[]>([])
const enabled = ref(true)
const loading = ref(false)
const error = ref<string | null>(null)
const search = ref('')
/** `all` sends no filter: the route reads an empty string as a filter matching nothing. */
const stream = ref<'all' | 'stdout' | 'stderr' | 'system'>('all')

useModalLayer(() => props.open, () => emit('close'))

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
  }
  catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  }
  finally {
    loading.value = false
  }
}

/** Re-read on every open, and when the sheet is pointed at another job or its filter changes. */
watch(stream, () => {
  if (props.open)
    void load()
})

/** Re-read on every open, and when the sheet is pointed at another job. */
watch(() => [props.open, props.jobId] as const, ([isOpen]) => {
  if (isOpen)
    void load()
}, { immediate: true })

const counts = computed(() => ({
  total: lines.value.length,
  errors: lines.value.filter(line => line.stream === 'stderr').length,
}))
</script>

<template>
  <div v-if="open" class="overlay" @click.self="emit('close')">
    <div v-focus-trap class="overlay__panel overlay__panel--sheet overlay__panel--wide" role="dialog" aria-modal="true" :aria-label="`log ${jobId}`">
      <div class="overlay__head">
        <span class="overlay__title">log · {{ jobId }}</span>
        <span class="view__spacer" />
        <span class="faint">{{ counts.total }} ln · {{ counts.errors }} err</span>
        <button type="button" class="btn btn--xs btn--ghost" :disabled="loading" @click="load">
          refresh
        </button>
        <kbd class="kbd">esc</kbd>
      </div>

      <form class="sheet__form" @submit.prevent>
        <div class="overlay__body stack">
          <p class="faint" style="font-size: 11px">
            what this job’s runs wrote to its own log file — one JSONL file per job id, rotated by size
          </p>
          <!-- `logs.persist` off means the panel keeps nothing, which is not "it printed nothing". -->
          <p v-if="!enabled" class="note note--warn">
            the panel keeps no job logs — enable “persist” in the workspace log settings, or read the panel log
          </p>
          <p v-if="error" class="note note--error">
            {{ error }}
          </p>
          <div class="row">
            <input v-model="search" placeholder="search the output…" aria-label="search the output">
            <select v-model="stream" aria-label="stream filter">
              <option value="all">
                all streams
              </option>
              <option value="stdout">
                out
              </option>
              <option value="stderr">
                err
              </option>
              <option value="system">
                system
              </option>
            </select>
          </div>

          <!--
            A filtered view that comes back empty is not "this job never ran": saying so sends a person
            looking for a missing run when the answer is their own filter.
          -->
          <LogPane
            :lines="lines"
            :search="search"
            :max="2000"
            :empty="loading
              ? 'reading…'
              : stream === 'all'
                ? 'no output yet — this job has not run since it was declared'
                : 'no lines match this filter — clear it to see every stream'"
          />
        </div>

        <div class="group sheet__foot">
          <div class="actions">
            <button type="button" class="btn btn--sm" @click="emit('close')">
              close
            </button>
          </div>
        </div>
      </form>
    </div>
  </div>
</template>
