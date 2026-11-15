<script setup lang="ts">
import { Lock } from '@lucide/vue'
import { computed, reactive, ref, watch } from 'vue'
import ConfirmButton from '@/components/settings/ConfirmButton.vue'
import AppButton from '@/components/ui/AppButton.vue'
import { t } from '@/i18n'
import * as api from '@/lib/api'

/**
 * A **job's** secret values: the names it declares, a masked box for each, and a way to set or clear
 * one.
 *
 * The job half of `SecretEnvBlock.vue`, against the job's own write-only route. It is a second
 * component rather than a prop on the first because the two write through different clients
 * (`setJobSecrets` keys on the job id, `setServerSecrets` on the server id) — but the behaviour is
 * deliberately identical, because it is the same store and the same rule:
 *
 *  - **never show a value, and never receive one.** `secretEnvSet` says which declared names have one;
 *    a masked box writes one through `PUT /api/jobs/:id/secrets`.
 *  - **declaration is consent.** A name the job does not declare is refused by the route, so this
 *    only offers the names the form draft carries.
 *  - **a blank box is "leave it alone", never "clear it".** Remove is how a name is cleared.
 *
 * The names come from the **live draft**: a name typed into "Secret environment names" gets a box as
 * it is typed, and disappears when it is removed. `savedDeclared` is what the stored job declares, so
 * a name typed but not saved is marked and its box is inert — saying so beats a `400` to decode.
 */
const props = defineProps<{
  /** The job whose values these are. Empty while creating one — the panel keys values by job id. */
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
/** Which of them have a value. Always a subset of `declared`; a name absent here has none. */
const isSet = computed(() => new Set(props.setNames))
/** Nothing can be written before the job exists: the route keys on its id. */
const noJob = computed(() => props.jobId.trim().length === 0)
/** A name that is typed in the form but not in the stored job: no value until it is saved. */
const unsaved = (name: string): boolean => !saved.value.has(name)
/** A name that cannot take a value right now, and why. */
const inert = (name: string): boolean => noJob.value || unsaved(name)

/** One box per declared name, blank — a blank box is "leave it alone", never "clear it". */
const drafts = reactive<Record<string, string>>({})
const busy = ref<string | null>(null)
const error = ref<string | null>(null)
const message = ref<string | null>(null)

/** Keep a box in step with what is declared, without ever seeding it from a value (there is none). */
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
  // A blank box means "do not touch it": sending an empty value would store one, and an empty
  // variable reads as unset anyway — Remove is the way to clear a name.
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
    // Cleared the moment it is stored: the value must not sit in the page's model after the write.
    drafts[name] = ''
    message.value = t('secretEnv.saved', { name })
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
    message.value = t('secretEnv.removed', { name })
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
  <div class="flex flex-col gap-2 sm:col-span-2">
    <div class="flex items-center gap-2">
      <Lock class="size-3 shrink-0 text-faint" />
      <span class="text-2xs font-medium uppercase tracking-wide text-faint">{{ t('secretEnv.valuesTitle') }}</span>
    </div>
    <p class="text-2xs leading-4 text-muted">
      {{ t('secretEnv.valuesDescription') }}
    </p>
    <p v-if="declared.length === 0" class="text-2xs leading-4 text-faint">
      {{ t('secretEnv.valuesEmpty') }}
    </p>
    <p v-else-if="noJob" class="text-2xs leading-4 text-warn">
      {{ t('jobs.secretsNeedJob') }}
    </p>
    <!--
      One line for the whole group rather than only the per-name badge: a name typed but not saved
      cannot take a value, and saying why once beats repeating it on every row.
    -->
    <p v-else-if="declared.some(name => unsaved(name))" class="text-2xs leading-4 text-warn">
      {{ t('jobs.secretsSaveFirst') }}
    </p>
    <div v-for="name in declared" :key="name" class="flex flex-col gap-1.5">
      <div class="flex items-center gap-2">
        <span class="font-mono text-xs text-ink">{{ name }}</span>
        <span
          v-if="unsaved(name)"
          class="rounded-full bg-warn-soft px-1.5 py-px text-2xs text-warn"
        >{{ t('secretEnv.unsaved') }}</span>
        <span
          v-else-if="isSet.has(name)"
          class="rounded-full bg-accent-soft px-1.5 py-px text-2xs text-accent"
        >{{ t('secretEnv.isSet') }}</span>
        <span v-else class="text-2xs text-faint">{{ t('secretEnv.notSet') }}</span>
      </div>
      <div class="flex items-center gap-2">
        <!--
          `type="password"` and no `autocomplete`, so a browser never offers to save it and a
          shoulder-surfer sees dots. The panel never sends a value back, so this box is always empty.
        -->
        <input
          v-model="drafts[name]"
          type="password"
          autocomplete="new-password"
          spellcheck="false"
          class="w-full min-w-0 rounded-control border border-line bg-page/60 px-2.5 py-1.5 font-mono text-xs text-ink placeholder:text-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25"
          :placeholder="inert(name) ? t('secretEnv.saveFirst') : isSet.has(name) ? t('secretEnv.placeholderSet') : t('secretEnv.placeholder')"
          :aria-label="name"
          :disabled="inert(name)"
          @keydown.enter.prevent="save(name)"
        >
        <AppButton size="sm" :disabled="inert(name) || busy === name || (drafts[name] ?? '').length === 0" @click="save(name)">
          {{ t('secretEnv.save') }}
        </AppButton>
        <!--
          Removing a stored value is destructive and irreversible — the panel never shows it back, so
          it cannot be recovered. It confirms in a popover, and `cancel` comes first in tab order.
        -->
        <ConfirmButton
          v-if="isSet.has(name)"
          size="sm"
          variant="ghost"
          :label="t('secretEnv.remove')"
          :confirm-label="t('common.confirm')"
          :disabled="busy === name"
          :title="t('secretEnv.removeTitle', { name })"
          :hint="t('secretEnv.removeHint')"
          @confirm="remove(name)"
        />
      </div>
    </div>
    <p v-if="error" class="text-2xs leading-4 text-danger">
      {{ error }}
    </p>
    <p v-else-if="message" class="text-2xs leading-4 text-accent">
      {{ message }}
    </p>
  </div>
</template>
