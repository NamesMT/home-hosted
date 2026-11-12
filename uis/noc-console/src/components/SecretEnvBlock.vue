<script setup lang="ts">
import type { ServerConfig } from '@shared/contracts'
import { computed, reactive, ref, watch } from 'vue'
import ConfirmButton from '@/components/ConfirmButton.vue'
import * as api from '@/lib/api'

/**
 * A server's secret values: the names that have one, and a masked box to set or clear each.
 *
 * Never shows a value and never receives one — `secretEnvSet` on the view says which declared names
 * have a value, and the write-only route takes the value. That is the whole point of this block:
 * a page that can display a secret is a page that leaks it.
 *
 * The panel's rule is that declaration is consent, so this only offers names the config declares.
 */
const props = defineProps<{
  serverId: string
  config: ServerConfig
  /** From the view: the declared names whose values are stored. */
  setNames: string[]
  workspaceId: string
}>()

const emit = defineEmits<{ changed: [] }>()

const declared = computed(() => props.config.secretEnv ?? [])
const isSet = computed(() => new Set(props.setNames))

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
  busy.value = name
  error.value = null
  message.value = null
  try {
    await api.setServerSecrets(props.serverId, { set: { [name]: value } }, props.workspaceId)
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
    await api.setServerSecrets(props.serverId, { unset: [name] }, props.workspaceId)
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
  <section class="group">
    <h4 class="group__title">
      secret values
    </h4>
    <p class="faint" style="font-size: 11px">
      written to the workspace secrets file and never sent back by the panel — only whether a value exists
    </p>
    <p v-if="declared.length === 0" class="faint" style="font-size: 11px">
      this entry declares no secret names yet — add them in secret env names
    </p>
    <div v-for="name in declared" :key="name" class="field">
      <span class="field__label">
        <span class="mono">{{ name }}</span>
        <span v-if="isSet.has(name)" class="chip chip--ok">set</span>
        <span v-else class="faint">— not set</span>
      </span>
      <div class="row">
        <input
          v-model="drafts[name]"
          type="password"
          autocomplete="new-password"
          spellcheck="false"
          :placeholder="isSet.has(name) ? 'a value is stored — enter a new one to replace it' : 'enter a value…'"
          :aria-label="name"
          @keydown.enter.prevent="save(name)"
        >
        <button type="button" class="btn btn--sm" :disabled="busy === name || (drafts[name] ?? '').length === 0" @click="save(name)">
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
