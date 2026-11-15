<script setup lang="ts">
import { Lock } from '@lucide/vue'
import { computed, reactive, ref, watch } from 'vue'
import ConfirmButton from '@/components/settings/ConfirmButton.vue'
import AppButton from '@/components/ui/AppButton.vue'
import FieldGroup from '@/components/ui/FieldGroup.vue'
import { t } from '@/i18n'
import * as api from '@/lib/api'

/**
 * A server's secret environment: the **names**, which have a value, and a way to set or clear one.
 *
 * Never shows a value, and never receives one: this is the one screen whose whole job is to prove
 * the values are not here. `secretEnvSet` on the view says which declared names have a value; a
 * masked box writes one through the write-only route.
 *
 * The panel's rule is that declaration is consent — a name the entry does not declare is refused by
 * the route — so this only offers the names the config already declares.
 */
const props = defineProps<{
  serverId: string
  /**
   * The names to offer a box for — the **live form draft**, not the saved config.
   *
   * This was `config` (the saved `ServerConfig`), and that was the reactivity bug: a name typed into
   * "Secret environment names" did not appear here until the config was saved and the page reopened,
   * because `props.config` only changes when the panel sends a fresh view. Passing the draft means a
   * name appears as it is typed, and disappears as it is removed.
   */
  declared: string[]
  /** The names that have a value, from the view. Empty on a panel that predates the field. */
  setNames: string[]
  workspaceId: string
  /**
   * Whether a value can be written yet.
   *
   * The route refuses a name the **stored** entry does not declare, and this block lives inside the
   * config form, so a name typed but not yet saved cannot be given a value. Saying so beats a
   * `400 INVALID_INPUT` the person has to decode.
   */
  savedDeclared: string[]
}>()

const emit = defineEmits<{ changed: [] }>()

/**
 * The names the entry declares, in the order the draft lists them.
 *
 * `declared` is the live draft; `savedDeclared` is what the stored config has. A name in the first
 * but not the second has been typed and not saved, and its box is disabled with a reason.
 */
const declared = computed(() => props.declared)
const saved = computed(() => new Set(props.savedDeclared))
/** Which of them have a value. Always a subset of `declared`; a name absent here has none. */
const isSet = computed(() => new Set(props.setNames))

/** One box per declared name, blank — a blank box is "leave it alone", never "clear it". */
const drafts = reactive<Record<string, string>>({})
const busy = ref<string | null>(null)
/** A name that is typed in the form but not in the saved config: no box until it is saved. */
const unsaved = (name: string): boolean => !saved.value.has(name)
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
  // variable reads as unset anyway — the Remove button is the way to clear a name.
  if (value.length === 0)
    return
  // A name that is typed but not saved is not declared in the stored entry, so the route would
  // answer 400. The box is disabled, and this is the same rule for a keyboard submit.
  if (unsaved(name))
    return
  busy.value = name
  error.value = null
  message.value = null
  try {
    await api.setServerSecrets(props.serverId, { set: { [name]: value } }, props.workspaceId)
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
    await api.setServerSecrets(props.serverId, { unset: [name] }, props.workspaceId)
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
  <FieldGroup
    :title="t('secretEnv.valuesTitle')"
    :description="t('secretEnv.valuesDescription')"
    :columns="2"
  >
    <p v-if="declared.length === 0" class="text-2xs leading-4 text-faint sm:col-span-2">
      {{ t('secretEnv.valuesEmpty') }}
    </p>
    <!--
      One line for the whole group rather than only the per-name badge: a name typed but not saved
      cannot take a value, and saying why once beats repeating it on every row.
    -->
    <p v-else-if="declared.some(name => unsaved(name))" class="text-2xs leading-4 text-warn sm:col-span-2">
      {{ t('secretEnv.saveFirstHint') }}
    </p>
    <div v-for="name in declared" :key="name" class="flex flex-col gap-1.5 sm:col-span-2">
      <div class="flex items-center gap-2">
        <Lock class="size-3 shrink-0 text-faint" />
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
          :placeholder="unsaved(name) ? t('secretEnv.saveFirst') : isSet.has(name) ? t('secretEnv.placeholderSet') : t('secretEnv.placeholder')"
          :aria-label="name"
          :disabled="unsaved(name)"
          @keydown.enter.prevent="save(name)"
        >
        <AppButton size="sm" :disabled="unsaved(name) || busy === name || (drafts[name] ?? '').length === 0" @click="save(name)">
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
    <p v-if="error" class="text-2xs leading-4 text-danger sm:col-span-2">
      {{ error }}
    </p>
    <p v-else-if="message" class="text-2xs leading-4 text-accent sm:col-span-2">
      {{ message }}
    </p>
  </FieldGroup>
</template>
