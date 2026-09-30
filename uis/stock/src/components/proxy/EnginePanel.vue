<script setup lang="ts">
import type { ProxyView } from '@shared/contracts'
import type { ProxyAction } from '@/lib/proxy'
import { computed } from 'vue'
import Notice from '@/components/settings/Notice.vue'
import AppButton from '@/components/ui/AppButton.vue'
import CopyButton from '@/components/ui/CopyButton.vue'
import FieldGroup from '@/components/ui/FieldGroup.vue'
import ToneBadge from '@/components/ui/ToneBadge.vue'
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
  { key: 'acme', label: 'ACME certificates' },
  { key: 'internalCa', label: 'Local CA' },
  { key: 'dns01', label: 'DNS-01' },
  { key: 'tcp', label: 'TCP/UDP' },
] as const
</script>

<template>
  <FieldGroup
    title="Engine"
    description="The reverse proxy itself. The panel downloads a pinned build, supervises it and applies its configuration through the engine's own admin API."
  >
    <template #actions>
      <ToneBadge v-if="meta" :tone="meta.tone" dot>
        {{ meta.label }}
      </ToneBadge>
    </template>

    <div v-if="engine === null" class="sm:col-span-2">
      <Notice tone="info">
        The proxy state is not in this panel's frame yet.
      </Notice>
    </div>

    <template v-else>
      <div v-if="engine.error" class="sm:col-span-2">
        <Notice tone="danger" title="The engine could not be read">
          {{ engine.error }}
        </Notice>
      </div>

      <div v-if="!installed" class="sm:col-span-2">
        <Notice tone="info" title="No engine installed">
          Installing downloads the pinned {{ info?.label ?? engine.id }} build the panel supervises —
          about 46 MB, once. Nothing is exposed until a route is added and the proxy is switched on.
        </Notice>
      </div>

      <template v-else>
        <dl class="divide-y divide-line-soft text-xs sm:col-span-2">
          <div class="flex items-start justify-between gap-4 py-1.5">
            <dt class="text-muted">
              Version
            </dt>
            <dd class="font-mono text-xs text-ink">
              {{ engine.version ?? 'not probed yet' }}
            </dd>
          </div>
          <div class="flex items-start justify-between gap-4 py-1.5">
            <dt class="text-muted">
              Source
            </dt>
            <dd class="text-right text-xs text-ink">
              {{ engine.source === 'custom' ? 'a path configured by hand' : 'downloaded by the panel' }}
            </dd>
          </div>
          <div v-if="engine.bytes !== null" class="flex items-start justify-between gap-4 py-1.5">
            <dt class="text-muted">
              Size
            </dt>
            <dd class="font-mono text-xs tabular-nums text-ink">
              {{ formatBytes(engine.bytes) }}
            </dd>
          </div>
          <div v-if="engine.sha256" class="flex items-start justify-between gap-4 py-1.5">
            <dt class="text-muted">
              SHA-256
            </dt>
            <dd class="flex min-w-0 items-center gap-1.5">
              <span class="min-w-0 truncate font-mono text-2xs text-ink">{{ engine.sha256 }}</span>
              <CopyButton :value="engine.sha256" label="Copy the checksum" />
            </dd>
          </div>
          <div v-if="binaryPath" class="flex items-start justify-between gap-4 py-1.5">
            <dt class="text-muted">
              Binary
            </dt>
            <dd class="flex min-w-0 items-center gap-1.5">
              <span class="min-w-0 truncate font-mono text-2xs text-ink">{{ binaryPath }}</span>
              <CopyButton :value="binaryPath" label="Copy the binary path" />
            </dd>
          </div>
          <div class="flex items-start justify-between gap-4 py-1.5">
            <dt class="text-muted">
              Live address
            </dt>
            <dd class="text-right font-mono text-xs text-ink">
              {{ status && status.urls.length > 0 ? status.urls.join(', ') : '—' }}
            </dd>
          </div>
          <div class="flex items-start justify-between gap-4 py-1.5">
            <dt class="text-muted">
              Process
            </dt>
            <dd class="font-mono text-xs tabular-nums text-ink">
              {{ status?.pid ?? '—' }}
            </dd>
          </div>
          <div class="flex items-start justify-between gap-4 py-1.5">
            <dt class="text-muted">
              Certificates
            </dt>
            <dd class="text-xs text-ink">
              {{ status?.certExpiryDays === null || status?.certExpiryDays === undefined
                ? 'no public certificate yet'
                : `soonest expires in ${status.certExpiryDays} days` }}
            </dd>
          </div>
        </dl>

        <div class="flex flex-wrap gap-1.5 sm:col-span-2">
          <ToneBadge v-for="capability in CAPABILITIES" :key="capability.key" :tone="info?.[capability.key] ? 'ok' : 'neutral'">
            {{ info?.[capability.key] ? '✓' : '✗' }} {{ capability.label }}
          </ToneBadge>
          <a
            v-if="info"
            class="ml-1 self-center text-2xs text-accent underline decoration-line underline-offset-2"
            :href="info.docsUrl"
            target="_blank"
            rel="noreferrer"
          >{{ info.label }} documentation</a>
        </div>
      </template>

      <div v-if="status?.lastError" class="sm:col-span-2">
        <Notice tone="danger" title="The engine reported a failure">
          {{ status.lastError }}
        </Notice>
      </div>

      <p v-if="installed && setcap" class="text-2xs leading-4 text-faint sm:col-span-2">
        A privileged port (below 1024) needs this once on Linux:
        <code class="rounded bg-black/10 px-1 py-0.5 font-mono dark:bg-white/10">{{ setcap }}</code>
        <CopyButton :value="setcap" label="Copy the command" class="ml-1 align-middle" />
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
        Install engine
      </AppButton>
      <template v-else>
        <AppButton
          variant="primary"
          :disabled="props.busy !== null || status?.state === 'running'"
          :loading="props.busy === 'start'"
          @click="emit('act', 'start')"
        >
          Start
        </AppButton>
        <AppButton
          variant="secondary"
          :disabled="props.busy !== null || status?.state === 'off' || status?.state === 'stopped'"
          :loading="props.busy === 'stop'"
          @click="emit('act', 'stop')"
        >
          Stop
        </AppButton>
        <AppButton
          variant="secondary"
          :disabled="props.busy !== null || status?.state !== 'running'"
          :loading="props.busy === 'apply'"
          @click="emit('act', 'apply')"
        >
          Apply configuration
        </AppButton>
        <AppButton
          variant="ghost"
          :disabled="props.busy !== null || status?.state !== 'running'"
          :loading="props.busy === 'revert'"
          title="Go back to the configuration that applied before the last one"
          @click="emit('act', 'revert')"
        >
          Revert
        </AppButton>
        <AppButton
          variant="ghost"
          :disabled="props.busy !== null"
          :loading="props.busy === 'install'"
          @click="emit('act', 'install')"
        >
          Update engine
        </AppButton>
      </template>
    </div>
  </FieldGroup>
</template>
