// Capture/validate the shipped Native bash definition in an isolated process.
// It never executes the Native tool, starts a shell, opens SSH, or mounts a profile.
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const install = process.env.DSH_INSTALL_DIR
if (!install) throw new Error('DSH_INSTALL_DIR is required for the installed Native contract')
if (install.includes('app.asar') && !process.versions.electron) throw new Error('ASAR contracts require the verified Electron runtime')
const req = createRequire(join(install, 'package.json'))
const nativePath = req.resolve('@deepseek-ai/dsh-tool-bash')
const native = await import(pathToFileURL(nativePath).href)
const tools = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-tools')).href)
const manifestPath = req.resolve('@deepseek-ai/dsh-tool-bash/package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
let definition
let executionAttempts = 0
const forbidden = () => { executionAttempts++; throw new Error('Native execution is forbidden in a contract fixture') }
const ctx = {
  shell: { sandboxMode: undefined, execute: forbidden, resolve: forbidden },
  jobs: { start: forbidden },
  systemPrompt: { section: () => () => {}, getSectionOrder: () => 0 },
  tools: { register: (tool) => { definition = tool; return () => {} } },
  get: (name) => name === 'jobs' ? ctx.jobs : undefined,
  inject: (_deps, callback) => callback(ctx),
  effect: (callback) => { callback(); return () => {} },
  fiber: { state: 'active' },
}
native.apply(ctx, { enableRunInBackground: true, promoteOnTimeout: true })
if (!definition || definition.name !== 'bash') throw new Error('Native bash definition was not captured')
if (executionAttempts !== 0) throw new Error('unexpected Native side effect')
const contract = { nativeVersion: manifest.version, nativePackageDir: dirname(manifestPath),
  parameters: definition.parameters, outputSchema: definition.output.schema, executionAttempts }
const mode = process.argv[2] ?? 'capture'
if (mode === 'capture') {
  console.log(JSON.stringify(contract))
} else if (mode === 'validate') {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  const values = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!Array.isArray(values)) throw new Error('expected an array of candidate values')
  console.log(JSON.stringify({ nativeVersion: contract.nativeVersion, executionAttempts,
    results: values.map(value => {
      const errors = tools.validateJsonSchemaValue(definition.output.schema, value, 'value')
      return { errors, ...(errors.length === 0 ? { presentationMeta: definition.output.presentationMeta?.({}, value) } : {}) }
    }) }))
} else throw new Error('unsupported contract fixture mode')
