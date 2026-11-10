<script setup lang="ts">
import type { ServerConfig } from '@shared/contracts'
import type { Patch } from '@shared/patch-diff'
import { parseBind, serverPatchSchema } from '@shared/contracts'
import { countLeaves, describeChanges } from '@shared/patch-diff'
import { fillSnapshot, liveConfigUpdate, serverEditPatch, serverEditPayload } from '@shared/server-form'
import { type } from 'arktype'
import { computed, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import ConfirmButton from '@/components/ConfirmButton.vue'
import ServerFormFields from '@/components/ServerFormFields.vue'
import StatusChip from '@/components/StatusChip.vue'
import { vFocusTrap } from '@/composables/useFocusTrap'
import { configChangesOpen, flash, selectedId } from '@/composables/useUi'
import { useWorkspaces } from '@/composables/useWorkspaces'
import { editFormFromPage, pageFormFrom, PLACEHOLDER_CONFIG } from '@/lib/serverForm'
import { workspacePath } from '@/router'

const props = defineProps<{ id: string }>()

const workspace = useWorkspaces()
const router = useRouter()

const error = ref<string | null>(null)
const saving = ref(false)

const activeId = computed(() => workspace.activeId.value)
const server = computed(() => workspace.serverById(props.id))
const config = computed<ServerConfig | null>(() => server.value?.config ?? null)

/**
 * The page's own form: the shared fields as strings, plus the restart/health/stop groups its own
 * panes bind. What every box *means* — a cleared one, the hook timeouts in seconds, the diff — is
 * `@shared/server-form`, the same round trip `uis/stock`'s editor uses.
 */
const form = reactive(pageFormFrom(config.value ?? PLACEHOLDER_CONFIG))

/**
 * The config the form was last filled from — detached, so it never moves with the store. A cleared
 * box falls back to it, and Save diffs against it: diffing against live state would write back the
 * old value of anything another client changed meanwhile.
 */
const filled = ref<ServerConfig | null>(null)

/** Set when the entry changed elsewhere while this page held edits. */
const changedElsewhere = ref(false)

function load(cfg: ServerConfig): void {
  Object.assign(form, pageFormFrom(cfg))
  filled.value = fillSnapshot(cfg)
  changedElsewhere.value = false
}

const payload = computed(() => (filled.value === null ? {} : serverEditPayload(editFormFromPage(form), filled.value)))
const patch = computed<Patch>(() => (filled.value === null ? {} : serverEditPatch(editFormFromPage(form), filled.value)))
const changedCount = computed(() => countLeaves(patch.value))
const changes = computed(() => describeChanges(
  patch.value,
  filled.value === null ? {} : { ...filled.value, label: filled.value.label ?? '' } as Patch,
))

// The control plane rebuilds every config object on each state frame. A genuine change refills a
// clean page; a page holding edits keeps them and says the entry moved underneath it.
watch(config, (next) => {
  if (next === null)
    return
  if (filled.value === null) {
    load(next)
    return
  }
  const action = liveConfigUpdate(next, filled.value, changedCount.value > 0)
  if (action === 'refill')
    load(next)
  else if (action === 'notice')
    changedElsewhere.value = true
}, { immediate: true })

function reload(): void {
  if (config.value !== null)
    load(config.value)
}

function back(): void {
  void router.push(workspacePath(activeId.value, 'servers'))
}

function formatChangeValue(value: unknown): string {
  if (value === undefined)
    return 'unset'
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function openChanges(): void {
  configChangesOpen.value = true
}

function closeChanges(): void {
  configChangesOpen.value = false
}

function saveFromDialog(): void {
  configChangesOpen.value = false
  void save()
}

async function save(): Promise<void> {
  error.value = null
  const cfg = config.value
  if (!cfg)
    return

  if (form.bind === 'custom' && parseBind(form.customBind.trim()) === null) {
    error.value = 'a custom bind must be an IPv4 address, "local" or "lan"'
    configChangesOpen.value = false
    return
  }

  const validated = serverPatchSchema(payload.value)
  if (validated instanceof type.errors) {
    error.value = validated.summary
    configChangesOpen.value = false
    return
  }

  if (Object.keys(patch.value).length === 0) {
    flash('nothing changed')
    back()
    return
  }

  saving.value = true
  try {
    const outcome = await workspace.saveConfig(props.id, patch.value)
    if (!outcome.ok) {
      error.value = outcome.error
      return
    }
    selectedId.value = props.id
    flash(`saved ${props.id}`)
    back()
  }
  finally {
    saving.value = false
  }
}

async function remove(): Promise<void> {
  const outcome = await workspace.removeServer(props.id)
  if (!outcome.ok) {
    flash(outcome.error, 'error')
    return
  }
  flash(`removed ${props.id}`)
  back()
}
</script>

<template>
  <div class="view">
    <div class="view__head">
      <RouterLink :to="workspacePath(activeId, 'servers')" class="btn btn--sm btn--ghost">
        ← servers
      </RouterLink>
      <span class="view__title">{{ id }} · config</span>
      <StatusChip v-if="server" :status="server.status" />
      <span v-if="server && !server.config.enabled" class="chip chip--idle">disabled</span>
      <span class="view__spacer" />
      <button
        v-if="changedCount > 0"
        type="button"
        class="btn btn--sm btn--ghost changelink"
        @click="openChanges"
      >
        <span class="mono">{{ changedCount }}</span> unsaved {{ changedCount === 1 ? 'change' : 'changes' }}
      </button>
      <span v-else-if="config" class="view__count">in sync</span>
      <ConfirmButton
        v-if="server"
        label="remove server"
        confirm-label="confirm remove"
        tone="danger"
        title="Remove this server?"
        hint="It leaves servers.config.json: its process stops, and its logs and crash history are deleted."
        @confirm="remove"
      />
      <button type="button" class="btn btn--sm" @click="back">
        cancel
      </button>
      <button type="button" class="btn btn--sm btn--primary" :disabled="saving || config === null" @click="save">
        save config
      </button>
    </div>

    <p v-if="config === null" class="empty">
      no server called “{{ id }}” — it may have been removed
    </p>

    <form v-else class="form form--page" @submit.prevent="save">
      <p v-if="error" class="banner banner--error">
        {{ error }}
      </p>
      <p v-if="changedElsewhere" class="banner banner--warn" role="status">
        this entry changed elsewhere while you were editing — saving writes only your own edits.
        <button type="button" class="btn btn--xs btn--ghost" @click="reload">
          reload and drop mine
        </button>
      </p>

      <ServerFormFields
        :form="form"
        variant="page"
        :live-bind="server?.bindHost"
      >
        <template #lifecycle>
          <div class="pane">
            <div class="pane__head">
              <span class="pane__title">restart</span>
              <label class="field field--check" style="padding-top: 0">
                <input v-model="form.restart.enabled" type="checkbox">
                <span class="field__label">enabled</span>
              </label>
            </div>
            <div class="pane__body" style="padding: 0.6rem 0.75rem">
              <div class="grid">
                <label class="field">
                  <span class="field__label">max retries</span>
                  <input v-model="form.restart.maxRetries" inputmode="numeric">
                </label>
                <label class="field">
                  <span class="field__label">base delay (ms)</span>
                  <input v-model="form.restart.baseDelayMs" inputmode="numeric">
                </label>
                <label class="field">
                  <span class="field__label">factor</span>
                  <input v-model="form.restart.factor" inputmode="numeric">
                </label>
                <label class="field">
                  <span class="field__label">max delay (ms)</span>
                  <input v-model="form.restart.maxDelayMs" inputmode="numeric">
                </label>
                <label class="field">
                  <span class="field__label">reset after (ms)</span>
                  <input v-model="form.restart.resetAfterMs" inputmode="numeric">
                  <span class="field__hint">alive this long counts as healthy again</span>
                </label>
              </div>
            </div>
          </div>

          <div class="pane">
            <div class="pane__head">
              <span class="pane__title">health</span>
              <label class="field field--check" style="padding-top: 0">
                <input v-model="form.health.enabled" type="checkbox">
                <span class="field__label">enabled</span>
              </label>
              <select v-if="form.health.enabled" v-model="form.health.mode">
                <option value="port">
                  tcp port
                </option>
                <option value="http">
                  http request
                </option>
              </select>
            </div>
            <div class="pane__body" style="padding: 0.6rem 0.75rem">
              <div class="grid">
                <label class="field">
                  <span class="field__label">interval (ms)</span>
                  <input v-model="form.health.intervalMs" inputmode="numeric">
                </label>
                <label class="field">
                  <span class="field__label">timeout (ms)</span>
                  <input v-model="form.health.timeoutMs" inputmode="numeric">
                </label>
                <label class="field">
                  <span class="field__label">unhealthy after</span>
                  <input v-model="form.health.unhealthyThreshold" inputmode="numeric">
                  <span class="field__hint">consecutive failed probes</span>
                </label>
                <label class="field">
                  <span class="field__label">force restart after (ms)</span>
                  <input v-model="form.health.forceRestartAfterMs" inputmode="numeric">
                  <span class="field__hint">0 = never</span>
                </label>
                <label class="field">
                  <span class="field__label">start timeout (ms)</span>
                  <input v-model="form.health.startTimeoutMs" inputmode="numeric">
                  <span class="field__hint">wait for the port after spawn</span>
                </label>
              </div>

              <div v-if="form.health.enabled && form.health.mode === 'http'" class="grid" style="margin-top: 0.5rem">
                <label class="field">
                  <span class="field__label">scheme</span>
                  <select v-model="form.health.http.scheme">
                    <option value="http">http</option>
                    <option value="https">https</option>
                  </select>
                </label>
                <label class="field">
                  <span class="field__label">http path</span>
                  <input v-model="form.health.http.path" placeholder="/healthz">
                </label>
                <label class="field">
                  <span class="field__label">method</span>
                  <select v-model="form.health.http.method">
                    <option value="GET">GET</option>
                    <option value="HEAD">HEAD</option>
                  </select>
                </label>
                <label class="field">
                  <span class="field__label">expect status</span>
                  <input v-model="form.health.http.expectStatus" inputmode="numeric" placeholder="blank = any below">
                </label>
                <label class="field">
                  <span class="field__label">healthy below status</span>
                  <input v-model="form.health.http.expectStatusBelow" inputmode="numeric">
                </label>
                <label v-if="form.health.http.scheme === 'https'" class="field grid__full">
                  <span class="field__label">accept any certificate</span>
                  <input v-model="form.health.http.allowInvalidCert" type="checkbox">
                  <span class="field__hint">for a self-signed backend</span>
                </label>
                <label class="field grid__full">
                  <span class="field__label">body must contain</span>
                  <input v-model="form.health.http.expectBody" placeholder="optional substring">
                  <!--
                    A HEAD carries no response body, so the panel's probe skips this check and the server
                    warns at load (`config/parse.ts`). Said here, where the mistake is made, rather than
                    only on the workspace settings page.
                  -->
                  <span v-if="form.health.http.method === 'HEAD' && form.health.http.expectBody.length > 0" class="field__hint" style="color: var(--warn)">
                    HEAD has no body, so this is ignored — use GET to check it, or clear it.
                  </span>
                </label>
              </div>
            </div>
          </div>

          <div class="pane">
            <div class="pane__head">
              <span class="pane__title">stop</span>
            </div>
            <div class="pane__body" style="padding: 0.6rem 0.75rem">
              <div class="grid">
                <label class="field">
                  <span class="field__label">signal</span>
                  <select v-model="form.stop.signal">
                    <option value="SIGTERM">SIGTERM</option>
                    <option value="SIGINT">SIGINT</option>
                    <option value="SIGKILL">SIGKILL</option>
                  </select>
                </label>
                <label class="field">
                  <span class="field__label">grace (ms)</span>
                  <input v-model="form.stop.graceMs" inputmode="numeric">
                </label>
                <label class="field field--check">
                  <input v-model="form.stop.killGroup" type="checkbox">
                  <span class="field__label">kill the process group</span>
                </label>
                <label class="field field--check">
                  <input v-model="form.stop.killPortHolders" type="checkbox">
                  <span class="field__label">kill port holders</span>
                </label>
              </div>
            </div>
          </div>
        </template>
      </ServerFormFields>

      <div class="group">
        <div class="actions">
          <button type="button" class="btn btn--sm" @click="back">
            cancel
          </button>
          <button type="submit" class="btn btn--sm btn--primary" :disabled="saving">
            save to servers.config.json
          </button>
        </div>
      </div>
    </form>

    <div v-if="configChangesOpen" class="overlay" @click.self="closeChanges">
      <div v-focus-trap class="overlay__panel overlay__panel--sheet" role="dialog" aria-modal="true" aria-label="unsaved server config changes">
        <div class="overlay__head">
          <span class="overlay__title">unsaved changes</span>
          <span class="view__spacer" />
          <span class="faint">writes to servers.config.json</span>
          <kbd class="kbd">esc</kbd>
          <button type="button" class="btn btn--xs btn--ghost" @click="closeChanges">
            close
          </button>
        </div>
        <div class="overlay__body">
          <div v-if="changes.length > 0" class="change-list">
            <div v-for="change in changes" :key="change.path" class="change-row">
              <code class="change-row__path">{{ change.path }}</code>
              <span class="change-row__from">{{ formatChangeValue(change.from) }}</span>
              <span class="change-row__arrow">→</span>
              <span class="change-row__to">{{ formatChangeValue(change.to) }}</span>
            </div>
          </div>
          <p v-else class="empty">
            nothing to save
          </p>
        </div>
        <div class="group">
          <div class="actions">
            <button type="button" class="btn btn--sm" @click="closeChanges">
              close
            </button>
            <button type="button" class="btn btn--sm btn--primary" :disabled="saving || changes.length === 0" @click="saveFromDialog">
              save {{ changes.length }} change{{ changes.length === 1 ? '' : 's' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
