<script setup lang="ts">
import type { JobRow } from '@shared/api-client'
import type { JobFieldKey } from '@/lib/jobForm'
import { computed, nextTick, ref, watch } from 'vue'
import JobFormField from '@/components/JobFormField.vue'
import { vFocusTrap } from '@/composables/useFocusTrap'
import { useModalLayer } from '@/composables/useModalLayer'
import { blankJobForm, JOB_FIELDS, JOB_FORM_LAYOUT, jobFormComplete, jobFormFrom, jobIdProblem, jobSecretNames } from '@/lib/jobForm'

/**
 * The console's job sheet: create one, or edit one.
 *
 * One sheet for both, chosen by `job`: the fields are the same ones, and a second form is how the two
 * drift apart. What it does *not* offer is a changed id — the id names the run's log file, its history
 * and its stored secret values — so an edit shows it as a read-only line with that reason, and the
 * way to a different id is to remove the job and declare it again.
 *
 * The sheet is a shell only: the fields and their grouping come from `@/lib/jobForm`, and its
 * `secret-values` slot is drawn by the block the layout anchors, so the value boxes land directly
 * under the names that declare them.
 */
const props = defineProps<{
  open: boolean
  /** The job being edited; `null` creates one. */
  job: JobRow | null
  busy?: boolean
  /** A refusal from the panel, shown inside the sheet where the offending field is. */
  error?: string | null
}>()

const emit = defineEmits<{ close: [], submit: [{ id: string, form: ReturnType<typeof blankJobForm>, mode: 'create' | 'edit' }] }>()

const mode = computed<'create' | 'edit'>(() => (props.job === null ? 'create' : 'edit'))
const form = ref(blankJobForm())
const id = ref('')
/** The sheet's own validation; the panel's refusal arrives as a prop. */
const localError = ref<string | null>(null)
const error = computed(() => props.error ?? localError.value)
const idField = ref<HTMLInputElement | null>(null)

/** The declared names, as the live draft — what the value block offers a box for. */
const declaredNames = computed(() => jobSecretNames(form.value.secretEnv))

/**
 * What the **stored** job declares. A name in the draft but not here is typed-not-saved, and the
 * value route refuses it, so the block says so rather than answering a 400.
 */
const savedNames = computed<string[]>(() => props.job?.secretEnv ?? [])

const canSubmit = computed(() => jobFormComplete(form.value, mode.value, id.value))

useModalLayer(() => props.open, () => emit('close'))

/**
 * Fill the form whenever the sheet opens **or its subject changes** — and on mount, because `open`
 * may already be true.
 *
 * Without `immediate` a sheet mounted open rendered a blank form: a watch only fires on a *change*,
 * and the flow that matters (a row's `edit` button) changes it. Without `job` in the source, a sheet
 * already open on one job kept that job's fields when it was pointed at another (or at nothing, to
 * create one) — which is how a save can land on the wrong job.
 */
watch(() => [props.open, props.job] as const, async ([open]) => {
  if (!open)
    return
  // Filled from the stored entry, never from the blank form: a sheet that opened on the defaults
  // would reset the cwd, the timeout and `enabled` on the first save.
  form.value = props.job === null ? blankJobForm() : jobFormFrom(props.job)
  id.value = props.job?.id ?? ''
  localError.value = null
  await nextTick()
  idField.value?.focus()
}, { immediate: true })

function update(key: JobFieldKey, value: string | boolean): void {
  form.value = { ...form.value, [key]: value }
}

function submit(): void {
  localError.value = null
  if (mode.value === 'create') {
    const problem = jobIdProblem(id.value)
    if (problem !== null) {
      localError.value = problem
      return
    }
  }
  if (canSubmit.value !== true) {
    localError.value = 'a command and a schedule are both required'
    return
  }
  // The id travels with the form: this is the one place it is known, and the caller keys the
  // create/patch on it. An edit never sends it to the panel, only uses it to address the route.
  emit('submit', { id: id.value.trim(), form: form.value, mode: mode.value })
}
</script>

<template>
  <div v-if="open" class="overlay" @click.self="emit('close')">
    <div
      v-focus-trap
      class="overlay__panel overlay__panel--sheet dialog"
      role="dialog"
      aria-modal="true"
      :aria-label="mode === 'create' ? 'new job' : `edit ${id}`"
    >
      <div class="overlay__head">
        <span class="overlay__title">{{ mode === 'create' ? 'new job' : `edit ${id}` }}</span>
        <span class="view__spacer" />
        <span class="faint">writes to jobs.config.json</span>
        <kbd class="kbd">esc</kbd>
      </div>

      <form class="sheet__form" @submit.prevent="submit">
        <div class="overlay__body stack">
          <!--
            The id, in both modes. Creating asks for it; editing shows it inert with the reason —
            it names this job's log, its history and its stored secret values, and a change would
            orphan all three under a name nothing points at.
          -->
          <label class="field grid__full">
            <span class="field__label">id</span>
            <input
              ref="idField"
              v-model="id"
              :disabled="mode === 'edit'"
              :required="mode === 'create'"
              placeholder="nightly-backup"
            >
            <span class="field__hint">
              {{ mode === 'edit'
                ? 'the id names this job’s log, history and secret values, so it cannot be changed — remove the job and declare it again under a new one'
                : 'lowercase letters, digits, - and _; it names this job’s log, history and secret values' }}
            </span>
          </label>

          <template v-for="(section, index) in JOB_FORM_LAYOUT" :key="index">
            <div v-if="section.container === 'group'" class="group">
              <div class="group__head">
                <span class="group__title">{{ section.title }}</span>
              </div>
              <div class="grid">
                <template v-for="key in section.fields" :key="key">
                  <JobFormField :spec="JOB_FIELDS[key]" :model-value="form[key]" @update:model-value="update(key, $event)" />
                  <slot
                    v-for="name in (section.slots ?? []).filter(slot => slot.after === key).map(slot => slot.name)"
                    :key="name"
                    :name="name"
                    :declared="declaredNames"
                    :saved-declared="savedNames"
                    :job-id="id"
                  />
                </template>
              </div>
            </div>
            <div v-else class="grid">
              <JobFormField v-for="key in section.fields" :key="key" :spec="JOB_FIELDS[key]" :model-value="form[key]" @update:model-value="update(key, $event)" />
            </div>
          </template>

          <p v-if="error" class="note note--error">
            {{ error }}
          </p>
        </div>

        <div class="group sheet__foot">
          <div class="actions">
            <button type="button" class="btn btn--sm" @click="emit('close')">
              cancel
            </button>
            <button type="submit" class="btn btn--sm btn--primary" :disabled="busy || !canSubmit">
              {{ mode === 'create' ? 'create job' : 'save' }}
            </button>
          </div>
        </div>
      </form>
    </div>
  </div>
</template>
