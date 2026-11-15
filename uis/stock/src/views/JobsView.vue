<script setup lang="ts">
import type { JobRow } from '@shared/api-client'
import { secondsToMsOr } from '@shared/ui-format'
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import JobLogModal from '@/components/job/JobLogModal.vue'
import JobSecretEnvBlock from '@/components/job/JobSecretEnvBlock.vue'
import ConfirmButton from '@/components/settings/ConfirmButton.vue'
import Notice from '@/components/settings/Notice.vue'
import AppButton from '@/components/ui/AppButton.vue'
import FieldGroup from '@/components/ui/FieldGroup.vue'
import Modal from '@/components/ui/Modal.vue'
import NumberField from '@/components/ui/NumberField.vue'
import TextAreaField from '@/components/ui/TextAreaField.vue'
import TextField from '@/components/ui/TextField.vue'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
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
 *
 * One sheet creates and edits, chosen by `mode` rather than by a second component: the fields are the
 * same ones, and a copy of them is how the two drift apart. **`id` is the one field the sheet cannot
 * change** — it names the log file, the run history and the secret store — so editing shows it
 * disabled with the reason, and the way to a new id is to remove the job and declare it again.
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

/** The job whose log sheet is open, by id; `null` while it is shut. */
const logFor = ref<string | null>(null)

/** Which sheet is open, and what it is doing: one Modal, two modes. */
const sheetOpen = ref(false)
const mode = ref<'create' | 'edit'>('create')
/** The job being edited, by id. `null` while creating. */
const editingId = ref<string | null>(null)

const form = ref<JobForm>(blankForm())

/** How long a new job may run: the schema's own default, in the seconds the box shows. */
const DEFAULT_TIMEOUT_SECONDS = 3600

/** What the sheet holds: the stored entry's fields, with the numeric and list boxes as text. */
interface JobForm {
  id: string
  label: string
  command: string
  args: string
  schedule: string
  cwd: string
  timeoutSeconds: number | null
  enabled: boolean
  /** The declared secret **names**, one per line. A value never enters this model. */
  secretEnv: string
}

function blankForm(): JobForm {
  return { id: '', label: '', command: '', args: '', schedule: '', cwd: '', timeoutSeconds: DEFAULT_TIMEOUT_SECONDS, enabled: true, secretEnv: '' }
}

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

function startCreate(): void {
  mode.value = 'create'
  editingId.value = null
  form.value = blankForm()
  error.value = null
  sheetOpen.value = true
}

/**
 * Open the sheet on an existing job.
 *
 * Everything the stored entry carries is filled in from **it**, not from the form defaults: a save
 * that sent the defaults would quietly reset a `cwd`, a timeout or an `enabled` the person never
 * touched. Its `secretEnv` names are sent whole, because the sheet draws them and the patch replaces
 * the list: a job's declaration is the consent for its values, so it has to be editable here.
 */
function startEdit(job: JobRow): void {
  mode.value = 'edit'
  editingId.value = job.id
  form.value = {
    id: job.id,
    label: job.label ?? '',
    command: job.command,
    args: job.args.join('\n'),
    schedule: job.schedule,
    cwd: job.cwd ?? '',
    timeoutSeconds: job.timeoutMs === undefined ? DEFAULT_TIMEOUT_SECONDS : Math.round(job.timeoutMs / 1000),
    enabled: job.enabled,
    secretEnv: (job.secretEnv ?? []).join('\n'),
  }
  error.value = null
  sheetOpen.value = true
}

/** The args box as the array the config stores: one argument per line, no shell parsing. */
function argsOf(text: string): string[] {
  return text.split('\n').map(line => line.trim()).filter(line => line.length > 0)
}

/** The declared secret names, deduplicated in the order they were typed. */
function secretEnvOf(text: string): string[] {
  return [...new Set(argsOf(text))]
}

/** The names the draft declares — the live list the value boxes are drawn from. */
const draftSecretNames = computed(() => secretEnvOf(form.value.secretEnv))
/** What the **stored** job declares: a name in the draft but not here cannot take a value yet. */
const savedSecretNames = computed<string[]>(() => (mode.value === 'edit' ? jobs.value.find(job => job.id === editingId.value)?.secretEnv ?? [] : []))
/** Which declared names have a stored value, from the row the panel last sent. */
const setSecretNames = computed<string[]>(() => (mode.value === 'edit' ? jobs.value.find(job => job.id === editingId.value)?.secretEnvSet ?? [] : []))

function labelOf(text: string): string | null {
  const trimmed = text.trim()
  return trimmed.length === 0 ? null : trimmed
}

function timeoutOf(): number {
  return secondsToMsOr(form.value.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS * 1000)
}

async function submit(): Promise<void> {
  busy.value = mode.value === 'create' ? 'new' : editingId.value
  error.value = null
  try {
    if (mode.value === 'create') {
      await api.createJob({
        id: form.value.id.trim(),
        command: form.value.command.trim(),
        args: argsOf(form.value.args),
        schedule: form.value.schedule.trim(),
        cwd: form.value.cwd.trim().length === 0 ? '.' : form.value.cwd.trim(),
        timeoutMs: timeoutOf(),
        enabled: form.value.enabled,
        secretEnv: secretEnvOf(form.value.secretEnv),
        ...(labelOf(form.value.label) === null ? {} : { label: labelOf(form.value.label) }),
      }, workspaceId.value)
    }
    else if (editingId.value !== null) {
      // The id is not in the patch: the route keys on it, and a changed id would orphan the log,
      // the history and the stored secret values under a name nothing points at any more.
      await api.updateJob(editingId.value, {
        label: labelOf(form.value.label),
        command: form.value.command.trim(),
        args: argsOf(form.value.args),
        schedule: form.value.schedule.trim(),
        cwd: form.value.cwd.trim().length === 0 ? '.' : form.value.cwd.trim(),
        timeoutMs: timeoutOf(),
        enabled: form.value.enabled,
        secretEnv: secretEnvOf(form.value.secretEnv),
      }, workspaceId.value)
    }
    sheetOpen.value = false
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

const canSubmit = computed(() => form.value.id.trim().length > 0 && form.value.command.trim().length > 0 && form.value.schedule.trim().length > 0)
const sheetTitle = computed(() => (mode.value === 'create' ? t('jobs.create') : t('jobs.editTitle', { id: editingId.value ?? '' })))
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
      <AppButton size="xs" variant="secondary" @click="startCreate">
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
              <AppButton size="xs" variant="ghost" :disabled="busy === job.id" @click="startEdit(job)">
                {{ t('common.edit') }}
              </AppButton>
              <!-- A failed run's own output is the one thing needed to debug it, so it is one click
                   from the row rather than buried behind a page of its own. -->
              <AppButton size="xs" variant="ghost" @click="logFor = job.id">
                {{ t('jobs.log') }}
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

    <!--
      `v-model:open`, like every other Modal in this UI. `:open` plus `@update:open` looked equivalent
      and was not: `Modal` is a `defineModel('open')`, so it emits `update:open` as it **opens** too,
      and the handler reset `creating` straight back to false. Measured: the sheet rendered in the
      closed state, and a successful create left it on screen with empty fields while the row it
      created was already in the table. The job was stored correctly the whole time; only the sheet
      lied. `test/shared/ui-modal-binding.test.ts` now holds every view to `v-model:open`.
    -->
    <Modal v-model:open="sheetOpen" :title="sheetTitle">
      <div class="flex flex-col gap-2">
        <!--
          One field the sheet cannot change: the id names this job's log, its history and its stored
          secret values. A change would orphan all three under a name nothing points at, so the box is
          disabled in edit mode and the reason is on the page rather than in a 400.
        -->
        <TextField
          v-model="form.id"
          :label="t('jobs.id')"
          placeholder="nightly-backup"
          :hint="t('jobs.idHint')"
          :disabled="mode === 'edit'"
        />
        <p v-if="mode === 'edit'" class="text-2xs leading-4 text-faint">
          {{ t('jobs.idImmutable') }}
        </p>
        <TextField v-model="form.label" :label="t('common.label')" />
        <TextField v-model="form.command" :label="t('common.command')" placeholder="node" />
        <TextField v-model="form.args" :label="t('jobs.args')" placeholder="backup.js" :hint="t('jobs.argsHint')" />
        <TextField v-model="form.schedule" :label="t('jobs.schedule')" placeholder="0 3 * * *" :hint="t('jobs.scheduleHint')" />
        <TextField v-model="form.cwd" :label="t('jobs.cwd')" placeholder="." />
        <NumberField
          v-model="form.timeoutSeconds"
          :label="t('jobs.timeout')"
          :min="1"
          :step="60"
          :hint="t('jobs.timeoutHint')"
        />
        <ToggleSwitch v-model="form.enabled" :label="t('common.enabled')" />
        <!--
          The secret names and their value boxes are **one group**, and the boxes come directly after
          the names that declare them — the same rule the server form keeps, and the reason
          `test/shared/secret-env-layout.test.ts` scans for the order as well as the presence. The
          block is fed the **live draft**, so a name appears the moment it is typed.
        -->
        <!--
          The group's title only: the block below states what it writes and that no value comes back,
          so a description here said the same thing twice, 20 px apart.
        -->
        <FieldGroup :title="t('jobs.secretGroup')" class="sm:col-span-2">
          <TextAreaField
            v-model="form.secretEnv"
            :label="t('jobs.secretEnv')"
            :hint="t('jobs.secretEnvHint')"
            :rows="2"
            placeholder="BACKUP_TOKEN"
            class="sm:col-span-2"
          />
          <JobSecretEnvBlock
            :job-id="editingId ?? ''"
            :declared="draftSecretNames"
            :saved-declared="savedSecretNames"
            :set-names="setSecretNames"
            @changed="refresh()"
          />
        </FieldGroup>
      </div>
      <template #footer>
        <AppButton size="sm" variant="ghost" @click="sheetOpen = false">
          {{ t('common.cancel') }}
        </AppButton>
        <AppButton size="sm" variant="primary" :loading="busy === 'new' || busy === editingId" :disabled="!canSubmit" @click="submit">
          {{ mode === 'create' ? t('jobs.create') : t('jobs.save') }}
        </AppButton>
      </template>
    </Modal>
    <JobLogModal
      :open="logFor !== null"
      :job-id="logFor ?? ''"
      :now="control.now.value"
      @update:open="(value: boolean) => { if (!value) logFor = null }"
    />
  </div>
</template>
