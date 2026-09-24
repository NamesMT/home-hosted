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
    },
  },
)
