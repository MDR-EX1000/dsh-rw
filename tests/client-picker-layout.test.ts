// Static source contracts only: no React invocation, DOM emulation, browser,
// client-bundle build, or lib writes. Actual scrolling/focus still needs GUI QA.
import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.js'

const text = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
const source = ts.createSourceFile('index.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
type Opening = ts.JsxOpeningElement | ts.JsxSelfClosingElement

function nodes<T extends ts.Node>(matches: (node: ts.Node) => node is T): T[] {
  const result: T[] = []
  const visit = (node: ts.Node) => {
    if (matches(node)) result.push(node)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return result
}

const openings = nodes((node): node is Opening => ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))

function attr(node: Opening, name: string): string | undefined {
  const value = node.attributes.properties.find((item): item is ts.JsxAttribute => ts.isJsxAttribute(item) && item.name.getText(source) === name)?.initializer
  if (!value) return undefined
  if (ts.isStringLiteral(value)) return value.text
  if (ts.isJsxExpression(value)) return value.expression?.getText(source)
  return value.getText(source)
}

function marked(name: string): Opening {
  const matches = openings.filter((node) => attr(node, 'data-dsh-rw') === name)
  expect(matches, `unique picker marker ${name}`).toHaveLength(1)
  return matches[0]!
}

function initializer(name: string): ts.Expression {
  const matches = nodes(ts.isVariableDeclaration).filter((node) => node.name.getText(source) === name)
  expect(matches, `unique variable ${name}`).toHaveLength(1)
  expect(matches[0]!.initializer).toBeDefined()
  return matches[0]!.initializer!
}

function style(name: string): Record<string, string> {
  const object = initializer(name)
  if (!ts.isObjectLiteralExpression(object)) throw new Error(`${name} must remain a static style object`)
  const values: Record<string, string> = {}
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) throw new Error(`unexpected dynamic style in ${name}`)
    values[property.name.getText(source)] = ts.isStringLiteral(property.initializer) ? property.initializer.text : property.initializer.getText(source)
  }
  return values
}

function inside(child: Opening, parent: Opening): boolean {
  const owner = parent.parent
  if (!ts.isJsxElement(owner)) throw new Error('expected a paired JSX container')
  return child.getStart(source) > parent.getStart(source) && child.end < owner.end
}

function functionText(name: string): string {
  const matches = nodes(ts.isFunctionDeclaration).filter((node) => node.name?.text === name)
  expect(matches).toHaveLength(1)
  return matches[0]!.getText(source)
}

describe('picker layout and keyboard static contracts', () => {
  it('bounds the panel to the viewport and lets only the body shrink', () => {
    expect(attr(marked('picker-overlay'), 'style')).toBe('pickerOverlayS')
    expect(style('pickerOverlayS')).toMatchObject({ position: 'fixed', padding: '16', boxSizing: 'border-box' })
    expect(attr(marked('picker-panel'), 'style')).toBe('pickerPanelS')
    expect(style('pickerPanelS')).toMatchObject({
      maxHeight: 'calc(100dvh - 32px)', width: 'min(640px, 100%)', maxWidth: '100%',
      display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: '0', boxSizing: 'border-box',
    })
    expect(style('pickerBodyS')).toMatchObject({ flex: '1 1 auto', minHeight: '0', minWidth: '0', overflowY: 'auto' })
    expect(style('pickerHeaderS').flexShrink).toBe('0')
    expect(style('pickerFooterS')).toMatchObject({ flexShrink: '0', flexWrap: 'wrap', maxHeight: '40dvh', overflowY: 'auto', minHeight: '0' })
    expect(style('footerButtonS')).toMatchObject({ maxWidth: '100%', whiteSpace: 'normal', overflowWrap: 'anywhere' })
  })

  it('keeps header and all view actions outside the scrolling body', () => {
    const panel = marked('picker-panel')
    const body = marked('picker-body')
    for (const name of ['picker-header', 'picker-body', 'picker-footer']) expect(inside(marked(name), panel)).toBe(true)
    expect(inside(marked('picker-header'), body)).toBe(false)
    expect(inside(marked('picker-footer'), body)).toBe(false)
    const footer = marked('picker-footer').parent.getText(source)
    for (const action of ['onCancel', 'commitPath(selectedMainDir)', 'commitPath(path)', 'resetAddForm', 'testNewHost', 'saveNewHost']) {
      expect(footer).toContain(action)
    }
    expect(footer).toContain("t('openMainWorkspaceButton')")
    expect(footer).toContain("title={t('openMainWorkspace', { path: selectedMainDir })}")
  })

  it('caps host rows independently without shrinking away their contents', () => {
    expect(attr(marked('host-list'), 'style')).toBe('hostListS')
    expect(style('hostListS')).toMatchObject({ maxHeight: 'min(220px, 28dvh)', minHeight: '0', overflowY: 'auto', scrollbarGutter: 'stable' })
    const hostCard = functionText('HostCard')
    expect(hostCard).toContain('flexShrink: 0')
    expect(hostCard).toContain("flexWrap: 'wrap'")
    // Enter on a nested test/remove button must not also select the host row.
    expect(hostCard).toContain('e.target === e.currentTarget')
  })

  it('makes both directory areas focusable native scroll regions', () => {
    for (const name of ['remote-directory-list', 'local-directory-list']) {
      const region = marked(name)
      expect(attr(region, 'role')).toBe('region')
      expect(attr(region, 'tabIndex')).toBe('0')
      expect(attr(region, 'aria-label')).toMatch(/t\('(remote|local)DirectoryList'\)/)
      expect(attr(region, 'style')).toBe('directoryListS')
      expect(attr(region, 'data-dsh-rw-scroll')).toBe('')
      expect(attr(region, 'onWheel')).toBeUndefined()
      expect(attr(region, 'onKeyDown')).toBeUndefined()
    }
    expect(style('directoryListS')).toMatchObject({ maxHeight: 'min(240px, 32dvh)', minHeight: '0', overflowY: 'auto', overflowX: 'hidden', scrollbarGutter: 'stable' })
  })

  it('preserves scoped native scrollbar discovery and visible keyboard focus', () => {
    const css = initializer('pickerScrollCss').getText(source)
    expect(css).toContain('[data-dsh-rw-scroll] { scrollbar-width: auto !important; }')
    expect(css).toContain('::-webkit-scrollbar { display: block !important; width: 12px !important;')
    expect(css).toContain('::-webkit-scrollbar-thumb')
    expect(css).toContain('${T.borderStrong}')
    expect(css).toContain(':focus-visible')
    expect(openings.some((node) => node.tagName.getText(source) === 'style' && node.parent.getText(source).includes('{pickerScrollCss}'))).toBe(true)
    for (const name of ['picker-body', 'picker-footer', 'host-list']) expect(attr(marked(name), 'data-dsh-rw-scroll')).toBe('')
  })

  it('lets keyboard users enter the initial flow and activate directory rows', () => {
    for (const name of ['DirRow', 'FlowCard']) {
      const code = functionText(name)
      expect(code).toContain("e.key === 'Enter' || e.key === ' '")
      expect(code).toContain('e.preventDefault()')
    }
    expect(attr(marked('flow-card'), 'role')).toBe('button')
    expect(attr(marked('flow-card'), 'tabIndex')).toBe('0')
    expect(attr(marked('directory-row'), 'role')).toBe("drill ? 'button' : undefined")
    expect(attr(marked('directory-row'), 'tabIndex')).toBe('drill ? 0 : undefined')
  })

  it('retains directory-region focus before loading unmounts an activated row', () => {
    const preserve = initializer('preserveDirectoryFocus').getText(source)
    expect(preserve).toContain('region?.contains(document.activeElement)')
    expect(preserve).toContain('region.focus({ preventScroll: true })')
    for (const [load, region, ref] of [['loadDir', 'remote-directory-list', 'remoteListRef'], ['loadLocalDir', 'local-directory-list', 'localListRef']] as const) {
      expect(attr(marked(region), 'ref')).toBe(ref)
      const code = initializer(load).getText(source)
      const focus = code.indexOf(`preserveDirectoryFocus(${ref}.current)`)
      expect(focus).toBeGreaterThan(-1)
      expect(focus).toBeLessThan(code.indexOf('setLoading(true)'))
    }
  })

  it('defines Escape, Tab boundaries, initial focus, and close-focus restoration', () => {
    const panel = marked('picker-panel')
    expect(attr(panel, 'role')).toBe('dialog')
    expect(attr(panel, 'aria-modal')).toBe('true')
    expect(attr(panel, 'tabIndex')).toBe('-1')
    expect(attr(panel, 'ref')).toBe('panelRef')
    expect(attr(panel, 'onKeyDown')).toBe('onDialogKeyDown')
    const keys = initializer('onDialogKeyDown').getText(source)
    for (const contract of ["e.key === 'Escape'", 'e.stopPropagation()', 'if (!busy) onCancel()', "e.key !== 'Tab'", 'panel.querySelectorAll<HTMLElement>', 'e.shiftKey', 'last.focus()', 'first.focus()']) expect(keys).toContain(contract)
    const picker = functionText('DirPicker')
    expect(picker).toContain('panelRef.current?.focus({ preventScroll: true })')
    expect(picker).toContain('previous instanceof HTMLElement && previous.isConnected')
    expect(picker).toContain('previous.focus({ preventScroll: true })')
    expect(picker).not.toContain('document.querySelector')
  })

  it('retains custom titles while explaining basename/main defaults and tree conditions', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    expect(en.workspaceNamePlaceholder).toContain('directory name')
    expect(en.workspaceNamePlaceholder).toContain('host alias for main')
    expect(zh.workspaceNamePlaceholder).toContain('默认目录名')
    expect(zh.workspaceNamePlaceholder).toContain('主机别名')
    expect(en.workspaceNamePlaceholder).not.toContain('host · path')
    expect(zh.workspaceNamePlaceholder).not.toContain('主机 · 路径')
    expect(en.workspaceNameHint).toContain('Ordinary projects')
    expect(en.workspaceNameHint).toContain('workspace tree view')
    expect(en.workspaceNameHint).toContain('added parent workspace')
    expect(zh.workspaceNameHint).toContain('已添加的上级工作区')
    expect(text).toContain("t('workspaceNameHint')")
    const input = openings.find((node) => node.tagName.getText(source) === 'IconInput' && attr(node, 'value') === 'wsName')
    expect(input).toBeDefined()
    expect(attr(input!, 'onChange')).toContain('setWsName')
    const commit = initializer('commitPath').getText(source)
    expect(commit).toContain('const name = wsName.trim()')
    expect(commit).toContain('...(name ? { name } : {})')
  })

  it('does not implement resize/move or intercept wheel and touch scrolling', () => {
    for (const node of openings) {
      for (const key of ['onWheel', 'onTouchMove', 'onPointerDown', 'onMouseDown']) expect(attr(node, key)).toBeUndefined()
    }
    expect(style('pickerPanelS').resize).toBeUndefined()
  })
})
