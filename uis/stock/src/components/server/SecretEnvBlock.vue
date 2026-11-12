<script setup lang="ts">
import type { ServerConfig } from '@shared/contracts'
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
  config: ServerConfig
  /** The names that have a value, from the view. Empty on a panel that predates the field. */
  setNames: string[]
  workspaceId: string
}>()

const emit = defineEmits<{ changed: [] }>()

/** The names the entry declares, in config order. */
const declared = computed(() => props.config.secretEnv ?? [])
/** Which of them have a value. Always a subset of `declared`; a name absent here has none. */
const isSet = computed(() => new Set(props.setNames))

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
  // variable reads as unset anyway — the Remove button is the way to clear a name.
  if (value.length === 0)
    return
  busy.value = name
  error.value = null
  message.value = null
  try {
    await api.setServerSecrets(props.serverId, { set: { [name]: value } }, props.workspaceId)
    // Cleared the moment it is stored: the value must not sit in the page's model after the write.
    drafts[name] = ''
    message.value = t('serverForm.secretSaved', { name })
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
    message.value = t('serverForm.secretRemoved', { name })
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
    :title="t('serverForm.secretValuesTitle')"
    :description="t('serverForm.secretValuesDescription')"
    :columns="2"
  >
    <p v-if="declared.length === 0" class="text-2xs leading-4 text-faint sm:col-span-2">
      {{ t('serverForm.secretValuesEmpty') }}
    </p>
    <div v-for="name in declared" :key="name" class="flex flex-col gap-1.5 sm:col-span-2">
      <div class="flex items-center gap-2">
        <Lock class="size-3 shrink-0 text-faint" />
        <span class="font-mono text-xs text-ink">{{ name }}</span>
        <span
          v-if="isSet.has(name)"
          class="rounded-full bg-accent-soft px-1.5 py-px text-2xs text-accent"
        >{{ t('serverForm.secretIsSet') }}</span>
        <span v-else class="text-2xs text-faint">{{ t('serverForm.secretNotSet') }}</span>
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
          :placeholder="isSet.has(name) ? t('serverForm.secretPlaceholderSet') : t('serverForm.secretPlaceholder')"
          :aria-label="name"
          @keydown.enter.prevent="save(name)"
        >
        <AppButton size="sm" :disabled="busy === name || (drafts[name] ?? '').length === 0" @click="save(name)">
          {{ t('serverForm.secretSave') }}
        </AppButton>
        <!--
          Removing a stored value is destructive and irreversible — the panel never shows it back, so
          it cannot be recovered. It confirms in a popover, and `cancel` comes first in tab order.
        -->
        <ConfirmButton
          v-if="isSet.has(name)"
          size="sm"
          variant="ghost"
          :label="t('serverForm.secretRemove')"
          :confirm-label="t('common.confirm')"
          :disabled="busy === name"
          :title="t('serverForm.secretRemoveTitle', { name })"
          :hint="t('serverForm.secretRemoveHint')"
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
