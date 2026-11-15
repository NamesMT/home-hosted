<script setup lang="ts">
import type { JobRow } from '@shared/api-client'
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import ConfirmButton from '@/components/settings/ConfirmButton.vue'
import Notice from '@/components/settings/Notice.vue'
import AppButton from '@/components/ui/AppButton.vue'
import Modal from '@/components/ui/Modal.vue'
import TextField from '@/components/ui/TextField.vue'
import { useControlPlane } from '@/composables/useControlPlane'
import { t } from '@/i18n'
import * as api from '@/lib/api'
import { relativeFrom } from '@/lib/format'

/**
 * The workspace's **jobs**: short-lived commands on cron schedules.
 *
 * This is the page that replaced the job half of Servers. What a job shows is what a job *is* — when
 * it next runs, whether a run is going, and how the last one ended — because a job has no port, no
 * uptime and no health probe to report instead. Its exit code is the outcome.
 *
 * The run button waits: the answer is the exit code, which is the one thing a person needs, and a
 * toast that said "started" would leave them believing a backup ran that did not.
 */
const route = useRoute()
// The shell's own tick, not `Date.now()` during render: a clock read in a template is a value that
// changes on every frame, which is what made this page re-render without ever settling.
const control = useControlPlane()
const workspaceId = computed(() => String(route.params.workspaceId ?? ''))

const jobs = ref<JobRow[]>([])
const loading = ref(true)
const error = ref<string | null>(null)
const busy = ref<string | null>(null)
/** The outcome of the last run this page started, kept visible beside the row that produced it. */
const outcome = ref<{ id: string, text: string, ok: boolean } | null>(null)

const creating = ref(false)
const form = ref({ id: '', command: '', args: '', schedule: '', label: '' })

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
    outcome.value = {
      id,
      ok: result.ok,
      text: result.cancelled === true
        ? t('jobs.stopped')
        : result.ok
          ? t('jobs.exitedOk')
          : t('jobs.exitedFailed', { code: result.exitCode ?? '?' }),
    }
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
    await api.updateJob(job.id, { enabled: !job.enabled }, workspaceId.value)
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
    await api.deleteJob(job.id, workspaceId.value)
    await refresh()
  }
  catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  }
  finally {
    busy.value = null
  }
}

async function create(): Promise<void> {
  busy.value = 'new'
  error.value = null
  try {
    await api.createJob({
      id: form.value.id.trim(),
      command: form.value.command.trim(),
      args: form.value.args.split('\n').map(line => line.trim()).filter(line => line.length > 0),
      schedule: form.value.schedule.trim(),
      ...(form.value.label.trim().length === 0 ? {} : { label: form.value.label.trim() }),
    }, workspaceId.value)
    creating.value = false
    form.value = { id: '', command: '', args: '', schedule: '', label: '' }
    await refresh()
  }
  catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  }
  finally {
    busy.value = null
  }
}

/**
 * When an instant is, relative to now — through the app's **cached** formatter.
 *
 * This used to build a fresh `Intl.RelativeTimeFormat` per call, per row, inside the render: that is
 * the most expensive `Intl` constructor there is, and calling it for every cell of every row locked
 * the renderer hard enough that the whole page stopped answering. `relativeFrom` builds one per
 * locale and reuses it, and takes `now` from the tick the shell already drives rather than reading
 * the clock during render — which is what made the output change on every frame.
 */
function when(ms: number | null | undefined, now: number): string {
  if (ms === null || ms === undefined)
    return t('jobs.noNextRun')
  return relativeFrom(ms, now)
}

function lastRun(job: JobRow, now: number): string {
  if (job.lastRunAt === undefined)
    return t('jobs.neverRan')
  return relativeFrom(job.lastRunAt, now)
}

const canCreate = computed(() => form.value.id.trim().length > 0 && form.value.command.trim().length > 0 && form.value.schedule.trim().length > 0)
</script>

<template>
  <div class="mx-auto max-w-7xl space-y-4 p-4 sm:p-5">
    <div class="flex items-start justify-between gap-3">
      <div>
        <h1 class="text-sm font-semibold text-ink">
          {{ t('jobs.title') }}
        </h1>
        <p class="mt-0.5 text-2xs text-muted">
          {{ t('jobs.subtitle') }}
        </p>
      </div>
      <AppButton size="xs" variant="secondary" @click="creating = true">
        {{ t('jobs.create') }}
      </AppButton>
    </div>

    <Notice v-if="outcome !== null" :tone="outcome.ok ? 'info' : 'warn'" :title="t('jobs.lastOutcome')">
      <p class="text-2xs">
        <span class="font-mono">{{ outcome.id }}</span> — {{ outcome.text }}
      </p>
    </Notice>

    <p v-if="error" class="text-2xs text-danger">
      {{ error }}
    </p>

    <p v-if="loading" class="text-xs text-muted">
      {{ t('common.loading') }}
    </p>
    <p v-else-if="jobs.length === 0" class="text-xs text-muted">
      {{ t('jobs.empty') }}
    </p>
    <table v-else class="w-full text-left text-xs">
      <thead>
        <tr class="border-b border-line-soft text-2xs text-faint">
          <th class="py-1.5 pr-2 font-medium">
            {{ t('jobs.id') }}
          </th>
          <th class="py-1.5 pr-2 font-medium">
            {{ t('jobs.schedule') }}
          </th>
          <th class="py-1.5 pr-2 font-medium">
            {{ t('jobs.next') }}
          </th>
          <th class="py-1.5 pr-2 font-medium">
            {{ t('jobs.last') }}
          </th>
          <th class="py-1.5 font-medium">
            <span class="sr-only">{{ t('jobs.actions') }}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="job in jobs" :key="job.id" class="border-b border-line-soft/60">
          <td class="py-1.5 pr-2">
            <span class="font-mono">{{ job.id }}</span>
            <span v-if="job.label !== undefined" class="ml-1.5 text-faint">{{ job.label }}</span>
            <span v-if="!job.enabled" class="ml-1.5 rounded-full bg-line px-1.5 py-px text-2xs text-muted">
              {{ t('jobs.disabled') }}
            </span>
            <p class="font-mono text-2xs text-faint">
              {{ [job.command, ...job.args].join(' ') }}
            </p>
          </td>
          <td class="py-1.5 pr-2 font-mono text-2xs">
            {{ job.schedule }}
          </td>
          <td class="py-1.5 pr-2 text-2xs">
            {{ job.running ? t('jobs.running') : when(job.nextRunAt, control.now.value) }}
          </td>
          <td class="py-1.5 pr-2 text-2xs text-faint">
            {{ lastRun(job, control.now.value) }}
            <span v-if="job.lastExitCode !== undefined && job.lastExitCode !== null" class="ml-1" :class="job.lastExitCode === 0 ? 'text-ok' : 'text-danger'">
              {{ t('jobs.exitCode', { code: job.lastExitCode }) }}
            </span>
          </td>
          <td class="py-1.5 text-right">
            <div class="flex justify-end gap-1">
              <AppButton size="xs" variant="primary" :loading="busy === job.id" :disabled="job.running" @click="run(job.id)">
                {{ job.running ? t('jobs.running') : t('jobs.runNow') }}
              </AppButton>
              <ConfirmButton
                v-if="job.enabled"
                :label="t('jobs.disable')"
                :confirm-label="t('jobs.disable')"
                :title="t('jobs.disableTitle')"
                :hint="t('jobs.disableHint')"
                variant="ghost"
                size="xs"
                @confirm="toggle(job)"
              />
              <AppButton v-else size="xs" variant="ghost" @click="toggle(job)">
                {{ t('jobs.enable') }}
              </AppButton>
              <ConfirmButton
                :label="t('jobs.remove')"
                :confirm-label="t('jobs.remove')"
                :title="t('jobs.removeTitle')"
                :hint="t('jobs.removeHint')"
                variant="ghost"
                size="xs"
                @confirm="remove(job)"
              />
            </div>
          </td>
        </tr>
      </tbody>
    </table>

    <Modal :open="creating" :title="t('jobs.create')" @update:open="creating = false">
      <div class="flex flex-col gap-2">
        <TextField v-model="form.id" :label="t('jobs.id')" placeholder="nightly-backup" :hint="t('jobs.idHint')" />
        <TextField v-model="form.label" :label="t('common.label')" />
        <TextField v-model="form.command" :label="t('common.command')" placeholder="node" />
        <TextField v-model="form.args" :label="t('jobs.args')" placeholder="backup.js" :hint="t('jobs.argsHint')" />
        <TextField v-model="form.schedule" :label="t('jobs.schedule')" placeholder="0 3 * * *" :hint="t('jobs.scheduleHint')" />
      </div>
      <template #footer>
        <AppButton size="sm" variant="ghost" @click="creating = false">
          {{ t('common.cancel') }}
        </AppButton>
        <AppButton size="sm" variant="primary" :loading="busy === 'new'" :disabled="!canCreate" @click="create">
          {{ t('jobs.create') }}
        </AppButton>
      </template>
    </Modal>
  </div>
</template>
