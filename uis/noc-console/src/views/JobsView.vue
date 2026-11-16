<script setup lang="ts">
import type { JobRow } from '@shared/api-client'
import type { JobForm } from '@/lib/jobForm'
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import ConfirmButton from '@/components/ConfirmButton.vue'
import JobLogSheet from '@/components/JobLogSheet.vue'
import JobSecretEnvBlock from '@/components/JobSecretEnvBlock.vue'
import JobSheet from '@/components/JobSheet.vue'
import { flash } from '@/composables/useUi'
import * as api from '@/lib/api'
import { jobCreateBody, jobFormPayload } from '@/lib/jobForm'

/**
 * The workspace's jobs: short-lived commands on cron schedules.
 *
 * This is the console's half of the split that took jobs out of Servers. A row shows what a job *is* —
 * its expression, when it next runs, whether a run is in flight, and how the last one ended — because
 * a job has no port, no uptime and no probe to report instead. Its exit code is the outcome.
 *
 * One sheet declares a job and edits it (`JobSheet`, its fields from `@/lib/jobForm`). The per-job
 * secret **values** are drawn by that sheet too, through the `secret-values` slot the layout anchors
 * directly under the names that declare them — the same place the stock UI puts them, and the
 * reason `FormSection.slots` exists at all.
 */
const route = useRoute()
const workspaceId = computed(() => String(route.params.workspaceId ?? ''))

const jobs = ref<JobRow[]>([])
const loading = ref(true)
const error = ref<string | null>(null)
const busy = ref<string | null>(null)
const outcome = ref<string | null>(null)

/** The sheet: open, and the id of the job it edits (`null` creates one). */
const sheetOpen = ref(false)
const editingId = ref<string | null>(null)
const saving = ref(false)
/**
 * The job being edited, read from the **list** rather than held as its own object.
 *
 * A `ref<JobRow>` copied at open time went stale the moment anything re-read the list — a secret
 * value written from the sheet's own block left the name marked "not set" with its confirmation
 * beside it, because the copy still said what the job looked like before the write. Deriving it
 * means every refresh updates the sheet with it.
 */
const editing = computed<JobRow | null>(() => jobs.value.find(job => job.id === editingId.value) ?? null)
/** The panel's refusal, shown *in* the sheet rather than behind it. */
const sheetError = ref<string | null>(null)
/** The job whose log sheet is open, by id; `null` while it is shut. */
const logFor = ref<string | null>(null)

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
    const result = await api.runJob(id)
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
    await api.stopJob(id)
    await refresh()
  }
  catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  }
  finally {
    busy.value = null
  }
}

async function toggle(job: JobRow): Promise<void> {
  busy.value = job.id
  try {
    await api.updateJob(job.id, { enabled: !job.enabled })
    await refresh()
  }
  catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  }
  finally {
    busy.value = null
  }
}

async function remove(job: JobRow): Promise<void> {
  busy.value = job.id
  try {
    await api.deleteJob(job.id)
    await refresh()
  }
  catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  }
  finally {
    busy.value = null
  }
}

function startCreate(): void {
  editingId.value = null
  sheetError.value = null
  sheetOpen.value = true
}

function startEdit(job: JobRow): void {
  editingId.value = job.id
  sheetError.value = null
  sheetOpen.value = true
}

/**
 * Create or patch, from the one sheet.
 *
 * Create posts the whole entry; edit sends the same fields as a patch and **never** the id — the route
 * keys on it, and a changed one would orphan the job's log, history and secret values. A refusal is
 * shown inside the sheet, where the offending field is, rather than on the page behind it.
 */
async function submit({ id, form, mode }: { id: string, form: JobForm, mode: 'create' | 'edit' }): Promise<void> {
  saving.value = true
  sheetError.value = null
  const payload = jobFormPayload(form)
  try {
    if (mode === 'create') {
      await api.createJob(jobCreateBody(id, form))
      flash(`added ${id}`)
      sheetOpen.value = false
      // Stay on the entry just created, so its row is visibly there and its secret values are one
      // click away — the panel cannot store a value before the job exists.
      editingId.value = id
    }
    else if (editingId.value !== null) {
      await api.updateJob(editingId.value, payload)
      flash(`${editingId.value} saved`)
      sheetOpen.value = false
    }
    await refresh()
  }
  catch (caught) {
    sheetError.value = caught instanceof Error ? caught.message : String(caught)
  }
  finally {
    saving.value = false
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
      <span class="view__spacer" />
      <button type="button" class="btn btn--sm btn--primary" @click="startCreate">
        new job
      </button>
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
      no jobs in this workspace — declare one from jobs.config.json, or with `new job` above
    </p>
    <table v-else class="tbl">
      <thead>
        <tr>
          <th class="tbl__keep">
            id
          </th>
          <th>schedule</th>
          <th>next</th>
          <th>last</th>
          <th class="tbl__actions">
            <span class="sr-only">actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="job in jobs" :key="job.id">
          <td class="tbl__keep">
            <span class="mono">{{ job.id }}</span>
            <span v-if="job.label" class="faint label">{{ job.label }}</span>
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
          <td class="tbl__actions">
            <span class="actions">
              <button type="button" class="btn btn--sm btn--primary" :disabled="busy === job.id || job.running" @click="run(job.id)">
                {{ job.running ? 'running' : 'run now' }}
              </button>
              <button v-if="job.running" type="button" class="btn btn--sm" :disabled="busy === job.id" @click="stop(job.id)">
                stop
              </button>
              <button type="button" class="btn btn--sm" :disabled="busy === job.id" @click="startEdit(job)">
                edit
              </button>
              <!-- A failed run's own output is the one thing needed to debug it, so it is one click
                 from the row rather than buried behind a page of its own. -->
              <button type="button" class="btn btn--sm" @click="logFor = job.id">
                log
              </button>
              <!--
              Disabling confirms; enabling does not. Turning a job off stops the schedule that
              exists to run it, which is the kind of thing a stray click should not do. Enabling
              only restores what the config already declared, so it happens on the click.
            -->
              <ConfirmButton
                v-if="job.enabled"
                label="disable"
                confirm-label="confirm disable"
                :disabled="busy === job.id"
                :title="`Disable ${job.id}?`"
                hint="It stops running on its schedule until you enable it again. A run in flight still finishes."
                @confirm="toggle(job)"
              />
              <button v-else type="button" class="btn btn--sm" :disabled="busy === job.id" @click="toggle(job)">
                enable
              </button>
              <ConfirmButton
                label="remove"
                confirm-label="confirm remove"
                tone="danger"
                :disabled="busy === job.id"
                :title="`Remove ${job.id}?`"
                hint="The declaration goes, along with its schedule. Output already written to the job's log stays."
                @confirm="remove(job)"
              />
            </span>
          </td>
        </tr>
      </tbody>
    </table>

    <JobSheet
      v-model:open="sheetOpen"
      :job="editing"
      :busy="saving"
      :error="sheetError"
      @close="sheetOpen = false"
      @submit="submit"
    >
      <template #secret-values="{ declared, savedDeclared, jobId }">
        <JobSecretEnvBlock
          :job-id="jobId"
          :declared="declared"
          :saved-declared="savedDeclared"
          :set-names="editing?.secretEnvSet ?? []"
          @changed="refresh()"
        />
      </template>
    </JobSheet>

    <JobLogSheet
      :open="logFor !== null"
      :job-id="logFor ?? ''"
      @close="logFor = null"
    />
  </div>
</template>
