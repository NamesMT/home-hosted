<script setup lang="ts">
import type { JobRow } from '@shared/api-client'
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import * as api from '@/lib/api'

/**
 * The workspace's jobs: short-lived commands on cron schedules.
 *
 * This is the console's half of the split that took jobs out of Servers. A row shows what a job *is* —
 * its expression, when it next runs, whether a run is in flight, and how the last one ended — because
 * a job has no port, no uptime and no probe to report instead. Its exit code is the outcome.
 */
const route = useRoute()
const workspaceId = computed(() => String(route.params.workspaceId ?? ''))

const jobs = ref<JobRow[]>([])
const loading = ref(true)
const error = ref<string | null>(null)
const busy = ref<string | null>(null)
const outcome = ref<string | null>(null)

async function refresh(): Promise<void> {
  loading.value = true
  try {
    jobs.value = (await api.listJobs(workspaceId.value)).jobs
    error.value = null
  }
  catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  }
  finally {
    loading.value = false
  }
}

onMounted(refresh)

async function run(id: string): Promise<void> {
  busy.value = id
  outcome.value = null
  try {
    const result = await api.runJob(id, workspaceId.value)
    // The exit code is the answer, so it is shown rather than toasted.
    outcome.value = result.cancelled === true
      ? `${id}: stopped`
      : `${id}: exit ${result.exitCode ?? '?'}`
    await refresh()
  }
  catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  }
  finally {
    busy.value = null
  }
}

async function stop(id: string): Promise<void> {
  busy.value = id
  try {
    await api.stopJob(id, workspaceId.value)
    await refresh()
  }
  catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  }
  finally {
    busy.value = null
  }
}

/** `Intl.RelativeTimeFormat`, never a hand-assembled "in 4h". */
function when(ms: number | null | undefined): string {
  if (ms === null || ms === undefined)
    return '—'
  const delta = ms - Date.now()
  const minutes = Math.round(delta / 60_000)
  if (Math.abs(minutes) < 60)
    return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 48)
    return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(hours, 'hour')
  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(Math.round(hours / 24), 'day')
}
</script>

<template>
  <div class="view">
    <div class="view__head">
      <span class="view__title">jobs</span>
      <span class="view__count">short-lived commands on a schedule — the exit code is the outcome</span>
    </div>

    <p v-if="outcome" class="note">
      {{ outcome }}
    </p>
    <p v-if="error" class="note note--error">
      {{ error }}
    </p>
    <p v-if="loading" class="faint">
      loading…
    </p>
    <p v-else-if="jobs.length === 0" class="faint">
      no jobs in this workspace
    </p>
    <table v-else class="tbl">
      <thead>
        <tr>
          <th>id</th>
          <th>schedule</th>
          <th>next</th>
          <th>last</th>
          <th><span class="sr-only">actions</span></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="job in jobs" :key="job.id">
          <td>
            <span class="mono">{{ job.id }}</span>
            <span v-if="job.label" class="faint"> {{ job.label }}</span>
            <span v-if="!job.enabled" class="chip">disabled</span>
            <p class="faint mono" style="font-size: 11px">
              {{ [job.command, ...job.args].join(' ') }}
            </p>
          </td>
          <td class="mono">
            {{ job.schedule }}
          </td>
          <td>{{ job.running ? 'running' : when(job.nextRunAt) }}</td>
          <td class="faint">
            {{ job.lastRunAt === undefined ? 'never ran' : when(job.lastRunAt) }}
            <span v-if="job.lastExitCode !== undefined && job.lastExitCode !== null">
              · exit {{ job.lastExitCode }}
            </span>
          </td>
          <td class="actions">
            <button type="button" class="btn btn--sm btn--primary" :disabled="busy === job.id || job.running" @click="run(job.id)">
              {{ job.running ? 'running' : 'run now' }}
            </button>
            <button v-if="job.running" type="button" class="btn btn--sm" :disabled="busy === job.id" @click="stop(job.id)">
              stop
            </button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
