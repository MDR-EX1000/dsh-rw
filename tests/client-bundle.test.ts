// P5 — client bundle smoke test: build src/client/index.tsx with
// build-client.mjs, execute lib/client.js in Node against a fake
// window.__ModuleLoader__, and verify the plugin contract ({ name, apply })
// plus the two directoryFlow slot registrations.
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))

interface LoaderEntry {
  id: string
  factory: (require: (id: string) => unknown) => { name?: unknown; apply?: unknown }
}

interface Registration {
  name: string
  id: string
  priority: number
  component: unknown
}

let entry: LoaderEntry | undefined

beforeAll(() => {
  execSync('node build-client.mjs', { cwd: root, stdio: 'pipe' })
  const code = readFileSync(join(root, 'lib/client.js'), 'utf8')
  const g = globalThis as Record<string, unknown>
  const prevWindow = g['window']
  g['window'] = {
    __ModuleLoader__: {
      load: (e: LoaderEntry) => {
        entry = e
      },
    },
  }
  try {
    new Function(code)()
  } finally {
    if (prevWindow === undefined) delete g['window']
    else g['window'] = prevWindow
  }
})

/** Execute the bundle factory with stub externals (react & co. are inert). */
function loadModule(): { name?: unknown; apply?: unknown } {
  if (!entry) throw new Error('bundle did not call window.__ModuleLoader__.load')
  const requireStub = (id: string): unknown => {
    if (id === 'react' || id === 'react-dom' || id === 'react-dom/client' || id === 'react/jsx-runtime') return {}
    throw new Error(`unexpected require: ${id}`)
  }
  return entry.factory(requireStub)
}

const isIterable = (x: unknown): x is Iterable<unknown> => typeof x === 'object' && x !== null && Symbol.iterator in x

/** Fake ctx whose slots service captures every register() call. */
function makeCtx(registrations: Registration[]): { get: (key: string) => unknown } {
  const slots = {
    inject(_slot: string, factory: () => unknown): void {
      const result = factory()
      // Drain generator factories so the yielded register() calls fire.
      if (isIterable(result)) for (const _ of result) void _
    },
    register(meta: { name: string; id: string; priority: number }, component: unknown): void {
      registrations.push({ ...meta, component })
    },
  }
  return { get: (key: string) => (key === 'slots' ? slots : undefined) }
}

describe('client bundle', () => {
  it('registers itself with __ModuleLoader__ under id dsh-rw', () => {
    expect(entry).toBeDefined()
    expect(entry!.id).toBe('dsh-rw')
    expect(typeof entry!.factory).toBe('function')
  })

  it('factory returns { name: "dsh-rw", apply: function }', () => {
    const mod = loadModule()
    expect(mod.name).toBe('dsh-rw')
    expect(typeof mod.apply).toBe('function')
  })

  it('apply registers DirPicker into both directoryFlow slots at priority -100', () => {
    const mod = loadModule()
    const registrations: Registration[] = []
    ;(mod.apply as (ctx: unknown) => void)(makeCtx(registrations))
    expect(registrations.map((r) => r.name).sort()).toEqual([
      'conversation.hero.workspace.directoryFlow',
      'sidebar.workspaces.directoryFlow',
    ])
    for (const r of registrations) {
      expect(r.id).toBe('dsh-rw')
      expect(r.priority).toBe(-100)
      expect(typeof r.component).toBe('function')
    }
  })

  it('apply no-ops when the ctx has no slots service', () => {
    const mod = loadModule()
    const apply = mod.apply as (ctx: unknown) => void
    expect(() => apply({ get: () => undefined })).not.toThrow()
    expect(() => apply({})).not.toThrow()
    expect(() => apply(null)).not.toThrow()
    expect(() => apply(undefined)).not.toThrow()
  })
})
