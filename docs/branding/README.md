# Brand

The mark, the icons and the social preview. **The SVG files are the source of truth** — every PNG
and the `.ico` are rendered from them by `pnpm run brand`, so nobody edits a raster by hand.

| file | what it is |
| --- | --- |
| `logo.svg` | the full mark (512 grid): a house whose interior is a three-unit rack |
| `logo-mark.svg` | the same idea redrawn for 16px: two units, no vents, thicker strokes |
| `social-preview.svg` | **generated** — the 2:1 GitHub social preview banner, 1280×640 |
| `logo-512.png`, `social-preview.png` | rendered deliverables |
| `icon-16…512.png` | favicon and app-icon sizes, from `logo-mark.svg` |
| `favicon.ico` | 16/32/48 in one file, for browsers that still ask for it |

Each UI gets its favicon from here through `uis/vite.shared.ts`, which serves `favicon.svg`
(=`logo-mark.svg`) and `favicon.ico` in dev and emits them into the build. Nothing is copied into a
UI, so there is one file to change. A symlink is not the alternative: npm drops symlinks from the
tarball, and a Windows checkout with `core.symlinks=false` writes the link target as text.

## The banner is generated, not drawn

`social-preview.svg` is written by `scripts/build-social-preview.mjs`, which holds the copy at the
top of that file. **Edit the script, never the SVG.** Every text run is measured with the same
renderer that draws it, so a pill is always its label plus padding, and the build **fails** rather
than writing a banner whose tag row overflows the text column. The first version of this banner
hand-placed a pixel width per chip, so any wording change ran past the pill it sat in.

The tags are capability words (`Supervision`, `Backups`, `DDNS`, `Reverse Proxy`): they are read
at a glance in a timeline and indexed by search, so positioning belongs in the tagline above them,
not in a chip.

## Why two marks

The full mark is the identity. At 16px its three rack units and nine vent slots fall below one
pixel each and smear into a grey block, so the small mark drops them rather than shrinking
them: two units, no vents, a heavier stroke. Both are the same idea, drawn for their size.

## Colour

Taken from the stock UI's own tokens (`uis/stock/src/styles.css`) rather than invented, so the
brand cannot drift from the panel:

| token | value | used for |
| --- | --- | --- |
| accent | `#2f5fe0` (light) | the mark on light backgrounds |
| accent | `#6d8dff` (dark) | the mark on the dark banner |
| ok | `#3ddc97` | the lit slot in the small mark |
| ok | `#34d399` | the lit slot in the banner |
| page / panel | `#0a0e14` / `#111722` | the banner background |

The lit slot is the one non-accent element on purpose: a rack with a green light is the whole
product in one pixel.

## Tooling

`pnpm run brand` needs `rsvg-convert` (librsvg) and ImageMagick. Neither is a package
dependency — this is a maintainer script, not something `pnpm install` has to satisfy, and the
rendered files are committed so a contributor never needs them.
