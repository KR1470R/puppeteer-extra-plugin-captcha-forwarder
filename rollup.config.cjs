const resolve = require('rollup-plugin-node-resolve')
const sourceMaps = require('rollup-plugin-sourcemaps')
const typescript = require('rollup-plugin-typescript2')
const json = require('@rollup/plugin-json')

const pkg = require('./package.json')

const entryFile = 'index'
const banner = `
/*!
 * ${pkg.name} v${pkg.version} by ${pkg.author}
 * ${pkg.homepage || `https://github.com/${pkg.repository}`}
 * @license ${pkg.license}
 */
`.trim()

const defaultExportOutro = `
  module.exports = exports.default || {}
  Object.entries(exports).forEach(([key, value]) => { module.exports[key] = value })
`

module.exports = {
  input: `src/${entryFile}.ts`,
  output: [
    {
      file: pkg.main,
      format: 'cjs',
      sourcemap: true,
      exports: 'named',
      outro: defaultExportOutro,
      banner
    },
    {
      file: pkg.module,
      format: 'es',
      sourcemap: true,
      exports: 'named',
      banner
    }
  ],
  external: [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.peerDependencies || {})
  ],
  watch: {
    include: 'src/**'
  },
  plugins: [
    json(), // <-- REQUIRED FIX for JSON import
    typescript({ useTsconfigDeclarationDir: true }),
    resolve(),
    sourceMaps()
  ]
}