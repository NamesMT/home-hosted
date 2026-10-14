import { createApp } from 'vue'
import App from './App.vue'
import { initLocale } from './i18n'
import { router } from './router'
import './styles.css'

/**
 * The catalog for the chosen language is a lazily-imported chunk, so it lands before mount: that is
 * what keeps a reload from flashing English at someone who reads Japanese.
 *
 * The mount is in `finally` on purpose. English is bundled, so every failure here is survivable,
 * while a rejection that skipped the mount would leave a blank page and no way back — the one
 * outcome worth more than a translated first frame. (`.then` rather than a top-level `await`
 * because the repo forbids one at module scope.)
 */
void initLocale()
  .catch(() => {
    // Already handled in `initLocale`; this is the belt to that braces, so a future edit there
    // cannot turn a missing chunk into a blank page.
  })
  .finally(() => {
    createApp(App).use(router).mount('#app')
  })
