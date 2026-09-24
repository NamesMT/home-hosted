import { createRouter, createWebHistory } from 'vue-router'
import { useSession } from '@/composables/useSession'
import LoginView from '@/views/LoginView.vue'
import LogsView from '@/views/LogsView.vue'
import OverviewView from '@/views/OverviewView.vue'
import ServerDetailView from '@/views/ServerDetailView.vue'
import ServersView from '@/views/ServersView.vue'
import SettingsView from '@/views/SettingsView.vue'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'overview', component: OverviewView, meta: { title: 'Overview' } },
    { path: '/servers', name: 'servers', component: ServersView, meta: { title: 'Servers' } },
    { path: '/servers/:id', name: 'server-detail', component: ServerDetailView, meta: { title: 'Server' } },
    { path: '/logs', name: 'logs', component: LogsView, meta: { title: 'Logs' } },
    { path: '/settings', name: 'settings', component: SettingsView, meta: { title: 'Settings' } },
    { path: '/login', name: 'login', component: LoginView, meta: { title: 'Sign in' } },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})

/** The SPA is public; every view behind it needs a session when auth is on. */
router.beforeEach(async (to) => {
  const { session, refresh } = useSession()
  if (session.value === null)
    await refresh()

  const required = session.value?.authRequired === true
  const authenticated = session.value?.authenticated === true

  if (required && !authenticated && to.name !== 'login')
    return { name: 'login', query: to.fullPath === '/' ? undefined : { next: to.fullPath } }
  if (to.name === 'login' && (!required || authenticated))
    return { name: 'overview' }
  return true
})
