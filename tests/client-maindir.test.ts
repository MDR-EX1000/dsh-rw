// 2.0.0 — the picker's per-host main directory helpers: where a host lands
// when it is selected, and which main-directory actions a host row offers.
import { describe, expect, it } from 'vitest'
import { effectiveMainDirOf, hostStartPath, mainDirActions, mainDirOf } from '../src/client/index.js'

describe('mainDirOf / hostStartPath', () => {
  it('lands on the main directory when one is set', () => {
    expect(mainDirOf({ mainDir: '/data' })).toBe('/data')
    expect(hostStartPath({ mainDir: '/data' })).toBe('/data')
  })

  it('falls back to the remote home without a usable main directory', () => {
    for (const host of [undefined, null, {}, { mainDir: '' }, { mainDir: '   ' }]) {
      expect(mainDirOf(host)).toBe('')
      expect(hostStartPath(host)).toBe('~/')
    }
  })

  it('uses the plugin-wide default for hosts without their own main directory', () => {
    expect(effectiveMainDirOf({}, '/')).toBe('/')
    expect(hostStartPath({}, '/')).toBe('/')
    expect(hostStartPath({ mainDir: '/' }, '/data')).toBe('/')
    // The host's own setting wins over the default.
    expect(effectiveMainDirOf({ mainDir: '/srv' }, '/')).toBe('/srv')
    // An empty default means none.
    expect(effectiveMainDirOf({}, '')).toBe('')
    expect(hostStartPath({}, '  ')).toBe('~/')
    // The default is not the host's own setting (nothing to clear).
    expect(mainDirOf({})).toBe('')
  })
})

describe('mainDirActions', () => {
  const freedom = { alias: 'freedom', mainDir: '/data' }
  const docker = { alias: 'docker' }

  it('offers "set" only on the selected host, for a non-empty path that differs from the main', () => {
    expect(mainDirActions(docker, 'docker', '/data').canSet).toBe(true)
    expect(mainDirActions(docker, 'freedom', '/data').canSet).toBe(false)
    expect(mainDirActions(docker, 'docker', '   ').canSet).toBe(false)
    expect(mainDirActions(freedom, 'freedom', '/data/CODE').canSet).toBe(true)
  })

  it('treats trailing slashes as the same path', () => {
    expect(mainDirActions(freedom, 'freedom', '/data/').canSet).toBe(false)
    expect(mainDirActions(freedom, 'freedom', ' /data ').canSet).toBe(false)
  })

  it('offers "clear" whenever the host has a main directory, selected or not', () => {
    expect(mainDirActions(freedom, 'docker', '').canClear).toBe(true)
    expect(mainDirActions(docker, 'docker', '/data').canClear).toBe(false)
  })
})
