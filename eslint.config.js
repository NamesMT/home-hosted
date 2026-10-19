import antfu from '@antfu/eslint-config'

export default antfu(
  {
    type: 'app',

    stylistic: {
      indent: 2,
      quotes: 'single',
    },

    typescript: true,
    vue: true,

    ignores: [
      '.static-data',
      'web/dist',
      'servers.config.schema.json',
    ],
  },
  {
    rules: {
      'style/max-statements-per-line': ['error', { max: 2 }],
      /*
       * A component a template uses but never imports compiles, typechecks and renders as an inert
       * custom element — `SettingsView` shipped four of them and the Notifications section came out
       * empty, with no error anywhere. Only the linter and a mount test see it.
       */
      // The router's two components are registered by the plugin, not imported.
      'vue/no-undef-components': ['error', { ignorePatterns: ['^Router(Link|View)$'] }],
    },
  },
)
