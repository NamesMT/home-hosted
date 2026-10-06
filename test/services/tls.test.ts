import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TlsStore, validatePair } from '#src/services/tls'
import { hasOpenssl, hasOpensslExplicitDates } from '../support/capabilities'

let dir = ''
let cert = ''
let key = ''
let otherKey = ''

/**
 * Whether a real self-signed pair can be generated.
 *
 * Detected at module load, not in `beforeAll`: `it.runIf`/`it.skipIf` are evaluated when the
 * suite is collected, which happens before any hook runs. The alternative — an early `return
 * expect(true).toBe(true)` inside each test — reports a *pass* on a machine without hasOpenssl, so
 * a runner that cannot exercise the parsing paths says everything is fine. A skip is the honest
 * signal, and the repo already has the idiom (`it.runIf` in nanny/proc/port tests).
 */

beforeAll(async () => {
  if (!hasOpenssl)
    return
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hh-tls-'))

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
      '/CN=hh.test',
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
  catch (error) {
    // Not folded into the skip: `hasOpenssl version` succeeded, so a failure *here* is a broken
    // fixture, not a missing tool. Swallowing it would run the assertions against empty strings
    // and report whatever that produced.
    throw new Error(`could not generate a self-signed pair with hasOpenssl: ${String(error)}`)
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

  it.runIf(hasOpenssl)('reports a mismatched private key', () => {
    const result = validatePair(cert, otherKey)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('does not match')
  })

  it.runIf(hasOpenssl)('accepts a matching, unexpired pair', () => {
    expect(validatePair(cert, key)).toEqual({ ok: true })
  })

  /**
   * Both ends of the validity window, not just the expiry.
   *
   * A certificate whose `notBefore` is in the future was accepted and stored, and
   * `POST /settings/tls` then restarts the panel onto HTTPS — where every browser refuses it, so the
   * user is locked out of the UI with no way back except the filesystem. Only `validTo` was checked.
   */
  it.runIf(hasOpensslExplicitDates)('rejects a pair that is not valid yet', () => {
    const futureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-tls-future-'))
    try {
      execFileSync('openssl', [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        path.join(futureDir, 'key.pem'),
        '-out',
        path.join(futureDir, 'cert.pem'),
        '-subj',
        '/CN=hh.test',
        '-not_before',
        '20300101000000Z',
        '-not_after',
        '20300201000000Z',
      ], { stdio: 'ignore' })
      const futureCert = fs.readFileSync(path.join(futureDir, 'cert.pem'), 'utf8')
      const futureKey = fs.readFileSync(path.join(futureDir, 'key.pem'), 'utf8')

      const result = validatePair(futureCert, futureKey)
      expect(result.ok, 'a certificate browsers will refuse must not be accepted').toBe(false)
      expect(result.error).toContain('not valid until')

      // The store is the path the route uses, so the same pair must not be written there either.
      const store = new TlsStore(path.join(futureDir, 'store'))
      expect(store.save(futureCert, futureKey).ok).toBe(false)
      expect(store.present, 'nothing may be written for a pair that is not valid yet').toBe(false)
    }
    finally {
      fs.rmSync(futureDir, { recursive: true, force: true })
    }
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

  it.runIf(hasOpenssl)('stores the pair with a private key that is not world readable', async () => {
    const store = new TlsStore(path.join(dir, 'stored'))

    expect(store.save(cert, key)).toEqual({ ok: true })
    expect(store.present).toBe(true)
    // NTFS stores no POSIX mode, so the 0600 assertion belongs to the POSIX platforms.
    if (process.platform !== 'win32')
      expect(fs.statSync(store.keyPath).mode & 0o777).toBe(0o600)
    expect(store.load()?.cert).toContain('BEGIN CERTIFICATE')
  })

  it.runIf(hasOpenssl)('describes the certificate for the settings page', async () => {
    const store = new TlsStore(path.join(dir, 'described'))
    store.save(cert, key)

    const status = store.status(true)
    expect(status.subject).toContain('hh.test')
    expect(status.keyMatches).toBe(true)
    expect(status.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
    expect(status.daysRemaining).toBeGreaterThan(0)
    expect(status.error).toBeNull()
  })

  /**
   * The settings page names the real reason, and does not confuse it with a key mismatch.
   *
   * With only the expiry checked, a certificate valid from the future showed a positive
   * `daysRemaining` and a null `error` — the UI called it healthy while browsers refused it.
   */
  it.runIf(hasOpensslExplicitDates)('reports a pair that is not valid yet, keeping the key verdict separate', () => {
    const futureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-tls-future-status-'))
    try {
      execFileSync('openssl', [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        path.join(futureDir, 'key.pem'),
        '-out',
        path.join(futureDir, 'cert.pem'),
        '-subj',
        '/CN=future.test',
        '-not_before',
        '20300101000000Z',
        '-not_after',
        '20300201000000Z',
      ], { stdio: 'ignore' })
      const store = new TlsStore(path.join(futureDir, 'store'))
      fs.mkdirSync(store.directory, { recursive: true })
      fs.writeFileSync(store.certPath, fs.readFileSync(path.join(futureDir, 'cert.pem')))
      fs.writeFileSync(store.keyPath, fs.readFileSync(path.join(futureDir, 'key.pem')))

      const status = store.status(true)
      expect(status.error, 'not-yet-valid is the reason to show').toContain('not valid until')
      // The key genuinely matches this certificate; reporting the window problem as a key mismatch
      // would send the reader to fix the wrong file.
      expect(status.keyMatches, 'the key does match, and the UI should say so').toBe(true)
      expect(status.daysRemaining).toBeGreaterThan(0)
    }
    finally {
      fs.rmSync(futureDir, { recursive: true, force: true })
    }
  })

  it.runIf(hasOpenssl)('refuses to store a mismatched pair', async () => {
    const store = new TlsStore(path.join(dir, 'rejected'))
    const result = store.save(cert, otherKey)
    expect(result.ok).toBe(false)
    expect(store.present).toBe(false)
  })

  /**
   * A pair that cannot be served is refused, not handed to srvx.
   *
   * `serve({ tls })` **throws synchronously** on a mismatched pair
   * (`ERR_OSSL_X509_KEY_VALUES_MISMATCH`) — before `listen()`'s `ready()`/`error` race can catch it —
   * so `start()` propagates it and the panel does not boot at all. `save()` cannot be made atomic
   * across two files, and a pair also reaches disk by hand-copy, a restore, or a crash between the
   * writes; the guard is what keeps any of those from bricking the next start.
   *
   * Written directly into the store's own paths, since `save()` refuses this pair by design.
   */
  it.runIf(hasOpenssl)('does not serve a pair whose key does not match', async () => {
    const store = new TlsStore(path.join(dir, 'unservable'))
    fs.mkdirSync(store.directory, { recursive: true })
    fs.writeFileSync(store.certPath, cert)
    fs.writeFileSync(store.keyPath, otherKey)

    expect(store.present, 'the files are there, so `present` is honest').toBe(true)
    expect(store.servable(), 'but they must not be handed to the server').toBeNull()
  })

  /**
   * A pair the server refuses must not read as healthy.
   *
   * `status()` reported `keyMatches: false` with a **null** `error` for a mismatched pair, so the page
   * said TLS was enabled and fine while `servable()` had quietly fallen back to http. The two fields
   * answer different questions, and both are now filled.
   */
  it.runIf(hasOpenssl)('reports a mismatched pair as an error, keeping the key verdict', () => {
    const store = new TlsStore(path.join(dir, 'status-mismatch'))
    fs.mkdirSync(store.directory, { recursive: true })
    fs.writeFileSync(store.certPath, cert)
    fs.writeFileSync(store.keyPath, otherKey)

    const status = store.status(true)
    expect(status.keyMatches).toBe(false)
    expect(status.error, 'a pair that will not be served must say why').toContain('does not match')
  })

  it.runIf(hasOpenssl)('serves a pair that does match', async () => {
    const store = new TlsStore(path.join(dir, 'servable'))
    store.save(cert, key)
    expect(store.servable()).toEqual({ cert: expect.stringContaining('BEGIN CERTIFICATE') as unknown as string, key: expect.any(String) as unknown as string })
  })

  it.runIf(hasOpenssl)('clears both files', async () => {
    const store = new TlsStore(path.join(dir, 'cleared'))
    store.save(cert, key)
    store.clear()

    expect(store.present).toBe(false)
    expect(fs.existsSync(store.certPath)).toBe(false)
    expect(fs.existsSync(store.keyPath)).toBe(false)
  })
})
