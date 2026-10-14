<script setup lang="ts">
import type { ProxyView } from '@shared/contracts'
import type { ProxyAction } from '@/lib/proxy'
import { computed } from 'vue'
import Notice from '@/components/settings/Notice.vue'
import AppButton from '@/components/ui/AppButton.vue'
import CopyButton from '@/components/ui/CopyButton.vue'
import FieldGroup from '@/components/ui/FieldGroup.vue'
import ToneBadge from '@/components/ui/ToneBadge.vue'
import { t } from '@/i18n'
import { formatBytes, RUN_STATE_META } from '@/lib/proxy'

/**
 * The engine binary and its live state: install, update and the lifecycle
 * actions. The policy that decides whether it runs at all is saved with the
 * page's Save, not from here.
 */
const props = defineProps<{
  view: ProxyView | null
  busy: ProxyAction | null
}>()

const emit = defineEmits<{ act: [action: ProxyAction] }>()

const engine = computed(() => props.view?.engine ?? null)
const status = computed(() => props.view?.status ?? null)
const info = computed(() => props.view?.engines[0] ?? null)
const meta = computed(() => (status.value === null ? null : RUN_STATE_META[status.value.state]))
const installed = computed(() => engine.value?.installed === true)
const binaryPath = computed(() => engine.value?.path ?? null)
const setcap = computed(() => (binaryPath.value === null ? null : `sudo setcap 'cap_net_bind_service=+ep' ${binaryPath.value}`))

const CAPABILITIES = [
  { key: 'acme', labelKey: 'proxy.engine.acme' },
  { key: 'internalCa', labelKey: 'proxy.engine.localCa' },
  { key: 'dns01', labelKey: 'proxy.engine.dns01' },
  { key: 'tcp', labelKey: 'proxy.engine.tcpUdp' },
] as const
</script>

<template>
  <FieldGroup
    :title="t('proxy.engine.title')"
    :description="t('proxy.engine.description')"
  >
    <template #actions>
      <ToneBadge v-if="meta" :tone="meta.tone" dot>
        {{ t(meta.labelKey) }}
      </ToneBadge>
    </template>

    <div v-if="engine === null" class="sm:col-span-2">
      <Notice tone="info">
        {{ t('proxy.engine.notInFrame') }}
      </Notice>
    </div>

    <template v-else>
      <div v-if="engine.error" class="sm:col-span-2">
        <Notice tone="danger" :title="t('proxy.engine.readFailed')">
          {{ engine.error }}
        </Notice>
      </div>

      <div v-if="!installed" class="sm:col-span-2">
        <Notice tone="info" :title="t('proxy.engine.notInstalled')">
          {{ t('proxy.engine.installNote', { engine: info?.label ?? engine.id }) }}
        </Notice>
      </div>

      <template v-else>
        <dl class="divide-y divide-line-soft text-xs sm:col-span-2">
          <div class="flex items-start justify-between gap-4 py-1.5">
            <dt class="text-muted">
              {{ t('proxy.engine.version') }}
            </dt>
            <dd class="font-mono text-xs text-ink">
              {{ engine.version ?? t('proxy.engine.notProbed') }}
            </dd>
          </div>
          <div class="flex items-start justify-between gap-4 py-1.5">
            <dt class="text-muted">
              {{ t('proxy.engine.source') }}
            </dt>
            <dd class="text-right text-xs text-ink">
              {{ engine.source === 'custom' ? t('proxy.engine.sourceCustom') : t('proxy.engine.sourceDownloaded') }}
            </dd>
          </div>
          <div v-if="engine.bytes !== null" class="flex items-start justify-between gap-4 py-1.5">
            <dt class="text-muted">
              {{ t('proxy.engine.size') }}
            </dt>
            <dd class="font-mono text-xs tabular-nums text-ink">
              {{ formatBytes(engine.bytes) }}
            </dd>
          </div>
          <div v-if="binaryPath" class="flex items-start justify-between gap-4 py-1.5">
            <dt class="text-muted">
              {{ t('proxy.engine.binary') }}
            </dt>
            <dd class="flex min-w-0 items-center gap-1.5">
              <span class="min-w-0 truncate font-mono text-2xs text-ink">{{ binaryPath }}</span>
              <CopyButton :value="binaryPath" :label="t('proxy.engine.copyPath')" />
            </dd>
          </div>
          <div class="flex items-start justify-between gap-4 py-1.5">
            <dt class="text-muted">
              {{ t('proxy.engine.address') }}
            </dt>
            <dd class="flex flex-wrap items-center justify-end gap-x-2 gap-y-1 text-right font-mono text-xs">
              <a
                v-for="url in status?.urls ?? []"
                :key="url"
                :href="url"
                target="_blank"
                rel="noreferrer"
                class="text-accent underline decoration-line underline-offset-2 hover:decoration-accent"
              >{{ url }}</a>
              <span v-if="!status || status.urls.length === 0" class="text-ink">—</span>
            </dd>
          </div>
          <div class="flex items-start justify-between gap-4 py-1.5">
            <dt class="text-muted">
              {{ t('proxy.engine.process') }}
            </dt>
            <dd class="font-mono text-xs tabular-nums text-ink">
              {{ status?.pid ?? '—' }}
            </dd>
          </div>
          <div class="flex items-start justify-between gap-4 py-1.5">
            <dt class="text-muted">
              {{ t('proxy.engine.certificates') }}
            </dt>
            <dd class="text-xs text-ink">
              {{ status?.certExpiryDays === null || status?.certExpiryDays === undefined
                ? t('proxy.engine.noCert')
                : t('proxy.engine.expiresSoon', { days: status.certExpiryDays }) }}
            </dd>
          </div>
        </dl>

        <div class="flex flex-wrap gap-1.5 sm:col-span-2">
          <ToneBadge v-for="capability in CAPABILITIES" :key="capability.key" :tone="info?.[capability.key] ? 'ok' : 'neutral'">
            {{ info?.[capability.key] ? '✓' : '✗' }} {{ t(capability.labelKey) }}
          </ToneBadge>
          <a
            v-if="info"
            class="ml-1 self-center text-2xs text-accent underline decoration-line underline-offset-2"
            :href="info.docsUrl"
            target="_blank"
            rel="noreferrer"
          >{{ t('proxy.engine.documentation', { engine: info.label }) }}</a>
        </div>
      </template>

      <div v-if="status?.lastError" class="sm:col-span-2">
        <Notice tone="danger" :title="t('proxy.engine.failed')">
          {{ status.lastError }}
        </Notice>
      </div>

      <p v-if="installed && setcap" class="text-2xs leading-4 text-faint sm:col-span-2">
        {{ t('proxy.engine.setcapHint') }}
        <code class="rounded bg-black/10 px-1 py-0.5 font-mono dark:bg-white/10">{{ setcap }}</code>
        <CopyButton :value="setcap" :label="t('proxy.engine.copyCommand')" class="ml-1 align-middle" />
      </p>
    </template>

    <div class="flex flex-wrap items-center gap-2 sm:col-span-2">
      <AppButton
        v-if="!installed"
        variant="primary"
        :loading="props.busy === 'install'"
        :disabled="props.busy !== null"
        @click="emit('act', 'install')"
      >
        {{ t('proxy.engine.install') }}
      </AppButton>
      <template v-else>
        <AppButton
          variant="primary"
          :disabled="props.busy !== null || status?.state === 'running'"
          :loading="props.busy === 'start'"
          @click="emit('act', 'start')"
        >
          {{ t('proxy.engine.start') }}
        </AppButton>
        <AppButton
          variant="secondary"
          :disabled="props.busy !== null || status?.state === 'off' || status?.state === 'stopped'"
          :loading="props.busy === 'stop'"
          @click="emit('act', 'stop')"
        >
          {{ t('proxy.engine.stop') }}
        </AppButton>
        <AppButton
          variant="secondary"
          :disabled="props.busy !== null || status?.state !== 'running'"
          :loading="props.busy === 'apply'"
          @click="emit('act', 'apply')"
        >
          {{ t('proxy.engine.apply') }}
        </AppButton>
        <AppButton
          variant="ghost"
          :disabled="props.busy !== null || status?.state !== 'running'"
          :loading="props.busy === 'revert'"
          :title="t('proxy.engine.revertHint')"
          @click="emit('act', 'revert')"
        >
          {{ t('proxy.engine.revert') }}
        </AppButton>
        <AppButton
          variant="ghost"
          :disabled="props.busy !== null"
          :loading="props.busy === 'install'"
          @click="emit('act', 'install')"
        >
          {{ t('proxy.engine.update') }}
        </AppButton>
      </template>
    </div>
  </FieldGroup>
</template>
