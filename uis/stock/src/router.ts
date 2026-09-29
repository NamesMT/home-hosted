import { createRouter, createWebHistory } from 'vue-router'
import { useControlPlane } from '@/composables/useControlPlane'
import { useSession } from '@/composables/useSession'
import { useWorkspaces } from '@/composables/useWorkspaces'
import GlobalOverviewView from '@/views/GlobalOverviewView.vue'
import GlobalSettingsView from '@/views/GlobalSettingsView.vue'
import LoginView from '@/views/LoginView.vue'
import LogsView from '@/views/LogsView.vue'
import OverviewView from '@/views/OverviewView.vue'
import ServerDetailView from '@/views/ServerDetailView.vue'
import ServersView from '@/views/ServersView.vue'
import SettingsView from '@/views/SettingsView.vue'

/** Pages that read the workspace in the URL. */
const WORKSPACE_ROUTES = new Set(['overview', 'servers', 'server-detail', 'logs', 'settings'])

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    // The workspace is part of the URL, so any page can be bookmarked or shared.
    { path: '/w/:workspaceId', name: 'overview', component: OverviewView, meta: { title: 'Overview' } },
    { path: '/w/:workspaceId/servers', name: 'servers', component: ServersView, meta: { title: 'Servers' } },
    { path: '/w/:workspaceId/servers/:id', name: 'server-detail', component: ServerDetailView, meta: { title: 'Server' } },
    { path: '/w/:workspaceId/logs', name: 'logs', component: LogsView, meta: { title: 'Logs' } },
    { path: '/w/:workspaceId/settings', name: 'settings', component: SettingsView, meta: { title: 'Workspace settings' } },
    { path: '/global/overview', name: 'global-overview', component: GlobalOverviewView, meta: { title: 'Global Overview' } },
    { path: '/global/settings', name: 'global-settings', component: GlobalSettingsView, meta: { title: 'Global settings' } },
    { path: '/login', name: 'login', component: LoginView, meta: { title: 'Sign in' } },
    // The pre-workspace URLs, the bare entries, and anything unknown land on the
    // canonical URL the guard picks, so an old bookmark keeps working.
    { path: '/', name: 'home', component: OverviewView },
    { path: '/servers', name: 'legacy-servers', component: ServersView },
    { path: '/servers/:id', name: 'legacy-server-detail', component: ServerDetailView },
    { path: '/logs', name: 'legacy-logs', component: LogsView },
    { path: '/settings', name: 'legacy-settings', component: SettingsView },
    { path: '/global', name: 'legacy-global', component: GlobalOverviewView },
    { path: '/global-settings', name: 'legacy-global-settings', component: GlobalSettingsView },
    { path: '/:pathMatch(.*)*', name: 'not-found', component: OverviewView },
  ],
})

/**
 * Where a workspace page lives. One helper, so a link can never point at a
 * version of the page that is not the one the URL says.
 */
export function workspacePath(workspaceId: string, page: 'overview' | 'servers' | 'logs' | 'settings' = 'overview', serverId?: string): string {
  const base = `/w/${encodeURIComponent(workspaceId)}`
  if (page === 'overview')
    return base
  if (page === 'servers')
    return serverId === undefined ? `${base}/servers` : `${base}/servers/${encodeURIComponent(serverId)}`
  return `${base}/${page}`
}

/**
 * The workspace is part of the URL, so a page can be bookmarked and shared. A
 * request without one (or with an id that no longer exists) is rewritten to the
 * canonical `/w/<id>/…` URL rather than silently rendered from a stored value.
 * The bare root is the panel-wide view, not a workspace.
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
  // `/` and anything unrecognized open the panel-wide overview.
  if (to.name === 'home' || to.name === 'not-found')
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
  // A legacy `/servers/:id` names a server, not a workspace; keep the server.
  const name = base === 'server-detail' || (base === 'servers' && 'id' in to.params) ? 'server-detail' : (WORKSPACE_ROUTES.has(base) ? base : 'overview')
  const params: Record<string, string> = { ...(to.params as Record<string, string>), workspaceId: id }
  if (name === 'server-detail' && params.id === undefined)
    return { name: 'servers', params: { workspaceId: id }, query: to.query, replace: true }
  return { name, params, query: to.query, replace: true }
})
