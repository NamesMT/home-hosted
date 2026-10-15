import { createApp } from 'vue'
import App from './App.vue'
import { initLocale } from './i18n'
import { router } from './router'
import './styles.css'

/**
 * The chosen language's catalog is a lazy chunk, so it lands before mount — that is what keeps a
 * reload from flashing English at someone who reads Japanese.
 *
 * The mount sits in `finally` because English is bundled: every failure here is survivable, while a
 * rejection that skipped the mount would leave a blank page and no way back.
 */
void initLocale()
  .catch(() => {
    // Already handled in `initLocale`; this is the belt to that braces, so a future edit there
    // cannot turn a missing chunk into a blank page.
  })
  .finally(() => {
    createApp(App).use(router).mount('#app')
  })
