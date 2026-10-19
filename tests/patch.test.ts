import { describe, expect, it } from 'vitest'
import {
  applyUnifiedDiff,
  looksBinary,
  parsePatch,
  patchTargets,
  PathEscapeError,
  PatchFormatError,
  unifiedDiff,
} from '../src/patch.js'

/** Run fn and return whatever it threw, failing the test if it did not throw. */
function thrown(fn: () => unknown): unknown {
  try {
    fn()
  } catch (err) {
    return err
  }
  throw new Error('expected function to throw')
}

function expectPatchFormatError(fn: () => unknown): void {
  expect(thrown(fn)).toBeInstanceOf(PatchFormatError)
}

function expectPathEscapeError(fn: () => unknown): void {
  expect(thrown(fn)).toBeInstanceOf(PathEscapeError)
}

const TIMESTAMP = '\t2024-01-01 00:00:00'

describe('parsePatch', () => {
  it('parses a one-file diff and strips the a/ b/ prefixes', () => {
    const patch = ['--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,1 +1,1 @@', '-old', '+new', ''].join('\n')
    expect(parsePatch(patch)).toEqual([
      { oldPath: 'src/a.ts', newPath: 'src/a.ts', oldIsNull: false, newIsNull: false },
    ])
  })

  it('strips tab-separated timestamps from both header lines', () => {
    const patch = [`--- a/f.ts${TIMESTAMP}`, `+++ b/f.ts${TIMESTAMP}`, '@@ -1,1 +1,1 @@', '-x', '+y', ''].join('\n')
    expect(parsePatch(patch)).toEqual([{ oldPath: 'f.ts', newPath: 'f.ts', oldIsNull: false, newIsNull: false }])
  })

  it('flags /dev/null on either side (creation and deletion)', () => {
    const created = parsePatch(['--- /dev/null', '+++ b/new/f.txt', '@@ -0,0 +1,1 @@', '+hi', ''].join('\n'))
    expect(created).toEqual([{ oldPath: '/dev/null', newPath: 'new/f.txt', oldIsNull: true, newIsNull: false }])

    const deleted = parsePatch(['--- a/gone.txt', '+++ /dev/null', '@@ -1,1 +0,0 @@', '-bye', ''].join('\n'))
    expect(deleted).toEqual([{ oldPath: 'gone.txt', newPath: '/dev/null', oldIsNull: false, newIsNull: true }])
  })

  it('parses multiple files in order and ignores diff --git / index metadata', () => {
    const patch = [
      'diff --git a/a.txt b/a.txt',
      'index 1111111..2222222 100644',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,1 +1,1 @@',
      '-a',
      '+A',
      'diff --git a/b.txt b/b.txt',
      'index 3333333..4444444 100644',
      '--- a/b.txt',
      '+++ b/b.txt',
      '@@ -1,1 +1,1 @@',
      '-b',
      '+B',
      '',
    ].join('\n')
    expect(parsePatch(patch).map((entry) => entry.newPath)).toEqual(['a.txt', 'b.txt'])
  })

  it('does not create an entry from a diff --git line alone', () => {
    expectPatchFormatError(() => parsePatch('diff --git a/f b/f\nindex 111..222 100644\n'))
  })

  it('throws when the input contains no ---/+++ pair at all', () => {
    expectPatchFormatError(() => parsePatch(''))
    expectPatchFormatError(() => parsePatch('hello\nworld\n'))
    expectPatchFormatError(() => parsePatch('just a prose file\n\nmore prose\n'))
  })

  it('throws when a +++ line is missing for a --- header', () => {
    expectPatchFormatError(() => parsePatch('--- a/f\n@@ -1,1 +1,1 @@\n-a\n+b\n'))
    expectPatchFormatError(() => parsePatch('--- a/f\n'))
  })

  it('does not mistake removed hunk lines starting with -- for file headers', () => {
    // A removed line whose content starts with '--' is rendered as '--- …',
    // and an added line whose content starts with '++' as '+++ …'.
    const patch = ['--- a/f', '+++ b/f', '@@ -1,2 +1,2 @@', '--- old', '+++ new', ' keep', ''].join('\n')
    expect(parsePatch(patch)).toEqual([{ oldPath: 'f', newPath: 'f', oldIsNull: false, newIsNull: false }])
  })

  it('accepts hunk headers with the ,1 shorthand', () => {
    const patch = ['--- a/f', '+++ b/f', '@@ -1 +1 @@', '-a', '+b', ''].join('\n')
    expect(parsePatch(patch)).toHaveLength(1)
  })

  it('accepts a header pair without hunks (metadata-only entry)', () => {
    expect(parsePatch('--- a/f\n+++ b/f\n')).toEqual([
      { oldPath: 'f', newPath: 'f', oldIsNull: false, newIsNull: false },
    ])
  })
})

describe('unifiedDiff', () => {
  it('returns an empty string for identical texts', () => {
    expect(unifiedDiff('f', '', '')).toBe('')
    expect(unifiedDiff('f', 'a\nb\n', 'a\nb\n')).toBe('')
  })

  it('builds a single-line change with explicit line counts', () => {
    expect(unifiedDiff('f.txt', 'one\ntwo\nthree\n', 'one\nTWO\nthree\n')).toBe(
      ['--- a/f.txt', '+++ b/f.txt', '@@ -1,3 +1,3 @@', ' one', '-two', '+TWO', ' three', ''].join('\n'),
    )
  })

  it('builds an insertion hunk', () => {
    expect(unifiedDiff('f', 'a\nb\n', 'a\nx\nb\n')).toBe(
      ['--- a/f', '+++ b/f', '@@ -1,2 +1,3 @@', ' a', '+x', ' b', ''].join('\n'),
    )
  })

  it('builds a deletion hunk', () => {
    expect(unifiedDiff('f', 'a\nb\nc\n', 'a\nc\n')).toBe(
      ['--- a/f', '+++ b/f', '@@ -1,3 +1,2 @@', ' a', '-b', ' c', ''].join('\n'),
    )
  })

  it('omits all context with contextLines = 0', () => {
    expect(unifiedDiff('f', 'a\nb\nc\n', 'a\nB\nc\n', 0)).toBe(
      ['--- a/f', '+++ b/f', '@@ -2,1 +2,1 @@', '-b', '+B', ''].join('\n'),
    )
    // Zero-count sides use the insertion/deletion line numbering.
    expect(unifiedDiff('f', 'a\nb\n', 'a\nx\nb\n', 0)).toContain('@@ -1,0 +2,1 @@')
    expect(unifiedDiff('f', 'a\nb\nc\n', 'a\nc\n', 0)).toContain('@@ -2,1 +1,0 @@')
  })

  it('honours a custom context size', () => {
    expect(unifiedDiff('f', '1\n2\n3\n4\n5\n', '1\n2\nX\n4\n5\n', 1)).toBe(
      ['--- a/f', '+++ b/f', '@@ -2,3 +2,3 @@', ' 2', '-3', '+X', ' 4', ''].join('\n'),
    )
  })

  it('emits separate hunks for far changes and merges nearby ones', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n') + '\n'
    const after =
      Array.from({ length: 20 }, (_, i) => (i === 1 || i === 17 ? 'CHANGED' : `line${i + 1}`)).join('\n') + '\n'
    const far = unifiedDiff('f', before, after, 1)
    expect((far.match(/^@@/gm) ?? []).length).toBe(2)

    // Only lines 4-5 are unchanged, well within 2 * 3 context lines, so
    // git/diff emit a single merged hunk here too.
    const near = unifiedDiff('f', '1\n2\n3\n4\n5\n6\n7\n8\n', '1\n2\nX\n4\n5\nY\n7\n8\n', 3)
    expect((near.match(/^@@/gm) ?? []).length).toBe(1)
  })

  it('marks a missing trailing newline on both replaced lines', () => {
    expect(unifiedDiff('f', 'a', 'b')).toBe(
      [
        '--- a/f',
        '+++ b/f',
        '@@ -1,1 +1,1 @@',
        '-a',
        '\\ No newline at end of file',
        '+b',
        '\\ No newline at end of file',
        '',
      ].join('\n'),
    )
  })

  it('marks the missing trailing newline on the side that lacks it', () => {
    expect(unifiedDiff('f', 'a\nb', 'a\nb\n')).toBe(
      ['--- a/f', '+++ b/f', '@@ -1,2 +1,2 @@', ' a', '-b', '\\ No newline at end of file', '+b', ''].join('\n'),
    )
    expect(unifiedDiff('f', 'a\nb\n', 'a\nb')).toBe(
      ['--- a/f', '+++ b/f', '@@ -1,2 +1,2 @@', ' a', '-b', '+b', '\\ No newline at end of file', ''].join('\n'),
    )
  })

  it('uses -0,0 / +0,0 when one side starts empty', () => {
    expect(unifiedDiff('new.txt', '', 'a\nb\n')).toBe(
      ['--- a/new.txt', '+++ b/new.txt', '@@ -0,0 +1,2 @@', '+a', '+b', ''].join('\n'),
    )
    expect(unifiedDiff('old.txt', 'a\nb\n', '')).toBe(
      ['--- a/old.txt', '+++ b/old.txt', '@@ -1,2 +0,0 @@', '-a', '-b', ''].join('\n'),
    )
  })

  it('falls back to a replace-everything hunk above the LCS line cap', () => {
    const lines = Array.from({ length: 2001 }, (_, i) => `line ${i}`)
    const before = `${lines.join('\n')}\n`
    const after = `${lines.map((line, i) => (i === 1000 ? 'CHANGED' : line)).join('\n')}\n`
    const patch = unifiedDiff('big.txt', before, after)
    expect(patch).toContain('@@ -1,2001 +1,2001 @@')
    expect((patch.match(/^@@/gm) ?? []).length).toBe(1)
    expect(applyUnifiedDiff(before, patch)).toBe(after)
  })
})

describe('unifiedDiff round-trip', () => {
  const cases: Array<[string, string, string]> = [
    ['single-line change', 'one\ntwo\nthree\n', 'one\nTWO\nthree\n'],
    ['pure insertion', 'a\nb\n', 'a\nx\nb\n'],
    ['pure deletion', 'a\nb\nc\n', 'a\nc\n'],
    ['empty file to content', '', 'a\nb\n'],
    ['content to empty file', 'a\nb\n', ''],
    ['no trailing newline in both', 'a\nb', 'a\nB'],
    ['trailing newline added', 'a\nb', 'a\nb\n'],
    ['CRLF content', 'a\r\nb\r\n', 'a\r\nB\r\n'],
    ['Unicode content', '日\n本\n', '日\n語\n'],
    [
      'multiple hunks',
      `${Array.from({ length: 12 }, (_, i) => `l${i + 1}`).join('\n')}\n`,
      `${Array.from({ length: 12 }, (_, i) => (i === 1 || i === 9 ? 'X' : `l${i + 1}`)).join('\n')}\n`,
    ],
  ]

  it.each(cases)('round-trips %s', (_name, before, after) => {
    expect(applyUnifiedDiff(before, unifiedDiff('dir/file.txt', before, after))).toBe(after)
  })

  it('round-trips with 0, 1 and 5 context lines', () => {
    const before = 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n'
    const after = 'l1\nL2\nl3\nl4\nl5\nl6\nL7\nl8\n'
    for (const context of [0, 1, 5]) {
      expect(applyUnifiedDiff(before, unifiedDiff('f', before, after, context))).toBe(after)
    }
  })

  it('round-trips identical texts through the empty diff', () => {
    expect(applyUnifiedDiff('same\ncontent\n', unifiedDiff('f', 'same\ncontent\n', 'same\ncontent\n'))).toBe(
      'same\ncontent\n',
    )
  })
})

describe('applyUnifiedDiff', () => {
  it('applies a plain single-hunk patch', () => {
    const patch = ['--- a/f', '+++ b/f', '@@ -1,3 +1,3 @@', ' one', '-two', '+TWO', ' three', ''].join('\n')
    expect(applyUnifiedDiff('one\ntwo\nthree\n', patch)).toBe('one\nTWO\nthree\n')
  })

  it('applies a patch with diff --git / index metadata and shorthand counts', () => {
    const patch = [
      'diff --git a/f b/f',
      'index 1234567..89abcde 100644',
      '--- a/f',
      '+++ b/f',
      '@@ -1 +1 @@',
      '-before',
      '+after',
      '',
    ].join('\n')
    expect(applyUnifiedDiff('before\nsecond\n', patch)).toBe('after\nsecond\n')
  })

  it('applies multiple hunks in one file', () => {
    const before = '1\n2\n3\n4\n5\n6\n7\n8\n9\n'
    const patch = [
      '--- a/f',
      '+++ b/f',
      '@@ -2,3 +2,3 @@',
      ' 2',
      '-3',
      '+X',
      ' 4',
      '@@ -7,3 +7,3 @@',
      ' 7',
      '-8',
      '+Y',
      ' 9',
      '',
    ].join('\n')
    expect(applyUnifiedDiff(before, patch)).toBe('1\n2\nX\n4\n5\n6\n7\nY\n9\n')
  })

  it('applies /dev/null creation and deletion patches', () => {
    const created = ['--- /dev/null', '+++ b/new.txt', '@@ -0,0 +1,2 @@', '+a', '+b', ''].join('\n')
    expect(applyUnifiedDiff('', created)).toBe('a\nb\n')

    const deleted = ['--- a/gone.txt', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-a', '-b', ''].join('\n')
    expect(applyUnifiedDiff('a\nb\n', deleted)).toBe('')
  })

  it('honours the no-newline marker', () => {
    const patch = [
      '--- a/f',
      '+++ b/f',
      '@@ -1,1 +1,1 @@',
      '-a',
      '\\ No newline at end of file',
      '+b',
      '\\ No newline at end of file',
      '',
    ].join('\n')
    expect(applyUnifiedDiff('a', patch)).toBe('b')
  })

  it('throws PatchFormatError when the context does not match', () => {
    const patch = ['--- a/f', '+++ b/f', '@@ -1,1 +1,1 @@', '-nope', '+yes', ''].join('\n')
    expectPatchFormatError(() => applyUnifiedDiff('one\ntwo\nthree\n', patch))
  })

  it('throws PatchFormatError when a hunk is out of range', () => {
    const patch = ['--- a/f', '+++ b/f', '@@ -9,1 +9,1 @@', '-x', '+y', ''].join('\n')
    expectPatchFormatError(() => applyUnifiedDiff('one\n', patch))
  })

  it('throws PatchFormatError for non-patch input and multi-file patches', () => {
    expectPatchFormatError(() => applyUnifiedDiff('x\n', 'not a patch\n'))
    const twoFiles = [
      '--- a/a',
      '+++ b/a',
      '@@ -1,1 +1,1 @@',
      '-x',
      '+y',
      '--- a/b',
      '+++ b/b',
      '@@ -1,1 +1,1 @@',
      '-x',
      '+z',
      '',
    ].join('\n')
    expectPatchFormatError(() => applyUnifiedDiff('x\n', twoFiles))
  })

  it('treats an empty diff as a no-op', () => {
    expect(applyUnifiedDiff('keep\nthis\n', '')).toBe('keep\nthis\n')
  })
})

describe('patchTargets', () => {
  it('strips one component by default', () => {
    const patch = ['--- a/src/f.ts', '+++ b/src/f.ts', '@@ -1,1 +1,1 @@', '-a', '+b', ''].join('\n')
    expect(patchTargets(patch, '/ws')).toEqual(['/ws/src/f.ts'])
  })

  it('keeps the paths as written with strip = 0', () => {
    const patch = ['--- a/src/f.ts', '+++ b/src/f.ts', '@@ -1,1 +1,1 @@', '-a', '+b', ''].join('\n')
    expect(patchTargets(patch, '/ws', 0)).toEqual(['/ws/a/src/f.ts', '/ws/b/src/f.ts'])
  })

  it('returns every file in order', () => {
    const patch = [
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,1 +1,1 @@',
      '-a',
      '+A',
      '--- a/b/c.txt',
      '+++ b/b/c.txt',
      '@@ -1,1 +1,1 @@',
      '-b',
      '+B',
      '',
    ].join('\n')
    expect(patchTargets(patch, '/ws')).toEqual(['/ws/a.txt', '/ws/b/c.txt'])
  })

  it('de-duplicates repeated targets while preserving order', () => {
    const patch = [
      '--- a/f',
      '+++ b/f',
      '@@ -1,1 +1,1 @@',
      '-a',
      '+b',
      '--- a/f',
      '+++ b/f',
      '@@ -1,1 +1,1 @@',
      '-b',
      '+c',
      '--- a/g',
      '+++ b/g',
      '',
    ].join('\n')
    expect(patchTargets(patch, '/ws')).toEqual(['/ws/f', '/ws/g'])
  })

  it('uses only the non-null side of /dev/null entries', () => {
    expect(patchTargets('--- /dev/null\n+++ b/new.txt\n', '/ws')).toEqual(['/ws/new.txt'])
    expect(patchTargets('--- a/old.txt\n+++ /dev/null\n', '/ws')).toEqual(['/ws/old.txt'])
  })

  it('keeps both sides when a patch renames a file', () => {
    expect(patchTargets('--- a/old.txt\n+++ b/new.txt\n', '/ws')).toEqual(['/ws/old.txt', '/ws/new.txt'])
  })

  it('throws PathEscapeError for a .. escape', () => {
    expectPathEscapeError(() => patchTargets('--- a/../../etc/passwd\n+++ b/../../etc/passwd\n', '/ws'))
    expectPathEscapeError(() => patchTargets('--- ../x\n+++ ../x\n', '/ws', 0))
  })

  it('throws PathEscapeError for an absolute target', () => {
    expectPathEscapeError(() => patchTargets('--- /etc/passwd\n+++ /etc/passwd\n', '/ws', 0))
  })

  it('throws PathEscapeError when stripping empties the path', () => {
    expectPathEscapeError(() => patchTargets('--- a/f\n+++ b/f\n', '/ws', 2))
    expectPathEscapeError(() => patchTargets('--- f\n+++ f\n', '/ws'))
  })

  it('joins against the workspace root, including the filesystem root', () => {
    const patch = '--- a/f.txt\n+++ b/f.txt\n'
    expect(patchTargets(patch, '/ws/')).toEqual(['/ws/f.txt'])
    expect(patchTargets(patch, '/')).toEqual(['/f.txt'])
  })
})

describe('looksBinary', () => {
  it('detects a NUL byte', () => {
    expect(looksBinary('a\u0000b')).toBe(true)
    expect(looksBinary('\u0000')).toBe(true)
  })

  it('accepts text, including Unicode and other control characters', () => {
    expect(looksBinary('')).toBe(false)
    expect(looksBinary('hello\nworld\n')).toBe(false)
    expect(looksBinary('日本語のテキスト')).toBe(false)
    expect(looksBinary('a\u0001b')).toBe(false)
  })
})
