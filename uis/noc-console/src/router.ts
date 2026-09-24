import { createRouter, createWebHistory } from 'vue-router'
import { useSession } from '@/composables/useSession'
import LoginView from '@/views/LoginView.vue'
import LogsView from '@/views/LogsView.vue'
import ServerConfigView from '@/views/ServerConfigView.vue'
import ServersView from '@/views/ServersView.vue'
import SettingsView from '@/views/SettingsView.vue'
import VitalsView from '@/views/VitalsView.vue'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'servers', component: ServersView },
    { path: '/servers/:id/config', name: 'server-config', component: ServerConfigView, props: true },
    { path: '/logs', name: 'logs', component: LogsView },
    { path: '/vitals', name: 'vitals', component: VitalsView },
    { path: '/settings', name: 'settings', component: SettingsView },
    { path: '/login', name: 'login', component: LoginView },
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
    return { name: 'login' }
  if (to.name === 'login' && (!required || authenticated))
    return { name: 'servers' }
  return true
})
