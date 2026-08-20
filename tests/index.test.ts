import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.js'
import type { Config } from '../src/index.js'
import { Session } from '../src/session.js'
import { FakeHosts, FakePool } from './p4-fakes.js'

const CONFIG: Config = {
  hostKeyPolicy: 'accept-new',
  knownHostsPath: '',
  commandTimeoutMs: 30000,
  connectTimeoutMs: 15000,
  maxOutputChars: 200000,
}

interface CapturedSection {
  name: string
  order: number
  text: () => string
}

/** Hand-built cordis Context stand-in: registries capture, effects collect. */
function makeCtx() {
  const tools: { name: string }[] = []
  const routes: { kind: string; path: string }[] = []
  const commands: { name: string; handler: () => { kind: string; text: string } }[] = []
  let section: CapturedSection | undefined
  const effectDisposers: (() => void)[] = []
  const effectLabels: string[] = []

  const remove = <T>(list: T[], item: T): void => {
    const i = list.indexOf(item)
    if (i >= 0) list.splice(i, 1)
  }

  const ctx = {
    tools: {
      register(t: { name: string }) {
        tools.push(t)
        return () => remove(tools, t)
      },
    },
    webServer: {
      register(r: { kind: string; path: string }) {
        routes.push(r)
        return () => remove(routes, r)
      },
    },
    systemPrompt: {
      section(s: CapturedSection) {
        section = s
        return () => {
          section = undefined
        }
      },
    },
    get(name: string): unknown {
      if (name === 'commands') {
        return {
          register(c: (typeof commands)[number]) {
            commands.push(c)
            return () => remove(commands, c)
          },
        }
      }
      return undefined // no directoryPicker in this context
    },
    /** No settings service in this context: the inject callback never fires. */
    inject(): unknown {
      return undefined
    },
    /** Middleware registrations are captured nowhere; the disposer is a no-op. */
    on(): () => void {
      return () => {}
    },
    effect(fn: () => (() => void) | void, label?: string) {
      effectLabels.push(label ?? '')
      const dispose = fn()
      if (typeof dispose === 'function') effectDisposers.push(dispose)
      return () => {}
    },
  }
  return { ctx, tools, routes, commands, effectDisposers, effectLabels, getSection: () => section }
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-rw-index-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function makeOverrides() {
  const hosts = new FakeHosts()
  const pool = new FakePool()
  const session = new Session(join(dir, 'session.json'))
  return { hosts, pool, session, placeholderBaseDir: join(dir, 'placeholders') }
}

describe('apply', () => {
  it('registers the twelve rw_* tools, the six routes, and the /rw command', () => {
    const { ctx, tools, routes, commands, effectLabels } = makeCtx()
    apply(ctx as unknown as Context, CONFIG, makeOverrides())

    expect(tools.map((t) => t.name)).toEqual([
      'rw_info',
      'rw_hosts',
      'rw_connect',
      'rw_pick_workspace',
      'rw_list_dir',
      'rw_read_file',
      'rw_write_file',
      'rw_mkdir',
      'rw_move',
      'rw_delete',
      'rw_exec',
      'rw_disconnect',
    ])
    expect(routes.map((r) => r.path)).toEqual([
      '/api/dsh-rw/status',
      '/api/dsh-rw/hosts',
      '/api/dsh-rw/test',
      '/api/dsh-rw/ls',
      '/api/dsh-rw/workspace',
      '/api/dsh-rw/local-pick',
    ])
    expect(routes.every((r) => r.kind === 'exact')).toBe(true)
    expect(commands.map((c) => c.name)).toEqual(['rw'])
    expect(effectLabels).toEqual(['dsh-rw: surfaces', 'dsh-rw: prompt', 'dsh-rw: pool'])
  })

  it('the prompt section tracks the session (guidance → active workspace)', () => {
    const { ctx, getSection } = makeCtx()
    const overrides = makeOverrides()
    apply(ctx as unknown as Context, CONFIG, overrides)

    const section = getSection()
    expect(section).toBeDefined()
    expect(section?.name).toBe('dsh-rw')
    expect(section?.order).toBe(88)

    const idle = section!.text()
    expect(idle).toContain('No remote workspace is active')
    expect(idle).toContain('rw_hosts')
    expect(idle).toContain('rw_pick_workspace')

    overrides.session.set({ alias: 'prod', workspace: '/srv/app' })
    const active = section!.text()
    expect(active).toContain('Current remote workspace: deploy@example.com:22:/srv/app')
    expect(active).toContain('confined to the workspace root')
  })

  it('the prompt section steers to native tools while shim is on', () => {
    const { ctx, getSection } = makeCtx()
    const overrides = makeOverrides()
    apply(ctx as unknown as Context, { ...CONFIG, shim: true }, overrides)
    overrides.session.set({ alias: 'prod', workspace: '/srv/app' })

    const active = getSection()!.text()
    expect(active).toContain('Current remote workspace: deploy@example.com:22:/srv/app')
    expect(active).toContain('remote-backed')
    expect(active).toContain('read/write/edit/str_replace_editor/glob/grep/bash')
    expect(active).toContain('as if the workspace were local')
    // rw_* stays mentioned as the explicit path, but is no longer the steering.
    expect(active).toContain('rw_exec')
  })

  it('the /rw command renders the live status without credentials', () => {
    const { ctx, commands } = makeCtx()
    const overrides = makeOverrides()
    apply(ctx as unknown as Context, CONFIG, overrides)
    overrides.session.set({ alias: 'prod', workspace: '/srv/app' })
    overrides.pool.connectedAliases.add('prod')

    const result = commands[0]!.handler()
    expect(result.kind).toBe('success')
    expect(result.text).toContain('Current host: deploy@example.com:22 (alias: prod)')
    expect(result.text).toContain('Connected: yes')
    expect(result.text).toContain('Current workspace: /srv/app')
    expect(result.text).not.toContain('t0p-secret-pw')
  })

  it('disposers unregister every surface and dispose the pool', () => {
    const { ctx, tools, routes, commands, effectDisposers, getSection } = makeCtx()
    const overrides = makeOverrides()
    apply(ctx as unknown as Context, CONFIG, overrides)
    expect(tools.length).toBe(12)
    expect(routes.length).toBe(6)

    for (const dispose of effectDisposers) dispose()
    expect(tools).toEqual([])
    expect(routes).toEqual([])
    expect(commands).toEqual([])
    expect(getSection()).toBeUndefined()
    expect(overrides.pool.disposed).toBe(true)
  })
})
