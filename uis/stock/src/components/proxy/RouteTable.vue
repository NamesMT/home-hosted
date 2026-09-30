<script setup lang="ts">
import type { ProxyRouteView } from '@shared/contracts'
import type { ProxyWorkspace, RouteDraft } from '@/lib/proxy'
import { Pencil, Plus, Trash2, Waypoints } from 'lucide-vue-next'
import { computed } from 'vue'
import Notice from '@/components/settings/Notice.vue'
import AppButton from '@/components/ui/AppButton.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import FieldGroup from '@/components/ui/FieldGroup.vue'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import ToneBadge from '@/components/ui/ToneBadge.vue'
import { ROUTE_STATUS_META, targetSummary, tlsSummary } from '@/lib/proxy'

/**
 * The route table. Rows are a draft: the whole list is written by the page's
 * Save, which is why removing one is a plain button and not a confirmation.
 */
const props = defineProps<{
  routes: RouteDraft[]
  /** Live state per saved route; a draft that was never saved has none. */
  views: ProxyRouteView[]
  workspaces: ProxyWorkspace[]
  disabled: boolean
}>()

const emit = defineEmits<{
  add: []
  edit: [route: RouteDraft]
  remove: [route: RouteDraft]
  toggle: [route: RouteDraft, enabled: boolean]
}>()

const rows = computed(() => props.routes.map((route) => {
  const view = props.views.find(entry => entry.route.id === route.id) ?? null
  return {
    route,
    view,
    meta: view === null ? null : ROUTE_STATUS_META[view.status],
    target: targetSummary(route, props.workspaces),
    tls: tlsSummary(route),
  }
}))

const problems = computed(() => rows.value.filter(row => row.view?.status === 'error'))
</script>

<template>
  <FieldGroup
    title="Routes"
    description="One public hostname per service. A route may point at a supervised server in any workspace, at this panel, or at a literal upstream."
  >
    <template #actions>
      <AppButton size="xs" variant="secondary" :disabled="props.disabled" @click="emit('add')">
        <Plus class="size-3.5" />
        Add route
      </AppButton>
    </template>

    <div v-if="problems.length > 0" class="sm:col-span-2">
      <Notice tone="danger" title="These routes cannot be saved as they stand">
        <ul class="list-disc space-y-0.5 pl-4">
          <li v-for="problem in problems" :key="problem.route.id">
            {{ problem.view?.message ?? `${problem.route.host} cannot be routed` }}
          </li>
        </ul>
      </Notice>
    </div>

    <div v-if="rows.length === 0" class="sm:col-span-2">
      <EmptyState
        compact
        title="No routes yet"
        description="Add one to expose a server through a domain — the engine gets the certificate on its own."
      >
        <template #icon>
          <Waypoints class="size-5" />
        </template>
        <template #action>
          <AppButton variant="primary" :disabled="props.disabled" @click="emit('add')">
            Add the first route
          </AppButton>
        </template>
      </EmptyState>
    </div>

    <div v-else class="overflow-x-auto sm:col-span-2">
      <table class="w-full text-left text-xs">
        <thead>
          <tr class="text-2xs text-faint">
            <th class="py-1 pr-3 font-medium">
              Hostname
            </th>
            <th class="py-1 pr-3 font-medium">
              Target
            </th>
            <th class="py-1 pr-3 font-medium">
              Upstream
            </th>
            <th class="py-1 pr-3 font-medium">
              TLS
            </th>
            <th class="py-1 pr-3 font-medium">
              State
            </th>
            <th class="py-1 pr-3 font-medium">
              On
            </th>
            <th class="py-1 font-medium">
              <span class="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.route.key" class="border-t border-line-soft align-top">
            <td class="py-1.5 pr-3">
              <p class="font-mono text-xs text-ink">
                {{ row.route.host.trim().length > 0 ? row.route.host : 'no hostname yet' }}
                <span v-if="row.route.path.length > 0" class="text-accent">{{ row.route.path }}</span>
              </p>
              <p class="font-mono text-2xs text-faint">
                {{ row.route.id }}
              </p>
            </td>
            <td class="py-1.5 pr-3 text-2xs text-muted">
              {{ row.target }}
            </td>
            <td class="py-1.5 pr-3 font-mono text-2xs text-muted">
              {{ row.view?.upstream ?? '—' }}
            </td>
            <td class="py-1.5 pr-3 text-2xs text-muted">
              {{ row.tls }}
            </td>
            <td class="py-1.5 pr-3">
              <ToneBadge v-if="row.meta" :tone="row.meta.tone" dot>
                {{ row.meta.label }}
              </ToneBadge>
              <ToneBadge v-else tone="info" dot>
                Not applied yet
              </ToneBadge>
              <p
                v-if="row.view?.message"
                class="mt-0.5 text-2xs"
                :class="row.view.status === 'error' ? 'text-danger' : 'text-warn'"
              >
                {{ row.view.message }}
              </p>
            </td>
            <td class="py-1.5 pr-3">
              <ToggleSwitch
                :model-value="row.route.enabled"
                :label="`Route ${row.route.host || row.route.id}`"
                sr-only
                :disabled="props.disabled"
                @update:model-value="value => emit('toggle', row.route, value)"
              />
            </td>
            <td class="py-1.5">
              <span class="flex items-center justify-end gap-1">
                <AppButton size="xs" variant="ghost" :disabled="props.disabled" :aria-label="`Edit ${row.route.host || row.route.id}`" @click="emit('edit', row.route)">
                  <Pencil class="size-3.5" />
                </AppButton>
                <AppButton size="xs" variant="danger-ghost" :disabled="props.disabled" :aria-label="`Remove ${row.route.host || row.route.id}`" @click="emit('remove', row.route)">
                  <Trash2 class="size-3.5" />
                </AppButton>
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </FieldGroup>
</template>
