import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TlsStore, validatePair } from '#src/services/tls'

let dir = ''
let cert = ''
let key = ''
let otherKey = ''
let openssl = true

beforeAll(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh2-tls-'))

  try {
    // A real self-signed pair, so the parsing paths are exercised for real.
    execFileSync('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      path.join(dir, 'key.pem'),
      '-out',
      path.join(dir, 'cert.pem'),
      '-days',
      '3',
      '-subj',
      '/CN=hh2.test',
    ], { stdio: 'ignore' })
    execFileSync('openssl', [
      'genrsa',
      '-out',
      path.join(dir, 'other-key.pem'),
      '2048',
    ], { stdio: 'ignore' })

    cert = await fs.promises.readFile(path.join(dir, 'cert.pem'), 'utf8')
    key = await fs.promises.readFile(path.join(dir, 'key.pem'), 'utf8')
    otherKey = await fs.promises.readFile(path.join(dir, 'other-key.pem'), 'utf8')
  }
  catch {
    openssl = false
  }
})

afterAll(async () => {
  if (dir.length > 0)
    await fs.promises.rm(dir, { recursive: true, force: true })
})

describe('tls pair validation', () => {
  it('rejects junk instead of writing it', () => {
    expect(validatePair('not a cert', key).ok).toBe(false)
    expect(validatePair('not a cert', key).error).toContain('certificate')
  })

  it('reports a mismatched private key', () => {
    if (!openssl)
      return expect(true).toBe(true)
    const result = validatePair(cert, otherKey)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('does not match')
  })

  it('accepts a matching, unexpired pair', () => {
    if (!openssl)
      return expect(true).toBe(true)
    expect(validatePair(cert, key)).toEqual({ ok: true })
  })
})

describe('tls store', () => {
  it('reports nothing when disabled and nothing uploaded', async () => {
    const store = new TlsStore(path.join(dir, 'empty'))
    const status = store.status(false)
    expect(status.certPresent).toBe(false)
    expect(status.enabled).toBe(false)
    expect(status.error).toBeNull()
  })

  it('flags an enabled-but-empty configuration', async () => {
    const store = new TlsStore(path.join(dir, 'missing'))
    expect(store.status(true).error).toContain('no certificate')
  })

  it('stores the pair with a private key that is not world readable', async () => {
    if (!openssl)
      return expect(true).toBe(true)
    const store = new TlsStore(path.join(dir, 'stored'))

    expect(store.save(cert, key)).toEqual({ ok: true })
    expect(store.present).toBe(true)
    expect(fs.statSync(store.keyPath).mode & 0o777).toBe(0o600)
    expect(store.load()?.cert).toContain('BEGIN CERTIFICATE')
  })

  it('describes the certificate for the settings page', async () => {
    if (!openssl)
      return expect(true).toBe(true)
    const store = new TlsStore(path.join(dir, 'described'))
    store.save(cert, key)

    const status = store.status(true)
    expect(status.subject).toContain('hh2.test')
    expect(status.keyMatches).toBe(true)
    expect(status.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
    expect(status.daysRemaining).toBeGreaterThan(0)
    expect(status.error).toBeNull()
  })

  it('refuses to store a mismatched pair', async () => {
    if (!openssl)
      return expect(true).toBe(true)
    const store = new TlsStore(path.join(dir, 'rejected'))
    const result = store.save(cert, otherKey)
    expect(result.ok).toBe(false)
    expect(store.present).toBe(false)
  })

  it('clears both files', async () => {
    if (!openssl)
      return expect(true).toBe(true)
    const store = new TlsStore(path.join(dir, 'cleared'))
    store.save(cert, key)
    store.clear()

    expect(store.present).toBe(false)
    expect(fs.existsSync(store.certPath)).toBe(false)
    expect(fs.existsSync(store.keyPath)).toBe(false)
  })
})
