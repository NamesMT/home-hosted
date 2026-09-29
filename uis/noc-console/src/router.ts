import { createRouter, createWebHistory } from 'vue-router'
import { useControlPlane } from '@/composables/useControlPlane'
import { useSession } from '@/composables/useSession'
import { useWorkspaces } from '@/composables/useWorkspaces'
import GlobalOverviewView from '@/views/GlobalOverviewView.vue'
import GlobalSettingsView from '@/views/GlobalSettingsView.vue'
import LoginView from '@/views/LoginView.vue'
import LogsView from '@/views/LogsView.vue'
import ServerConfigView from '@/views/ServerConfigView.vue'
import ServersView from '@/views/ServersView.vue'
import SettingsView from '@/views/SettingsView.vue'

/** Pages that read the workspace in the URL. */
const WORKSPACE_ROUTES = new Set(['servers', 'server-config', 'logs', 'settings'])

export type WorkspacePage = 'servers' | 'logs' | 'settings'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    // The workspace is part of the URL, so any page can be bookmarked or shared.
    { path: '/w/:workspaceId/servers', name: 'servers', component: ServersView },
    { path: '/w/:workspaceId/servers/:id/config', name: 'server-config', component: ServerConfigView, props: true },
    { path: '/w/:workspaceId/logs', name: 'logs', component: LogsView },
    { path: '/w/:workspaceId/settings', name: 'settings', component: SettingsView },
    { path: '/global/overview', name: 'global-overview', component: GlobalOverviewView },
    { path: '/global/settings', name: 'global-settings', component: GlobalSettingsView },
    { path: '/login', name: 'login', component: LoginView },
    // The pre-workspace URLs, the bare entries, and anything unknown land on the
    // canonical URL the guard picks, so an old bookmark keeps working.
    { path: '/', name: 'home', component: GlobalOverviewView },
    { path: '/servers', name: 'legacy-servers', component: ServersView },
    { path: '/servers/:id/config', name: 'legacy-server-config', component: ServerConfigView, props: true },
    { path: '/logs', name: 'legacy-logs', component: LogsView },
    { path: '/vitals', name: 'legacy-vitals', component: GlobalOverviewView },
    { path: '/settings', name: 'legacy-settings', component: SettingsView },
    { path: '/global', name: 'legacy-global', component: GlobalOverviewView },
    { path: '/global-settings', name: 'legacy-global-settings', component: GlobalSettingsView },
    { path: '/:pathMatch(.*)*', name: 'not-found', component: GlobalOverviewView },
  ],
})

/**
 * Where a workspace page lives. One helper, so a link can never point at a
 * version of the page that is not the one the URL says.
 */
export function workspacePath(workspaceId: string, page: WorkspacePage = 'servers', serverId?: string): string {
  const base = `/w/${encodeURIComponent(workspaceId)}`
  if (page === 'servers')
    return serverId === undefined ? `${base}/servers` : `${base}/servers/${encodeURIComponent(serverId)}/config`
  return `${base}/${page}`
}

/**
 * The workspace is part of the URL, so a page can be bookmarked and shared. A
 * request without one (or with an id that no longer exists) is rewritten to the
 * canonical `/w/<id>/…` URL rather than silently rendered from a stored value.
 * The bare root is the panel-wide overview, not a workspace.
 */
router.beforeEach(async (to) => {
  const { session, refresh } = useSession()
  if (session.value === null)
    await refresh()

  const required = session.value?.authRequired === true
  const authenticated = session.value?.authenticated === true

  if (required && !authenticated && to.name !== 'login')
    return { name: 'login', query: to.fullPath === '/' ? undefined : { next: to.fullPath } }
  if (to.name === 'login' && (!required || authenticated))
    return { name: 'global-overview', replace: true }

  if (to.name === 'login')
    return true
  if (to.name === 'global-overview' || to.name === 'global-settings')
    return true
  if (to.name === 'legacy-global')
    return { name: 'global-overview', query: to.query, replace: true }
  if (to.name === 'legacy-global-settings')
    return { name: 'global-settings', query: to.query, replace: true }
  // `/`, `/vitals` and anything unrecognized open the panel-wide overview.
  if (to.name === 'home' || to.name === 'not-found' || to.name === 'legacy-vitals')
    return { name: 'global-overview', replace: true }

  // The frame decides which ids exist, so a deep link waits for it once.
  const control = useControlPlane()
  await control.ensureState()
  const workspace = useWorkspaces()
  const list = workspace.workspaces.value
  if (list.length === 0)
    return true

  const requested = typeof to.params.workspaceId === 'string' ? to.params.workspaceId : ''
  if (requested.length > 0 && list.some(entry => entry.id === requested)) {
    workspace.select(requested)
    if (WORKSPACE_ROUTES.has(String(to.name)))
      return true
  }

  const id = workspace.activeId.value || list[0]!.id
  const base = String(to.name ?? '').replace(/^legacy-/, '')
  const name = WORKSPACE_ROUTES.has(base) ? base : 'servers'
  const params: Record<string, string> = { ...(to.params as Record<string, string>), workspaceId: id }
  return { name, params, query: to.query, replace: true }
})
