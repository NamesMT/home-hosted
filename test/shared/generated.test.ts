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
})
