/**
 * Check that every relative link in the docs resolves — file and `#anchor` alike.
 *
 * Two lists, because they promise different things. `SHIPPED` is what a person who installed the
 * package receives, and a link there must resolve **inside the tarball**. `IN_REPO` is checked too
 * but is not published: `AGENTS.md` is guidance for this repository, and it links into
 * `.agentDocs/`, which deliberately does not ship. It was published until 0.10.4, so every npm user
 * got an instructions file with four dead links — a doc that is wrong for everyone who reads it,
 * which is exactly what this script exists to catch.
 *
 * A link into `.agentDocs/` from a SHIPPED doc is still broken for every user of the package while
 * looking fine in the repo. Nothing checked this, and the first such link was mine: an invented
 * anchor in a new README paragraph.
 *
 * Run by `quickcheck`, so a broken link fails before it ships.
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

/** The docs the package actually ships; keep in step with `package.json#files`. */
const SHIPPED = [
  'README.md',
  'docs/API.md',
  'docs/BACKUPS.md',
  'docs/CLI.md',
  'docs/DDNS.md',
  'docs/NOTIFICATIONS.md',
  'docs/REVERSE_PROXY.md',
  'docs/SECURITY.md',
  'docs/SERVERS.md',
  'docs/UI_CREATION.md',
]

/** Repo-only docs, checked for their own links but never published. */
const IN_REPO = [
  'AGENTS.md',
  '.agentDocs/ARCHITECTURE.md',
  '.agentDocs/COMPATIBILITY.md',
  '.agentDocs/GOTCHAS.md',
  '.agentDocs/READINGS.md',
  '.agentDocs/RELEASING.md',
  '.agentDocs/UPGRADING.md',
]

/**
 * A heading as GitHub slugs it in the URL fragment.
 *
 * Punctuation is dropped but the whitespace collapsed after it is kept, which is why an emoji heading
 * yields a *leading* hyphen (`## 🛠 CLI` → `#-cli`). Trimming removed that hyphen and reported nine
 * working links as broken.
 */
const anchorOf = heading => heading.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-')

const headingsIn = text => [...text.matchAll(/^#{1,6} (.+)$/gm)].map(match => anchorOf(match[1]))

const problems = []

for (const file of [...SHIPPED, ...IN_REPO]) {
  if (!fs.existsSync(file)) {
    problems.push(`missing file: ${file}`)
    continue
  }
  const text = fs.readFileSync(file, 'utf8')
  const ownHeadings = headingsIn(text)
  const dir = path.dirname(file)

  for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1]
    if (/^(?:https?:|mailto:)/.test(target))
      continue

    const [relative, anchor] = target.split('#')

    if (relative === '') {
      if (anchor !== undefined && !ownHeadings.includes(anchor))
        problems.push(`${file} -> #${anchor}`)
      continue
    }

    const resolved = path.join(dir, relative)
    if (!fs.existsSync(resolved)) {
      problems.push(`${file} -> ${relative}`)
      continue
    }
    if (anchor !== undefined && !headingsIn(fs.readFileSync(resolved, 'utf8')).includes(anchor))
      problems.push(`${file} -> ${relative}#${anchor}`)
  }

  // Raw `<img src>` too: the README's own logo is one, and a markdown-only scan read it as fine
  // while the file it pointed at did not have to exist.
  for (const match of text.matchAll(/<img\s[^>]*src="([^"]+)"/g)) {
    const target = match[1]
    if (/^(?:https?:|data:)/.test(target))
      continue
    if (!fs.existsSync(path.join(dir, target)))
      problems.push(`${file} -> ${target} (img)`)
  }
}

if (problems.length > 0) {
  for (const problem of problems)
    console.error(`broken link: ${problem}`)
  process.exit(1)
}

console.log(`all relative links resolve in ${SHIPPED.length} shipped and ${IN_REPO.length} in-repo docs`)
