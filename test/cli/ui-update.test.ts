import { describe, expect, it } from 'vitest'
import { impliedAsset, planUiUpdate, usableCandidates } from '#src/cli/ui-update'
import { officialTagFor } from '#src/services/ui-update'

const official = { name: 'noc-console', version: '1.0.0', repo: 'NamesMT/home-hosted', tag: 'v0.6.0', asset: 'home-hosted-ui-noc-console.zip', unix: 1790366625 }
const foreign = { name: 'my-ui', version: '2.3.0', repo: 'someone/their-ui', tag: 'v2.3.0', asset: 'my-ui.zip', unix: null }

describe('planUiUpdate', () => {
  it('does nothing at all for the stock UI, which ships with the panel', () => {
    expect(planUiUpdate(null, 'v0.7.0')).toEqual({ kind: 'stock' })
  })

  it('pairs our own UI with this panel\'s release, whoever built the panel', () => {
    const plan = planUiUpdate(official, 'v0.7.0')
    expect(plan.kind).toBe('official')
    expect(plan).toMatchObject({ target: 'v0.7.0' })
  })

  it('has nothing to offer when the UI never said where it came from', () => {
    const plan = planUiUpdate({ ...official, repo: null }, 'v0.7.0')
    expect(plan.kind).toBe('unidentifiable')
  })

  it('offers the releases of someone else\'s UI instead of deciding', () => {
    const releases = [
      { tag: 'v2.4.0', assets: [{ name: 'my-ui.zip' }] },
      { tag: 'v2.3.0', assets: [{ name: 'my-ui.zip' }] },
      { tag: 'v2.5.0', assets: [{ name: 'other-ui.zip' }] },
    ]
    const plan = planUiUpdate(foreign, 'v0.7.0', releases)
    expect(plan.kind).toBe('choice')
    expect(plan).toMatchObject({ asset: 'my-ui.zip', candidates: [{ tag: 'v2.4.0', asset: 'my-ui.zip' }] })
  })

  it('is unidentifiable when not even the name is known', () => {
    const plan = planUiUpdate({ ...foreign, name: '', asset: null }, 'v0.7.0')
    expect(plan.kind).toBe('unidentifiable')
  })
})

describe('usableCandidates', () => {
  const releases = [
    { tag: 'v3.0.0', assets: [{ name: 'ui.zip' }, { name: 'notes.txt' }] },
    { tag: 'v2.0.0', assets: [{ name: 'ui.zip' }] },
    { tag: 'v1.0.0', assets: [{ name: 'ui.zip' }] },
    { tag: 'v0.9.0', assets: [{ name: 'other.zip' }] },
  ]

  it('lists only releases carrying the asset in use, newer than the installed tag', () => {
    expect(usableCandidates(releases, 'ui.zip', 'newer', 'v2.0.0')).toEqual([{ tag: 'v3.0.0', asset: 'ui.zip' }])
  })

  it('lists older releases under --old, and never the installed one', () => {
    expect(usableCandidates(releases, 'ui.zip', 'older', 'v2.0.0')).toEqual([{ tag: 'v1.0.0', asset: 'ui.zip' }])
  })

  it('skips a release that does not carry the asset at all', () => {
    const found = usableCandidates(releases, 'ui.zip', 'newer', null)
    expect(found.map(entry => entry.tag)).toEqual(['v3.0.0', 'v2.0.0', 'v1.0.0'])
  })

  it('matches the asset by unambiguous substring, as ui-switch does', () => {
    expect(usableCandidates([{ tag: 'v9.0.0', assets: [{ name: 'home-hosted-ui-thing.zip' }] }], 'thing', 'newer', null))
      .toEqual([{ tag: 'v9.0.0', asset: 'home-hosted-ui-thing.zip' }])
  })

  it('offers nothing when the installed tag is the newest release', () => {
    expect(usableCandidates(releases, 'ui.zip', 'newer', 'v3.0.0')).toEqual([])
  })
})

describe('impliedAsset', () => {
  it('uses the declared asset when there is one', () => {
    expect(impliedAsset(foreign)).toBe('my-ui.zip')
  })

  it('falls back to the UI name when the archive declared no asset', () => {
    expect(impliedAsset({ ...foreign, asset: null })).toBe('my-ui.zip')
  })

  it('has nothing to imply without either', () => {
    expect(impliedAsset({ ...foreign, name: '', asset: '' })).toBeNull()
  })
})

describe('officialTagFor', () => {
  it('pairs our own repo with this panel version', () => {
    expect(officialTagFor(official, '1.2.3')).toEqual({ tag: 'v1.2.3', repo: 'NamesMT/home-hosted' })
  })

  it('leaves another repo, and a missing or malformed repo, alone', () => {
    expect(officialTagFor(foreign, '1.2.3')).toBeNull()
    expect(officialTagFor({ tag: 'v1.0.0' }, '1.2.3')).toBeNull()
    expect(officialTagFor({ repo: 'not a slug' }, '1.2.3')).toBeNull()
    expect(officialTagFor(null, '1.2.3')).toBeNull()
  })
})
