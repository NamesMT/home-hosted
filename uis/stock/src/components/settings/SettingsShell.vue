<script setup lang="ts">
import type { FieldChange } from '@shared/patch-diff'
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppButton from '@/components/ui/AppButton.vue'
import Modal from '@/components/ui/Modal.vue'
import { t, tc } from '@/i18n'
import { cn } from '@/lib/cn'
import { formatChangeValue } from '@/lib/format'

/**
 * The body both settings pages share: the section rail with its scroll-spy, the
 * save/discard footer and the unsaved-changes list.
 *
 * The two pages are otherwise different documents — one writes the panel-wide
 * `settings.json`, the other the selected workspace's — so only the chrome lives
 * here. `save`/`discard` are emitted rather than implemented, because each page
 * owns its own endpoint, patch and per-block snapshots.
 */
export interface SettingsSectionMeta {
  id: string
  title: string
}

const props = defineProps<{
  /** The rail's entries; each id must match a `SettingsSection` in the default slot. */
  sections: readonly SettingsSectionMeta[]
  navLabel: string
  /** The modal's description — the one line that names what Save writes. */
  changesDescription: string
  changedCount: number
  changes: FieldChange[]
  saveError: string | null
  saveMessage: string | null
  saving: boolean
}>()

const emit = defineEmits<{ save: [], discard: [] }>()

const route = useRoute()
const router = useRouter()

// The rail starts on the section the page opens with; the scroll-spy corrects it
// as soon as the first frame is measured.
const active = ref(props.sections[0]?.id ?? '')
const showChanges = ref(false)

function scrollToSection(id: string): void {
  void nextTick(() => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })
}

function go(id: string): void {
  active.value = id
  if (route.query.section !== id)
    void router.replace({ query: { ...route.query, section: id } })
  scrollToSection(id)
}

watch(() => route.query.section, (value) => {
  const id = typeof value === 'string' ? value : ''
  if (!props.sections.some(section => section.id === id))
    return
  active.value = id
  scrollToSection(id)
}, { immediate: true })

let observer: IntersectionObserver | null = null

onMounted(() => {
  observer = new IntersectionObserver((entries) => {
    const visible = entries
      .filter(entry => entry.isIntersecting)
      .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
    const first = visible[0]
    if (first !== undefined && first.target.id.length > 0)
      active.value = first.target.id
  }, { rootMargin: '-72px 0px -62% 0px', threshold: 0 })

  for (const section of props.sections) {
    const element = document.getElementById(section.id)
    if (element)
      observer.observe(element)
  }
})

onBeforeUnmount(() => observer?.disconnect())

/** Save from the list closes it — the click and the write are one act. */
function saveFromModal(): void {
  emit('save')
  showChanges.value = false
}
</script>

<template>
  <div class="min-h-full">
    <div class="mx-auto w-full max-w-5xl px-4 pb-6 pt-5 sm:px-6">
      <slot name="header" />

      <div class="lg:grid lg:grid-cols-[11rem_minmax(0,1fr)] lg:gap-8">
        <nav :aria-label="props.navLabel" class="hidden lg:block">
          <ul class="sticky top-6 space-y-0.5 border-l border-line">
            <li v-for="section in props.sections" :key="section.id">
              <button
                type="button"
                :aria-current="active === section.id ? 'true' : undefined"
                :class="cn(
                  '-ml-px block w-full border-l-2 py-1.5 pl-3 text-left text-xs transition-colors duration-150',
                  active === section.id
                    ? 'border-accent font-medium text-accent'
                    : 'border-transparent text-muted hover:border-line hover:text-ink',
                )"
                @click="go(section.id)"
              >
                {{ section.title }}
              </button>
            </li>
          </ul>
        </nav>

        <div class="space-y-6">
          <slot />
        </div>
      </div>
    </div>

    <div class="sticky bottom-0 z-30 border-t border-line bg-panel/95 backdrop-blur">
      <div class="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
        <div class="min-w-0 flex-1">
          <p class="text-xs text-muted">
            <template v-if="props.changedCount > 0">
              <button
                type="button"
                class="rounded-control px-1 py-0.5 text-xs text-muted underline decoration-line underline-offset-2 hover:text-ink"
                @click="showChanges = true"
              >
                <span class="font-mono tabular-nums text-ink">{{ props.changedCount }}</span>
                {{ tc('settings.shell.fieldsChanged', props.changedCount) }}
              </button>
            </template>
            <template v-else>
              {{ t('settings.shell.noUnsavedChanges') }}
            </template>
          </p>
          <p v-if="props.saveError" class="mt-0.5 text-xs text-danger">
            {{ props.saveError }}
          </p>
          <p v-else-if="props.saveMessage" class="mt-0.5 text-xs text-ok">
            {{ props.saveMessage }}
          </p>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <AppButton variant="ghost" :disabled="props.changedCount === 0 || props.saving" @click="emit('discard')">
            {{ t('settings.shell.discard') }}
          </AppButton>
          <AppButton variant="primary" :disabled="props.changedCount === 0" :loading="props.saving" @click="emit('save')">
            {{ t('settings.shell.save') }}
          </AppButton>
        </div>
      </div>
    </div>
  </div>

  <Modal v-model:open="showChanges" :title="t('settings.shell.unsavedTitle')" :description="props.changesDescription" width="w-[min(92vw,42rem)]">
    <div class="max-h-[60dvh] overflow-auto px-4 py-3">
      <ul v-if="props.changes.length > 0" class="divide-y divide-line-soft">
        <li v-for="change in props.changes" :key="change.path" class="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 first:pt-0">
          <code class="font-mono text-xs text-ink">{{ change.path }}</code>
          <span class="ml-auto font-mono text-xs text-muted line-through">{{ formatChangeValue(change.from) }}</span>
          <span class="text-2xs text-faint">→</span>
          <span class="font-mono text-xs text-accent">{{ formatChangeValue(change.to) }}</span>
        </li>
      </ul>
      <p v-else class="text-xs text-muted">
        {{ t('settings.shell.nothingToSave') }}
      </p>
    </div>
    <footer class="flex items-center justify-end gap-2 border-t border-line px-4 py-3">
      <AppButton size="sm" variant="ghost" @click="showChanges = false">
        {{ t('common.close') }}
      </AppButton>
      <AppButton size="sm" variant="primary" :disabled="props.changes.length === 0 || props.saving" :loading="props.saving" @click="saveFromModal">
        {{ tc('settings.shell.saveChanges', props.changes.length) }}
      </AppButton>
    </footer>
  </Modal>
</template>
