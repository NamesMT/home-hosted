import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  defaultReleaseTag,
  fallbackUiName,
  isGithubHost,
  isOwnRepo,
  isUiAsset,
  matchAsset,
  parseFileSource,
  parseRepoSlug,
  releaseApiUrl,
} from '#src/cli/ui-switch'

describe('parseRepoSlug', () => {
  it('accepts an owner/name slug and rejects anything else', () => {
    expect(parseRepoSlug('NamesMT/home-hosted')).toEqual({ owner: 'NamesMT', name: 'home-hosted' })
    expect(parseRepoSlug('  a/b  ')).toEqual({ owner: 'a', name: 'b' })
    expect(parseRepoSlug('a.b/c_d-1')).toEqual({ owner: 'a.b', name: 'c_d-1' })

    for (const value of ['namesmt', 'a/b/c', 'a/', '/b', '', 'a b/c', 'a/b c'])
      expect(parseRepoSlug(value), value).toBeNull()
  })
})

describe('tag resolution', () => {
  it('uses this CLI version for our own repo and the latest release for another', () => {
    const own = parseRepoSlug('NamesMT/home-hosted')!
    const other = parseRepoSlug('someone/their-panel')!

    expect(defaultReleaseTag(own, '1.2.3')).toBe('v1.2.3')
    expect(defaultReleaseTag(other, '1.2.3')).toBeNull()
    expect(isOwnRepo(own)).toBe(true)
    expect(isOwnRepo(parseRepoSlug('NamesMT/other')!)).toBe(false)
  })
})

describe('releaseApiUrl', () => {
  const repo = { owner: 'a', name: 'b' }

  it('addresses latest by endpoint and a tag by name', () => {
    expect(releaseApiUrl(repo, null)).toBe('https://api.github.com/repos/a/b/releases/latest')
    expect(releaseApiUrl(repo, '')).toBe('https://api.github.com/repos/a/b/releases/latest')
    expect(releaseApiUrl(repo, 'latest')).toBe('https://api.github.com/repos/a/b/releases/latest')
    expect(releaseApiUrl(repo, 'v1.2.3')).toBe('https://api.github.com/repos/a/b/releases/tags/v1.2.3')
    expect(releaseApiUrl(repo, 'a/b c')).toBe('https://api.github.com/repos/a/b/releases/tags/a%2Fb%20c')
  })
})

describe('isUiAsset', () => {
  it('is a .zip, case-insensitively, and nothing else', () => {
    for (const name of ['home-hosted-ui-stock.zip', 'my-ui.ZIP', ' ui.zip '])
      expect(isUiAsset(name), name).toBe(true)

    for (const name of ['home-hosted-ui-stock.tar.gz', 'zip', 'ui.zip.sig', 'ui.txt', ''])
      expect(isUiAsset(name), name).toBe(false)
  })
})

describe('matchAsset', () => {
  const names = ['home-hosted-ui-noc-console.zip', 'home-hosted-ui-stock.zip']

  it('takes an exact name first', () => {
    expect(matchAsset(names, 'home-hosted-ui-stock.zip')).toEqual({ ok: true, name: 'home-hosted-ui-stock.zip' })
  })

  it('falls back to case-insensitive and then to a single unambiguous substring', () => {
    expect(matchAsset(names, 'HOME-HOSTED-UI-STOCK.ZIP')).toEqual({ ok: true, name: 'home-hosted-ui-stock.zip' })
    expect(matchAsset(names, 'stock')).toEqual({ ok: true, name: 'home-hosted-ui-stock.zip' })
    expect(matchAsset(names, 'noc')).toEqual({ ok: true, name: 'home-hosted-ui-noc-console.zip' })
  })

  it('reports no match, and an ambiguous one, without guessing', () => {
    expect(matchAsset(names, 'ghost')).toMatchObject({ ok: false })
    expect(matchAsset(names, '')).toMatchObject({ ok: false })
    const ambiguous = matchAsset(names, 'home-hosted')
    expect(ambiguous.ok).toBe(false)
    expect(ambiguous.ok === false && ambiguous.error).toContain('more than one')
  })
})

describe('parseFileSource', () => {
  it('treats http(s) as a URL and everything else as a path', () => {
    expect(parseFileSource('https://example.com/ui.zip')).toEqual({ kind: 'url', url: 'https://example.com/ui.zip' })
    expect(parseFileSource('HTTP://example.com/ui.zip')).toEqual({ kind: 'url', url: 'HTTP://example.com/ui.zip' })
    expect(parseFileSource('./uis/dist/my-ui.zip')).toEqual({ kind: 'path', path: './uis/dist/my-ui.zip' })
    expect(parseFileSource('C:\\builds\\ui.zip')).toEqual({ kind: 'path', path: 'C:\\builds\\ui.zip' })
  })

  it('expands a leading ~ against the home directory', () => {
    expect(parseFileSource('~')).toEqual({ kind: 'path', path: os.homedir() })
    expect(parseFileSource('~/ui.zip')).toEqual({ kind: 'path', path: path.join(os.homedir(), 'ui.zip') })
  })
})

describe('isGithubHost', () => {
  it('is true only for GitHub hosts, which is where a token may go', () => {
    for (const url of ['https://api.github.com/repos/a/b', 'https://github.com/a/b/releases/download/v1/x.zip', 'https://objects.githubusercontent.com/x'])
      expect(isGithubHost(url), url).toBe(true)

    for (const url of ['https://example.com/ui.zip', 'https://notgithub.com/x', 'https://github.com.evil.test/x', 'not a url'])
      expect(isGithubHost(url), url).toBe(false)
  })
})

describe('fallbackUiName', () => {
  it('names the install after the asset or file', () => {
    expect(fallbackUiName('home-hosted-ui-stock.zip')).toBe('stock')
    expect(fallbackUiName('/tmp/builds/my-panel.zip')).toBe('my-panel')
    expect(fallbackUiName('ui.ZIP')).toBe('ui')
    expect(fallbackUiName('')).toBe('custom-ui')
  })
})
