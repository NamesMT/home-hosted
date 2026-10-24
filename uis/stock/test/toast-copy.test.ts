import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * A toast's words are a string, and a string in a `.ts` file is not copy to anything.
 *
 * `untranslated-copy.test.ts` reads `.vue` templates, so it catches the sentence someone typed
 * between two tags and cannot see the one a composable hands to `toasts.success(...)`. That is
 * where every toast in this UI lived: a German panel answered a duplicate server id with
 * `Could not add the server / server "ghost" already exists`, measured in Chromium — the whole
 * shell translated, and the one line telling the person what happened in English.
 *
 * The scan is deliberately about the *argument*, not about the render: the toast stack is mounted
 * by no test, and a composable called from a page test is mocked out. A source rule catches the
 * next author too.
 */
const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)))
const srcDir = path.join(root, 'src')

/** Both toast surfaces: `useToasts()` and the shared `notifier` in `useControlPlane`. */
const TOAST_CALL = /(?:notifier|toasts)\.(?:success|failure|info|warn)\(\s*(['"`])((?:[^'"`\\]|\\.)*)\1/g
/**
 * The `{ title, success }` pair `run()` takes. This is the shape the control plane actually uses,
 * and it is why a plain "grep for toasts." guard would have found almost nothing.
 */
const RUN_OPTION = /\b(?:title|success)\s*:\s*(['"`])((?:[^'"`\\]|\\.)*)\1/g

/** Source with comments removed, so an explanatory English note is not read as copy. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/[ \t]\/\/.*$/gm, '')
}

function sourceFiles(): string[] {
  const files: string[] = []
  for (const entry of fs.readdirSync(srcDir, { recursive: true, withFileTypes: true })) {
    // `.vue` is here too: a `<script setup>` hands toasts to the same functions, and the template
    // scan beside this one only reads the markup.
    if (!entry.isFile() || !/\.(?:ts|vue)$/.test(entry.name))
      continue
    const file = path.join(entry.parentPath, entry.name)
    if (path.relative(srcDir, file).startsWith('i18n/'))
      continue
    files.push(file)
  }
  return files.sort()
}

/** A literal is copy when it reads as a sentence: two words or more, or an interpolation. */
function isCopy(text: string): boolean {
  return /[A-Z]/i.test(text) && (/\s/.test(text.trim()) || text.includes('${'))
}

describe('toast copy comes from the catalog', () => {
  it('finds the sources to check, so a broken glob cannot pass for free', () => {
    // Anti-vacuity: every assertion below is a "no offenders" list.
    expect(sourceFiles().length).toBeGreaterThan(20)
  })

  it('leaves no English sentence handed straight to a toast', () => {
    const offenders: string[] = []
    for (const file of sourceFiles()) {
      const source = withoutComments(fs.readFileSync(file, 'utf8'))
      for (const pattern of [TOAST_CALL, RUN_OPTION]) {
        for (const match of source.matchAll(pattern)) {
          const text = match[2]!.trim()
          if (!isCopy(text))
            continue
          const line = source.slice(0, match.index).split('\n').length
          offenders.push(`${path.relative(srcDir, file)}:${line}: "${text}"`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
