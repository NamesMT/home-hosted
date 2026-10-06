/**
 * Check that every relative link in the SHIPPED docs resolves — file and `#anchor` alike.
 *
 * `.agentDocs/` is deliberately not published (see AGENTS.md → Releasing), so a link into it from a
 * shipped doc is broken for every user of the package while looking fine in the repo. Nothing checked
 * this, and the first such link was mine: an invented anchor in a new README paragraph.
 *
 * Run by `quickcheck`, so a broken link fails before it ships.
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

/** The docs the package actually ships; keep in step with `package.json#files`. */
const SHIPPED = [
  'README.md',
  'AGENTS.md',
  'docs/DDNS.md',
  'docs/NOTIFICATIONS.md',
  'docs/REVERSE_PROXY.md',
  'docs/SERVERS.md',
  'docs/UI_CREATION.md',
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

for (const file of SHIPPED) {
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
}

if (problems.length > 0) {
  for (const problem of problems)
    console.error(`broken link: ${problem}`)
  process.exit(1)
}

console.log(`all relative links resolve in ${SHIPPED.length} shipped docs`)
