import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.js'

describe('client locales', () => {
  it('keeps the English and Chinese dictionaries key-for-key balanced', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('ships English copy for the complete workspace and host flows', () => {
    expect(en.chooseWorkDirectory).toBe('Choose a work directory')
    expect(en.localCardTitle).toBe('LOCAL')
    expect(en.remoteCardTitle).toBe('REMOTE')
    expect(en.localDirectory).toBe('Local directory')
    expect(en.remoteWorkspace).toBe('Remote workspace')
    expect(en.addRemoteHost).toBe('Add remote host')
    expect(en.testConnection).toBe('Test connection')
    expect(en.setRemoteWorkspace).toBe('Use as remote workspace')
  })

  it('ships the per-host main directory copy in both languages', () => {
    for (const key of ['badgeMainDir', 'mainDirLine', 'setMainDir', 'clearMainDir', 'mainDirSaving', 'mainDirFailed', 'openMainWorkspace'] as const) {
      expect(en[key].length).toBeGreaterThan(0)
      expect(zh[key].length).toBeGreaterThan(0)
    }
    // Path-bearing strings must keep their placeholder so the path is shown.
    for (const key of ['mainDirLine', 'setMainDir', 'clearMainDir', 'openMainWorkspace'] as const) {
      expect(en[key]).toContain('{path}')
      expect(zh[key]).toContain('{path}')
    }
  })
})
