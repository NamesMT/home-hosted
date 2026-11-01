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

/**
 * What `useToasts()` hands back: the methods that carry copy.
 *
 * The receiver is found from the binding, never from a list of names. `toasts` and `notifier` were
 * both hardcoded here, so renaming one binding made every call under it invisible, and
 * `const { success } = useToasts()` was invisible outright — measured green on
 * `notice.success('Settings saved successfully')` and on the destructured form beside it.
 */
const TOAST_METHODS = ['push', 'success', 'failure', 'info', 'warn'] as const
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

/**
 * Every receiver this file binds from `useToasts()`, and every method it destructures from one.
 *
 * A binding is a construct: `const notice = useToasts()` and `const { success } = useToasts()` are
 * the same call site spelled two ways, and the second hands the method out under a bare name.
 */
function toastBindings(source: string): { receivers: string[], methods: string[] } {
  const receivers: string[] = []
  const methods: string[] = []
  const isMethod = (name: string): boolean => (TOAST_METHODS as readonly string[]).includes(name)
  // `const notice = useToasts()`
  for (const match of source.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*useToasts\(\)/g))
    receivers.push(match[1]!)
  // `const { toasts, dismiss } = useToasts()` — `dismiss` closes a toast, it carries no copy.
  for (const match of source.matchAll(/\b(?:const|let)\s*\{([^}]*)\}\s*=\s*useToasts\(\)/g)) {
    for (const part of (match[1] ?? '').split(',')) {
      // `success: ok` binds `ok`; a bare `success` binds itself.
      const [key, alias] = part.split(':').map(piece => piece.trim())
      if (key === undefined || !isMethod(key))
        continue
      const bound = alias !== undefined && alias.length > 0 ? alias : key
      if (/^\w+$/.test(bound))
        methods.push(bound)
    }
  }
  return { receivers, methods }
}

/** Every English sentence a source hands to a toast, as `line: "text"`. */
function copiedToasts(source: string): string[] {
  const found: string[] = []
  const read = (index: number, from: number, untilComma: boolean): void => {
    for (const text of literalsIn(expressionFrom(source, from, untilComma))) {
      if (!isCopy(text))
        continue
      const line = source.slice(0, index).split('\n').length
      const hit = `${line}: "${text.trim()}"`
      if (!found.includes(hit)) {
        found.push(hit)
      }
    }
  }
  const { receivers, methods } = toastBindings(source)
  for (const receiver of receivers) {
    for (const method of TOAST_METHODS) {
      // The whole argument list, not one object key: `push({ tone, description })` carries copy in
      // any field, and a `title:`-only reader missed the description beside it.
      for (const match of source.matchAll(new RegExp(`\\b${receiver}\\.${method}\\(`, 'g')))
        read(match.index, match.index + match[0].length, false)
    }
  }
  for (const method of methods) {
    // A bare method name, never one reached through a receiver: `x.success(` is the shape above.
    for (const match of source.matchAll(new RegExp(`(?<![\\w.])${method}\\(`, 'g')))
      read(match.index, match.index + match[0].length, false)
  }
  for (const match of source.matchAll(RUN_OPTION))
    read(match.index, match.index + match[0].length, true)
  return found
}

describe('toast copy comes from the catalog', () => {
  it('finds the sources to check, so a broken glob cannot pass for free', () => {
    // Anti-vacuity: every assertion below is a "no offenders" list.
    expect(sourceFiles().length).toBeGreaterThan(20)
  })

  /**
   * Anti-vacuity for the reader itself: the binding it resolves has to reach the calls in the
   * corpus. An empty offender list means "clean" only while this count is non-zero — the widened
   * reader replaced a hardcoded receiver list, so a regex that stops matching `useToasts()` would
   * silently retire the whole guard.
   */
  it('resolves the toast bindings the corpus actually writes', () => {
    let receivers = 0
    let calls = 0
    for (const file of sourceFiles()) {
      const source = withoutComments(fs.readFileSync(file, 'utf8'), file)
      const bound = toastBindings(source)
      receivers += bound.receivers.length
      for (const receiver of bound.receivers) {
        for (const method of TOAST_METHODS)
          calls += [...source.matchAll(new RegExp(`\\b${receiver}\\.${method}\\(`, 'g'))].length
      }
    }
    expect(receivers, 'files binding `useToasts()` to a receiver').toBeGreaterThan(4)
    expect(calls, 'toast calls reached through a resolved receiver').toBeGreaterThan(8)
  })

  /**
   * The matcher is a claim about every spelling of "a sentence reaches a toast", so each one is
   * driven here, each with its binding.
   *
   * The receiver comes from `useToasts()`, never from a fixed list: `toasts` and `notifier` were
   * both hardcoded, so a file that bound the same composable to `notice` walked past every
   * assertion below — measured green on `notice.success('Settings saved successfully')`, and on
   * `const { success } = useToasts()` beside it.
   */
  it('still reaches every shape an English sentence is written in', () => {
    const planted: Array<[string, string]> = [
      ['const notifier = useToasts()\nnotifier.success("Couldn\'t add the server")', 'an apostrophe inside a double-quoted sentence'],
      ['const toasts = useToasts()\ntoasts.failure(\'Could not rename the workspace\')', 'a single-quoted sentence'],
      // eslint-disable-next-line no-template-curly-in-string -- a template literal is the shape under test
      ['const toasts = useToasts()\ntoasts.info(`Could not save ${id}`)', 'a template literal'],
      ['const toasts = useToasts()\ntoasts.success(ok ? \'Server started\' : t(\'x.y\'))', 'a sentence behind a ternary'],
      ['const notice = useToasts()\nnotice.success(\'Settings saved successfully\')', 'a receiver the composable was bound to under another name'],
      ['const { success } = useToasts()\nsuccess(\'Settings saved successfully\')', 'a destructured method'],
      ['const { failure: fail } = useToasts()\nfail(\'Could not save the settings\')', 'a destructured method under another name'],
      ['const toasts = useToasts()\ntoasts.push({ tone: \'ok\', description: \'Could not save the proxy settings\' })', 'a `push` whose copy is in the description, not the title'],
      ['run(action, { title: t(\'a.b\'), success: "Server started" })', 'the `success` option'],
    ]
    for (const [source, why] of planted)
      expect(copiedToasts(source).length, `the scan must see ${why}`).toBe(1)
    // And a catalog key is not copy, whichever quote it uses, and whichever name binds it.
    for (const clean of [
      'const toasts = useToasts()\ntoasts.success(t(\'toast.workspaceRenamed\'))',
      'const toasts = useToasts()\ntoasts.success(status ?? t(\'a.b\'))',
      'const notifier = useToasts()\nnotifier.failure(options.title, message)',
      'const notice = useToasts()\nnotice.success(t(\'views.settings.savedToast\'))',
      // `router.push` and `rows.push` are the same method name on a different receiver.
      'const toasts = useToasts()\nvoid router.push(workspacePath(id, \'servers\', serverId))',
    ])
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
