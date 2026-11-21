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
 * **A link that resolves in the working tree can still be missing from the tarball**, and that is the
 * same bug one step further out: `docs/JOBS.md` existed, four shipped docs linked to it, and
 * `package.json#files` did not list it — so an npm user following "what a job is" from `CLI.md` got a
 * 404 while every check here passed. So `SHIPPED` is now **derived from `package.json#files`** rather
 * than written out a second time, and a link out of a shipped doc must land on something that ships.
 *
 * Run by `quickcheck`, so a broken link fails before it ships.
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

/**
 * The docs the package actually ships, **read out of `package.json#files`**.
 *
 * This was a hand-written list that duplicated the `files` array, and the duplicate drifted:
 * `docs/JOBS.md` was added to neither, so four shipped documents linked to a file that never reached
 * the tarball — and this script, checking a list that also did not contain it, reported everything
 * fine. A guard whose own idea of "shipped" is a second copy of the truth cannot see the truth move.
 *
 * Derived instead: every `files` entry that names a `.md`, plus whatever a named directory holds.
 */
function shippedDocs() {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
  const docs = []
  for (const entry of pkg.files ?? []) {
    if (!entry.endsWith('.md') && !entry.startsWith('docs/'))
      continue
    if (fs.existsSync(entry) && fs.statSync(entry).isFile()) {
      if (entry.endsWith('.md'))
        docs.push(entry)
      continue
    }
    // A directory in `files` ships everything under it, so name its markdown.
    if (fs.existsSync(entry) && fs.statSync(entry).isDirectory()) {
      for (const found of fs.readdirSync(entry, { recursive: true })) {
        const relative = path.posix.join(entry, String(found))
        if (relative.endsWith('.md') && fs.existsSync(relative))
          docs.push(relative)
      }
    }
  }
  return docs
}

const SHIPPED = shippedDocs()

/**
 * Repo-only docs, checked for their own links but never published.
 *
 * **Discovered, not listed.** This was hand-written too, and it had the same failure mode as
 * `SHIPPED` above: a new `.agentDocs/*.md` was simply not checked, and a broken link in it passed
 * silently — verified by adding one that pointed at a file that does not exist and watching this
 * report "all resolve". A list of files to check should be a rule about files, not a copy of them.
 */
function inRepoDocs() {
  const docs = ['AGENTS.md']
  const agentDocs = '.agentDocs'
  if (fs.existsSync(agentDocs)) {
    for (const found of fs.readdirSync(agentDocs, { recursive: true })) {
      const relative = path.posix.join(agentDocs, String(found))
      if (relative.endsWith('.md') && fs.statSync(relative).isFile())
        docs.push(relative)
    }
  }
  return docs.filter(file => fs.existsSync(file))
}

const IN_REPO = inRepoDocs()

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

    const resolved = path.posix.normalize(path.join(dir, relative).split(path.sep).join('/'))
    if (!fs.existsSync(resolved)) {
      problems.push(`${file} -> ${relative}`)
      continue
    }
    /**
     * A link out of a **shipped** doc must land on something a person who installed the package
     * receives.
     *
     * `existsSync` only asks the working tree, where every file is present — so this reported
     * "all links resolve" for four documents pointing at `docs/JOBS.md` while `package.json#files`
     * omitted it and the tarball did not contain it. The install was the thing that was broken, and
     * the tree was never going to say so.
     */
    if (SHIPPED.includes(file) && !IN_REPO.includes(resolved) && !resolved.startsWith('.agentDocs/')) {
      const entries = JSON.parse(fs.readFileSync('package.json', 'utf8')).files ?? []
      // A `files` entry either names the file itself or a directory that ships its contents.
      const shipped = entries.some(entry => entry === resolved
        || (fs.existsSync(entry) && fs.statSync(entry).isDirectory() && resolved.startsWith(`${entry}/`)))
      /**
       * `docs/media/tour.gif` is the one deliberate exception, and it is not a markdown link: the README
       * shows it as an image whose path GitHub resolves to the repository, and the release workflow
       * commits the file there. `package.json#files` excludes it on purpose — the tarball would carry a
       * multi-megabyte GIF for a page npm does not render.
       */
      /**
       * Three things are legitimately not in the tarball while being fine to link from a doc that is:
       *
       *  - `docs/media/` — a GitHub-rendered image, committed to the repo and excluded from `files`;
       *  - a **directory** (`./mockups`, `./uis/noc-console`) — prose pointing at where something lives
       *    in the repository, not a file a reader is expected to open from the tarball;
       *  - `node_modules`, covered by the above.
       *
       * The rule is about *files* that a shipped doc claims a reader can read.
       */
      const githubOnly = resolved.startsWith('docs/media/')
      const isDirectory = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
      if (!shipped && !githubOnly && !isDirectory)
        problems.push(`${file} -> ${relative} (not in the package)`)
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
