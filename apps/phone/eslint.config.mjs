import cozyReact from 'eslint-config-cozy-app/react'

export default [
  ...cozyReact,
  {
    // Workspace packages of the monorepo, aliased to their build output by rsbuild/jest rather than installed.
    settings: {
      'import/core-modules': [
        '@twake/softphone',
        '@twake/telephony-client',
        '@twake/telephony-types',
        '@twake/phone-link',
        '@twake/phone-widget'
      ]
    }
  },
  {
    // Node scripts that drive a browser or the stack: their output is the console, and their timers are plain.
    files: ['test/**/*.mjs'],
    rules: { 'no-console': 'off', 'promise/param-names': 'off' }
  }
]
