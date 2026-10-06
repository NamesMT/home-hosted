import { describe, expect, it } from 'vitest'
import { GENERATED_DIRS, GENERATED_FILES, isGeneratedPath } from '#src/shared/generated'

describe('isGeneratedPath', () => {
  it('matches a generated directory at the root and at any depth', () => {
    expect(isGeneratedPath('node_modules')).toBe(true)
    expect(isGeneratedPath('node_modules/@scope/pkg/index.js')).toBe(true)
    expect(isGeneratedPath('app/site/.next/server/page.js')).toBe(true)
    expect(isGeneratedPath('packages\\web\\dist\\index.js')).toBe(true)
  })

  it('matches the listed one-off files', () => {
    expect(isGeneratedPath('.DS_Store')).toBe(true)
    expect(isGeneratedPath('photos/.DS_Store')).toBe(true)
    expect(isGeneratedPath('logs/npm-debug.log')).toBe(true)
  })

  it('keeps real content, including names that merely start alike', () => {
    expect(isGeneratedPath('uploads/photo.jpg')).toBe(false)
    expect(isGeneratedPath('distributed/config.json')).toBe(false)
    expect(isGeneratedPath('my-node_modules/keep.txt')).toBe(false)
    expect(isGeneratedPath('src/components/build.rs')).toBe(false)
    expect(isGeneratedPath('')).toBe(false)
    expect(isGeneratedPath('.')).toBe(false)
  })

  it('has no overlapping or duplicate entries', () => {
    expect(new Set(GENERATED_DIRS).size).toBe(GENERATED_DIRS.length)
    expect(new Set(GENERATED_FILES).size).toBe(GENERATED_FILES.length)
    for (const name of GENERATED_FILES)
      expect(GENERATED_DIRS).not.toContain(name)
  })

  /**
   * `.git` is deliberately absent from both lists, and the module says why: a package manager can
   * reinstall `node_modules`, but nobody can restore a commit that was never pushed. It is the
   * omission a later reader is most likely to "fix" — it looks like an oversight sitting next to
   * `.cache` and `.next` — so the invariant needs a test, not only a comment.
   *
   * The lookalikes matter as much as the directory: `.gitignore` and `.github` are *authored*
   * content, and catching either with a prefix rule would quietly drop them from every archive.
   */
  it('keeps version control, which is not regenerable', () => {
    expect(isGeneratedPath('.git')).toBe(false)
    expect(isGeneratedPath('.git/config')).toBe(false)
    expect(isGeneratedPath('.git/objects/ab/cdef')).toBe(false)
    expect(isGeneratedPath('repo/.git/HEAD')).toBe(false)
    // Names that merely begin with `.git` are real files, not the directory.
    expect(isGeneratedPath('.gitignore')).toBe(false)
    expect(isGeneratedPath('.gitattributes')).toBe(false)
    expect(isGeneratedPath('.github/workflows/ci.yml')).toBe(false)
    expect(isGeneratedPath('vendor/some.git/x')).toBe(false)
    // And it is absent from the lists themselves, so nothing adds it back by name.
    expect(GENERATED_DIRS).not.toContain('.git')
    expect(GENERATED_FILES).not.toContain('.git')
  })
})
