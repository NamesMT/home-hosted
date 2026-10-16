import type { SecretPart } from '#src/config/secret-parts'
import { describe, expect, it } from 'vitest'
import { mergeSecrets, parseSecrets, pickSecrets, presentSecretKeys, secretParts } from '#src/config/secret-parts'

const ALL_KEYS = ['password', 'apiToken', 'telegram', 'ddns']

describe('secretParts', () => {
  it('returns only the global parts, in the fixed order', () => {
    expect(secretParts('global', ALL_KEYS)).toEqual([
      { key: 'password', fields: ['password'], scope: 'global' },
      { key: 'apiToken', fields: ['apiToken'], scope: 'global' },
    ])
  })

  it('returns telegram then ddns, and ddns carries its KDF metadata', () => {
    expect(secretParts('workspace', ALL_KEYS)).toEqual([
      { key: 'telegram', fields: ['telegram'], scope: 'workspace' },
      { key: 'ddns', fields: ['ddns', 'ddnsKdf'], scope: 'workspace' },
    ])
  })

  it('invents no part for a secret that is not present', () => {
    expect(secretParts('workspace', ['telegram']).map(part => part.key)).toEqual(['telegram'])
    expect(secretParts('global', ['telegram', 'ddns'])).toEqual([])
  })

  it('gives a future top-level key its own part, after the known ones and sorted', () => {
    const parts = secretParts('workspace', [...ALL_KEYS, 'webhookSecret', 'auditLog'])
    expect(parts.map(part => part.key)).toEqual(['telegram', 'ddns', 'auditLog', 'webhookSecret'])
    expect(parts.at(-1)).toEqual({ key: 'webhookSecret', fields: ['webhookSecret'], scope: 'workspace' })
  })

  it('never lets a key of the other scope leak into a part list', () => {
    const keys = secretParts('global', ALL_KEYS).map(part => part.key)
    expect(keys).not.toContain('telegram')
    expect(keys).not.toContain('ddns')
  })

  it('keeps the ddns KDF with the sealed entries in every scope it appears in', () => {
    const ddns = secretParts('workspace', ['ddns']).find(part => part.key === 'ddns')
    expect(ddns?.fields).toEqual(['ddns', 'ddnsKdf'])
  })

  // The scope of a key this release does not know is the file it was read from. Classifying
  // by name sent every future key to the workspace, which dropped a future *global* secret.
  it('takes an unknown key in the global file as a global part', () => {
    const parts = secretParts('global', ['password', 'futureGlobalSecret'])
    expect(parts.map(part => part.key)).toEqual(['password', 'futureGlobalSecret'])
    expect(parts.at(-1)).toEqual({ key: 'futureGlobalSecret', fields: ['futureGlobalSecret'], scope: 'global' })
  })

  it('does not offer a key another part already carries', () => {
    const parts = secretParts('workspace', ['ddns', 'ddnsKdf'])
    expect(parts.map(part => part.key)).toEqual(['ddns'])
    expect(parts[0]?.fields).toEqual(['ddns', 'ddnsKdf'])
  })
})

describe('presentSecretKeys', () => {
  it('keeps the keys holding a value and drops the null ones', () => {
    expect(presentSecretKeys({ password: {}, apiToken: null, telegram: { botToken: 'x' } }))
      .toEqual(['password', 'telegram'])
  })

  it('is empty for an empty document', () => {
    expect(presentSecretKeys({})).toEqual([])
  })
})

describe('pickSecrets', () => {
  it('returns null when the source carries nothing that was asked for', () => {
    expect(pickSecrets({ password: null }, ['ddns', 'ddnsKdf'])).toBeNull()
    expect(pickSecrets({}, ['telegram'])).toBeNull()
  })

  it('returns a document holding only the requested fields', () => {
    const source = { telegram: { botToken: 'x' }, ddns: { cf: { algo: 'aes-256-gcm' } }, password: { hash: 'h' } }
    const picked = pickSecrets(source, ['telegram'])
    expect(picked).not.toBeNull()
    expect(JSON.parse(picked!)).toEqual({ telegram: { botToken: 'x' } })
  })

  it('carries ddns and ddnsKdf together', () => {
    const source = { ddns: { cf: {} }, ddnsKdf: { algo: 'scrypt' }, telegram: null }
    expect(JSON.parse(pickSecrets(source, ['ddns', 'ddnsKdf'])!)).toEqual({ ddns: source.ddns, ddnsKdf: source.ddnsKdf })
  })

  it('omits a field that is present as a key but null', () => {
    expect(JSON.parse(pickSecrets({ telegram: { botToken: 'x' }, ddns: null }, ['telegram', 'ddns'])!))
      .toEqual({ telegram: { botToken: 'x' } })
  })
})

describe('parseSecrets', () => {
  it('tolerates broken JSON', () => {
    expect(parseSecrets('{"telegram":')).toEqual({})
    expect(parseSecrets('')).toEqual({})
  })

  it('tolerates a document that is not an object', () => {
    expect(parseSecrets('null')).toEqual({})
    expect(parseSecrets('[1,2]')).toEqual({})
    expect(parseSecrets('"text"')).toEqual({})
    expect(parseSecrets('42')).toEqual({})
  })

  it('parses a real document unchanged', () => {
    expect(parseSecrets('{"telegram":{"botToken":"x"}}')).toEqual({ telegram: { botToken: 'x' } })
  })
})

describe('mergeSecrets', () => {
  it('preserves every key outside the fields being restored', () => {
    const current = { password: { hash: 'h' }, telegram: { botToken: 'old' }, ddns: { cf: {} }, ddnsKdf: { algo: 'scrypt' } }
    const merged = mergeSecrets(current, { telegram: { botToken: 'new' } }, ['telegram'])
    expect(merged).toEqual({ ...current, telegram: { botToken: 'new' } })
    expect(merged.ddns).toBe(current.ddns)
  })

  it('deletes a field the piece no longer carries', () => {
    const merged = mergeSecrets({ telegram: { botToken: 'old' }, ddns: { cf: {} } }, {}, ['telegram'])
    expect(merged).toEqual({ ddns: { cf: {} } })
    expect('telegram' in merged).toBe(false)
  })

  it('deletes a field the piece carries as null', () => {
    expect(mergeSecrets({ telegram: { botToken: 'old' } }, { telegram: null }, ['telegram'])).toEqual({})
  })

  it('does not touch a field of the piece that is not in the fields list', () => {
    const piece = { telegram: { botToken: 'new' }, ddns: { evil: {} }, ddnsKdf: { algo: 'scrypt' } }
    expect(mergeSecrets({ ddns: { cf: {} } }, piece, ['telegram']))
      .toEqual({ ddns: { cf: {} }, telegram: { botToken: 'new' } })
  })

  it('does not mutate its arguments', () => {
    const current = { telegram: { botToken: 'old' }, ddns: { cf: {} } }
    const piece = { telegram: { botToken: 'new' } }
    const snapshotCurrent = structuredClone(current)
    const snapshotPiece = structuredClone(piece)
    mergeSecrets(current, piece, ['telegram', 'ddnsKdf'])
    expect(current).toEqual(snapshotCurrent)
    expect(piece).toEqual(snapshotPiece)
  })
})

describe('pick, parse and merge round-trip', () => {
  it('reproduces the picked part, KDF metadata included', () => {
    const source = {
      password: { hash: 'h' },
      telegram: { botToken: 'x' },
      ddns: { cf: { algo: 'aes-256-gcm', data: 'sealed' } },
      ddnsKdf: { algo: 'scrypt', salt: 's' },
    }
    const parts: SecretPart[] = secretParts('workspace', presentSecretKeys(source))
    const ddns = parts.find(part => part.key === 'ddns')!
    const picked = pickSecrets(source, ddns.fields)!
    const piece = parseSecrets(picked)
    expect(mergeSecrets({}, piece, ddns.fields)).toEqual({ ddns: source.ddns, ddnsKdf: source.ddnsKdf })
  })

  it('restores one part into a live document without disturbing the rest', () => {
    const archive = parseSecrets(pickSecrets({ telegram: { botToken: 'archived' } }, ['telegram'])!)
    const live = { telegram: { botToken: 'live' }, ddns: { cf: {} }, ddnsKdf: { algo: 'scrypt' } }
    expect(mergeSecrets(live, archive, ['telegram']))
      .toEqual({ telegram: { botToken: 'archived' }, ddns: { cf: {} }, ddnsKdf: { algo: 'scrypt' } })
  })

  it('clears a restored secret the older archive predates', () => {
    const archive = parseSecrets(pickSecrets({ password: { hash: 'h' } }, ['telegram'])!)
    const live = { telegram: { botToken: 'live' }, ddns: { cf: {} } }
    expect(mergeSecrets(live, archive, ['telegram'])).toEqual({ ddns: { cf: {} } })
  })
})
