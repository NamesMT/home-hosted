#!/usr/bin/env node
/**
 * Renders the brand PNGs and the ICO from the SVG sources.
 *
 * The SVGs are the source of truth: they are hand-authored geometry, so a PNG is a build
 * artefact and never edited. Run this after changing an SVG, and commit both.
 *
 * Needs `rsvg-convert` (librsvg) and ImageMagick for the ICO. Neither is a package
 * dependency — this is a maintainer script, not something `pnpm install` has to satisfy.
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const brand = path.join(root, 'docs', 'branding')
const iconSizes = [16, 32, 48, 64, 128, 180, 192, 256, 512]

function run(command, args) {
  try {
    execFileSync(command, args, { stdio: 'inherit' })
  }
  catch (error) {
    process.stderr.write(`[brand] ${command} failed — is it installed? (${error.message})\n`)
    process.exit(1)
  }
}

for (const size of iconSizes)
  run('rsvg-convert', ['-w', String(size), '-h', String(size), path.join(brand, 'logo-mark.svg'), '-o', path.join(brand, `icon-${size}.png`)])

// The banner's SVG is generated from measured text, so its copy can never outgrow a pill.
run(process.execPath, [path.join(root, 'scripts', 'build-social-preview.mjs')])

run('rsvg-convert', ['-w', '512', '-h', '512', path.join(brand, 'logo.svg'), '-o', path.join(brand, 'logo-512.png')])
run('rsvg-convert', ['-w', '1280', '-h', '640', path.join(brand, 'social-preview.svg'), '-o', path.join(brand, 'social-preview.png')])

// Three sizes in one file: a 512px icon in an ICO is mostly padding, and browsers pick their own.
run('magick', [
  path.join(brand, 'icon-16.png'),
  path.join(brand, 'icon-32.png'),
  path.join(brand, 'icon-48.png'),
  '-define',
  'icon:auto-resize=48,32,16',
  path.join(brand, 'favicon.ico'),
])

// The UIs do not carry a copy: `uis/vite.shared.ts` serves these two files out of this
// directory in dev and emits them into each UI's build, so the brand stays the one source.
process.stdout.write(`[brand] rendered ${iconSizes.length} icons, the logo and the social preview\n`)
