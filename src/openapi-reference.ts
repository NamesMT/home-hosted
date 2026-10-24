/**
 * The browsable API reference at `/openapi/ui`.
 *
 * It used to be `Scalar()`, which renders a page whose only content is
 * `<script type="module">import … from 'https://cdn.jsdelivr.net/…'</script>` — so on the machine this
 * package exists for, a home server with no route to the internet (or a browser with a strict CSP, or a
 * blocked CDN), the page is **blank**: measured in Chromium with every non-panel request aborted, `#app`
 * had 0 children and 0 characters of text, while the same page pulled 30 requests / a 754 KB bundle from
 * jsDelivr plus two fonts from `fonts.scalar.com` when it could reach them.
 *
 * `docs/UI_CREATION.md` point 5 is "an offline home server should not need a CDN", and the panel is the
 * thing being documented. So the index below is rendered **from `/openapi/spec.json` with no dependency**
 * — grouped by tag, every operation with its method, path and summary — and Scalar is loaded afterwards as
 * optional enhancement: if it arrives, it takes over; if it does not, the person still has the API.
 *
 * The spec stays the single source of truth; this file only formats what the routes already declare.
 */

/**
 * Deliberately a string, not a `.vue` or a template dependency: this route is outside `/api` and outside
 * both UIs, and `src/**` may not know a UI's files.
 */
export function openApiReferencePage(specUrl: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>home-hosted — API reference</title>
    <style>
      :root { color-scheme: light dark; --line: #d8dee9; --ink: #14202e; --muted: #5b6b80; --page: #fbfcfe; --code: #eef2f8; }
      @media (prefers-color-scheme: dark) { :root { --line: #263243; --ink: #e6edf7; --muted: #9fb0c6; --page: #0d131c; --code: #16202c; } }
      * { box-sizing: border-box; }
      body { margin: 0; padding: 2rem 1.25rem 4rem; background: var(--page); color: var(--ink);
             font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
      main { max-width: 60rem; margin: 0 auto; }
      h1 { font-size: 1.35rem; margin: 0 0 .35rem; letter-spacing: -.01em; }
      p.lede { margin: 0 0 1.75rem; color: var(--muted); }
      a { color: inherit; }
      h2 { font-size: .8rem; text-transform: uppercase; letter-spacing: .07em; color: var(--muted);
           margin: 2rem 0 .6rem; }
      ul { list-style: none; margin: 0; padding: 0; }
      li { display: grid; grid-template-columns: 4.6rem 1fr; gap: .75rem; align-items: baseline;
           padding: .55rem .7rem; border: 1px solid var(--line); border-radius: .5rem; margin-bottom: .4rem; }
      .m { font: 600 .72rem/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .04em;
           padding: .3rem .4rem; border-radius: .3rem; text-align: center; background: var(--code); }
      .m[data-m="GET"] { color: #0a7d52; } .m[data-m="POST"] { color: #1f5fd0; }
      .m[data-m="PUT"], .m[data-m="PATCH"] { color: #8a5b00; } .m[data-m="DELETE"] { color: #b32020; }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .86rem; }
      .summary { color: var(--muted); font-size: .87rem; }
      .error { padding: 1rem; border: 1px solid var(--line); border-radius: .5rem; color: var(--muted); }
      footer { margin-top: 2.5rem; padding-top: 1rem; border-top: 1px solid var(--line);
               color: var(--muted); font-size: .85rem; }
      @media (max-width: 30rem) { li { grid-template-columns: 4rem 1fr; } body { padding: 1.25rem 1rem 3rem; } }
    </style>
  </head>
  <body>
    <main>
      <h1>home-hosted API</h1>
      <p class="lede">Every route the panel serves, generated from the same schemas the routes validate
        with. Send <code>Authorization: Bearer hh_…</code> with any call; a cookie session works too.</p>
      <div id="app" data-fallback="index"><p class="error">Loading the route index…</p></div>
      <footer>
        <a href="${specUrl}">${specUrl}</a> — the OpenAPI document, for
        <code>openapi-typescript</code>, <code>openapi-generator</code> or any other client.
      </footer>
    </main>
    <script type="module">
      const specUrl = ${JSON.stringify(specUrl)}
      const app = document.getElementById('app')

      /**
       * The index, from the spec, with nothing but \`fetch\`. This is the page's real content: it is what a
       * person on an air-gapped box sees, and what the browser below replaces only if the CDN answers.
       */
      async function renderIndex() {
        let spec
        try {
          const response = await fetch(specUrl, { headers: { accept: 'application/json' } })
          if (!response.ok) throw new Error(String(response.status))
          spec = await response.json()
        } catch (error) {
          app.dataset.fallback = 'error'
          app.innerHTML = '<p class="error">The OpenAPI document could not be read (' +
            String(error && error.message ? error.message : error) + ').</p>'
          return
        }

        const tags = (spec.tags || []).map(tag => tag.name)
        const groups = new Map(tags.map(name => [name, []]))
        for (const [path, operations] of Object.entries(spec.paths || {})) {
          for (const [method, operation] of Object.entries(operations || {})) {
            const name = (operation.tags && operation.tags[0]) || 'other'
            if (!groups.has(name)) groups.set(name, [])
            groups.get(name).push({ path, method: method.toUpperCase(), summary: operation.summary || '' })
          }
        }

        let html = ''
        for (const [tag, rows] of groups) {
          if (rows.length === 0) continue
          html += '<h2>' + escapeHtml(tag) + '</h2><ul>'
          for (const row of rows.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method)))
            html += '<li><span class="m" data-m="' + row.method + '">' + row.method + '</span><span><code>' +
              escapeHtml(row.path) + '</code><br><span class="summary">' + escapeHtml(row.summary) + '</span></span></li>'
          html += '</ul>'
        }
        app.dataset.fallback = 'rendered'
        app.innerHTML = html || '<p class="error">The OpenAPI document lists no operations.</p>'
      }

      function escapeHtml(value) {
        return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
      }

      await renderIndex()

      /**
       * Optional enhancement: the interactive reference, which lives on a CDN. It is allowed to fail —
       * that is the whole point of rendering the index first — so a LAN box with no internet keeps a
       * usable page instead of a blank one.
       */
      try {
        const { createApiReference } = await import('https://cdn.jsdelivr.net/npm/@scalar/api-reference/esm.js')
        app.innerHTML = ''
        app.dataset.fallback = 'enhanced'
        createApiReference('#app', { _integration: 'hono', url: specUrl, theme: 'deepSpace' })
      } catch {
        // No CDN: the index above stays, and that is a supported outcome.
      }
    </script>
  </body>
</html>`
}
