import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { stripComments } from '../../../test/helpers/strip-comments'

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
 *
 * The matcher reads the argument, not a quote character. Its first version required the string to
 * open the call and forbade **either** other quote inside it — `[^'"`]` — so
 * `toasts.failure("Couldn't rename the workspace")` matched nothing at all and the guard stayed
 * green over an English sentence with an apostrophe, the most ordinary way to write one. The body
 * is now read by its own delimiter, and every literal in the argument counts, so a sentence in the
 * second argument or behind a ternary is reached as well.
 */
const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)))
const srcDir = path.join(root, 'src')

/** Both toast surfaces: `useToasts()` and the shared `notifier` in `useControlPlane`. */
const TOAST_CALL = /(?:notifier|toasts)\.(?:success|failure|info|warn)\(/g
/**
 * The `{ title, success }` pair `run()` takes. This is the shape the control plane actually uses,
 * and it is why a plain "grep for toasts." guard would have found almost nothing.
 */
const RUN_OPTION = /\b(?:title|success)\s*:\s*/g

/** A literal, read by its own delimiter so an apostrophe inside `"…"` is text, not the end. */
const LITERAL = /(['"`])((?:\\[\s\S]|(?!\1)[^\\])*)\1/g

const QUOTES = new Set(['"', '\'', '`'])

/** The index of the quote that closes the literal opening at `from`, escapes counted. */
function endOfLiteral(source: string, from: number): number {
  const quote = source[from]
  for (let index = from + 1; index < source.length; index += 1) {
    if (source[index] === '\\') {
      index += 1
      continue
    }
    if (source[index] === quote)
      return index
  }
  return -1
}

/**
 * The text one expression spans from `from`: balanced brackets, literals stepped over.
 *
 * `untilComma` is the difference between an argument list and a value — a toast call keeps going
 * past `,` (the description is the second argument), while `title:`/`success:` stops at one.
 */
function expressionFrom(source: string, from: number, untilComma: boolean): string {
  let depth = 0
  for (let index = from; index < source.length; index += 1) {
    const char = source[index]!
    if (QUOTES.has(char)) {
      const close = endOfLiteral(source, index)
      if (close < 0)
        return source.slice(from, index)
      index = close
      continue
    }
    if ('([{'.includes(char)) {
      depth += 1
      continue
    }
    if (')]}'.includes(char)) {
      if (depth === 0)
        return source.slice(from, index)
      depth -= 1
      continue
    }
    if (depth === 0 && (char === '\n' || (untilComma && char === ',')))
      return source.slice(from, index)
  }
  return source.slice(from)
}

/** Every string literal body in `text`. */
function literalsIn(text: string): string[] {
  return [...text.matchAll(LITERAL)].map(match => match[2]!)
}

/** Source with comments removed, so an explanatory English note is not read as copy. */
function withoutComments(source: string, file: string): string {
  // The shared reader (`test/helpers/strip-comments.ts`) tracks strings: a pattern for `//` and
  // `/*` reads a URL as a comment and a glob star as an opening delimiter.
  return stripComments(source, file)
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

/** Every English sentence a source hands to a toast, as `line: "text"`. */
function copiedToasts(source: string): string[] {
  const found: string[] = []
  const read = (from: number, untilComma: boolean): void => {
    for (const text of literalsIn(expressionFrom(source, from, untilComma))) {
      if (!isCopy(text))
        continue
      const line = source.slice(0, from).split('\n').length
      found.push(`${line}: "${text.trim()}"`)
    }
  }
  for (const match of source.matchAll(TOAST_CALL))
    read(match.index + match[0].length, false)
  for (const match of source.matchAll(RUN_OPTION))
    read(match.index + match[0].length, true)
  return found
}

describe('toast copy comes from the catalog', () => {
  it('finds the sources to check, so a broken glob cannot pass for free', () => {
    // Anti-vacuity: every assertion below is a "no offenders" list.
    expect(sourceFiles().length).toBeGreaterThan(20)
  })

  /**
   * The matcher is a claim about every spelling of "a sentence reaches a toast", so each one is
   * driven here. The first two are the defect that was measured: a double-quoted sentence holding
   * an apostrophe matched nothing, because the body forbade every other quote character.
   */
  it('still reaches every shape an English sentence is written in', () => {
    const planted: Array<[string, string]> = [
      ['notifier.success("Couldn\'t add the server")', 'an apostrophe inside a double-quoted sentence'],
      ['toasts.failure(\'Could not rename the workspace\')', 'a single-quoted sentence'],
      // eslint-disable-next-line no-template-curly-in-string -- a template literal is the shape under test
      ['toasts.info(`Could not save ${id}`)', 'a template literal'],
      ['toasts.success(ok ? \'Server started\' : t(\'x.y\'))', 'a sentence behind a ternary'],
      ['run(action, { title: t(\'a.b\'), success: "Server started" })', 'the `success` option'],
    ]
    for (const [source, why] of planted)
      expect(copiedToasts(source).length, `the scan must see ${why}`).toBe(1)
    // And a catalogs key is not copy, whichever quote it uses.
    for (const clean of ['toasts.success(t(\'toast.workspaceRenamed\'))', 'toasts.success(status ?? t(\'a.b\'))', 'notifier.failure(options.title, message)'])
      expect(copiedToasts(clean), clean).toHaveLength(0)
  })

  it('leaves no English sentence handed straight to a toast', () => {
    const offenders: string[] = []
    for (const file of sourceFiles()) {
      const source = withoutComments(fs.readFileSync(file, 'utf8'), file)
      for (const hit of copiedToasts(source))
        offenders.push(`${path.relative(srcDir, file)}:${hit}`)
    }
    expect(offenders).toEqual([])
  })
})
