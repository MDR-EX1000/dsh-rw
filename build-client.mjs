// Build the browser half: src/client/index.tsx → lib/client.js.
//
// DSH client entries must be classic scripts registered through
// window.__ModuleLoader__.load({ id, factory }) where the factory receives a
// synchronous `require` (react / react-dom are provided by the harness — never
// bundled). We therefore bundle with esbuild as an IIFE, externalize react,
// and wrap the result in the loader envelope.
import { build } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.join(root, 'lib')
mkdirSync(outDir, { recursive: true })

await build({
  entryPoints: [path.join(root, 'src/client/index.tsx')],
  bundle: true,
  format: 'iife',
  // Expose the entry's ESM exports as a global we can copy onto module.exports.
  globalName: '__DshRwClientExports',
  platform: 'browser',
  target: 'es2020',
  jsx: 'automatic',
  // Provided by the DSH runtime's synchronous require.
  external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
  outfile: path.join(outDir, 'client.tmp.js'),
  logLevel: 'silent',
})

const body = readFileSync(path.join(outDir, 'client.tmp.js'), 'utf8')
const wrapped =
  `window.__ModuleLoader__.load({\n` +
  `\tid: "dsh-rw",\n` +
  `\tfactory: (require) => {\n` +
  `\t\tvar module = { exports: {} };\n` +
  `\t\tvar exports = module.exports;\n` +
  `\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });\n` +
  body +
  `\t\tObject.assign(module.exports, __DshRwClientExports);\n` +
  `\t\treturn module.exports;\n` +
  `\t},\n` +
  `});\n`
writeFileSync(path.join(outDir, 'client.js'), wrapped)

// esbuild leaves requires as-is; the IIFE body references the outer `require`
// for externals, which resolves to the factory argument. Clean up the tmp.
const { rmSync } = await import('node:fs')
rmSync(path.join(outDir, 'client.tmp.js'))
console.log('lib/client.js written')
