<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import ConfirmButton from '@/components/ConfirmButton.vue'
import * as api from '@/lib/api'

/**
 * A **job's** secret values: the names that have one, and a masked box to set or clear each.
 *
 * The same block `@/components/SecretEnvBlock.vue` draws for a server, against the job's own
 * write-only route. It is a second component rather than a prop on the first because the two write
 * through different clients (`setJobSecrets` takes a job id on `/api/jobs/:id/secrets`) and because a
 * server block with a job-shaped prop would be one component with two identities — but the behaviour
 * is deliberately identical: never show a value, never receive one, and treat declaration as consent.
 *
 * The names come from the **live draft**: a name typed into "secret env names" gets a box as it is
 * typed, and disappears when it is removed. `saved` is what the stored job declares, so a name that
 * is typed but not yet saved is marked and its box disabled — the route refuses a value for a name
 * the stored entry does not declare, and saying why once beats a `400` to decode.
 */
const props = defineProps<{
  /** The job id whose values these are. Empty while creating — no values can exist yet. */
  jobId: string
  /** The names as the **form draft** lists them. */
  declared: string[]
  /** What the **stored** job declares. A name in `declared` but not here is typed-not-saved. */
  savedDeclared: string[]
  /** From the view: the declared names whose values are stored. Names only, never values. */
  setNames: string[]
}>()

const emit = defineEmits<{ changed: [] }>()

const declared = computed(() => props.declared)
const saved = computed(() => new Set(props.savedDeclared))
/** A name typed in the form but not yet in the stored job: the route would refuse its value. */
const unsaved = (name: string): boolean => !saved.value.has(name)
const isSet = computed(() => new Set(props.setNames))
/** Nothing can be written before the job exists: the route keys on its id. */
const noJob = computed(() => props.jobId.trim().length === 0)
/** A name that cannot take a value right now, and why. */
const inert = (name: string): boolean => noJob.value || unsaved(name)

/** One box per declared name, always blank — a blank box means "leave it alone". */
const drafts = reactive<Record<string, string>>({})
const busy = ref<string | null>(null)
const error = ref<string | null>(null)
const message = ref<string | null>(null)

watch(declared, (names) => {
  for (const name of names) {
    if (drafts[name] === undefined)
      drafts[name] = ''
  }
  for (const name of Object.keys(drafts)) {
    if (!names.includes(name))
      delete drafts[name]
  }
}, { immediate: true })

async function save(name: string): Promise<void> {
  const value = drafts[name] ?? ''
  // Blank is "do not touch": an empty variable reads as unset, so Remove is how a name is cleared.
  if (value.length === 0)
    return
  // A name that is typed but not saved is not declared in the stored job, so the route would answer
  // 400. The box is disabled, and this is the same rule for a keyboard submit.
  if (inert(name))
    return
  busy.value = name
  error.value = null
  message.value = null
  try {
    await api.setJobSecrets(props.jobId, { set: { [name]: value } })
    // Cleared the moment it is stored, so the value does not sit in the page's model afterwards.
    drafts[name] = ''
    message.value = `${name} was stored`
    emit('changed')
  }
  catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  }
  finally {
    busy.value = null
  }
}

async function remove(name: string): Promise<void> {
  busy.value = name
  error.value = null
  message.value = null
  try {
    await api.setJobSecrets(props.jobId, { unset: [name] })
    message.value = `${name} was removed`
    emit('changed')
  }
  catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  }
  finally {
    busy.value = null
  }
}
</script>

<template>
  <section class="group grid__full">
    <div class="group__head">
      <span class="group__title">secret values</span>
    </div>
    <p class="faint" style="font-size: 11px">
      written to the workspace secrets file and never sent back by the panel — only whether a value exists
    </p>
    <p v-if="declared.length === 0" class="faint" style="font-size: 11px">
      this job declares no secret names yet — add them in secret env names
    </p>
    <p v-else-if="noJob" class="note note--warn" style="font-size: 11px">
      a value can be set once the job exists — the panel keys its values by the job id
    </p>
    <!--
      One line for the whole group rather than only the per-name badge: a name typed but not saved
      cannot take a value, and saying why once beats repeating it on every row.
    -->
    <p v-else-if="declared.some(name => unsaved(name))" class="note note--warn" style="font-size: 11px">
      a new name can take a value once the job is saved — the panel refuses a value for a name the
      stored job does not declare
    </p>
    <div v-for="name in declared" :key="name" class="field">
      <span class="field__label">
        <span class="mono">{{ name }}</span>
        <span v-if="unsaved(name)" class="chip chip--warn">needs saving</span>
        <span v-else-if="isSet.has(name)" class="chip chip--ok">set</span>
        <span v-else class="faint">— not set</span>
      </span>
      <div class="row">
        <input
          v-model="drafts[name]"
          type="password"
          autocomplete="new-password"
          spellcheck="false"
          :placeholder="noJob ? 'save the job first' : unsaved(name) ? 'save the job first' : isSet.has(name) ? 'a value is stored — enter a new one to replace it' : 'enter a value…'"
          :aria-label="name"
          :disabled="inert(name)"
          @keydown.enter.prevent="save(name)"
        >
        <button type="button" class="btn btn--sm" :disabled="inert(name) || busy === name || (drafts[name] ?? '').length === 0" @click="save(name)">
          save
        </button>
        <!--
          Removing a stored value is destructive and irreversible — the panel never shows it back, so
          it cannot be recovered. It confirms in a popover, per the UI rules, and `cancel` is the
          first target in the sheet's tab order.
        -->
        <ConfirmButton
          v-if="isSet.has(name)"
          label="remove"
          confirm-label="confirm remove"
          tone="danger"
          :disabled="busy === name"
          :title="`Remove the stored value for ${name}?`"
          hint="The panel never shows a secret value back, so this one cannot be recovered — you would have to set it again."
          @confirm="remove(name)"
        />
      </div>
    </div>
    <p v-if="error" class="note note--error">
      {{ error }}
    </p>
    <p v-else-if="message" class="note">
      {{ message }}
    </p>
  </section>
</template>
