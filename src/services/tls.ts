import type { TlsStatus } from '#src/shared/contracts'
import { Buffer } from 'node:buffer'
import { createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from '#src/helpers/atomic'
import { logger } from '#src/helpers/logger'

/**
 * Stores an uploaded PEM pair and reports what it contains.
 *
 * The key is written 0600 and both files stay out of git. Nothing here binds a
 * socket — the control server reads the pair and hands it to srvx. The reverse
 * proxy keeps its own pair in its own directory through the same class.
 */
export class TlsStore {
  private cached: { cert: string, key: string } | null = null
  private cachedMtime = ''

  constructor(private readonly dir: string, private readonly name = 'control') {}

  get directory(): string {
    return this.dir
  }

  get certPath(): string {
    return path.join(this.dir, `${this.name}.crt.pem`)
  }

  get keyPath(): string {
    return path.join(this.dir, `${this.name}.key.pem`)
  }

  get present(): boolean {
    return fs.existsSync(this.certPath) && fs.existsSync(this.keyPath)
  }

  /** Returns the PEM pair, re-read when the files change on disk. */
  load(): { cert: string, key: string } | null {
    if (!this.present) {
      this.cached = null
      return null
    }

    const key = [this.certPath, this.keyPath].map((file) => {
      try {
        return `${fs.statSync(file).mtimeMs}`
      }
      catch {
        return 'x'
      }
    }).join(':')

    if (this.cached !== null && key === this.cachedMtime)
      return this.cached

    try {
      this.cached = {
        cert: fs.readFileSync(this.certPath, 'utf8'),
        key: fs.readFileSync(this.keyPath, 'utf8'),
      }
      this.cachedMtime = key
      return this.cached
    }
    catch {
      this.cached = null
      return null
    }
  }

  save(certificate: string, privateKey: string): { ok: boolean, error?: string } {
    const validation = validatePair(certificate, privateKey)
    if (!validation.ok)
      return { ok: false, error: validation.error }

    fs.mkdirSync(this.dir, { recursive: true })
    writeFileAtomic(this.certPath, `${certificate.trimEnd()}\n`)
    writeFileAtomic(this.keyPath, `${privateKey.trimEnd()}\n`, { mode: 0o600 })
    this.cached = null
    this.cachedMtime = ''
    return { ok: true }
  }

  /**
   * The pair to serve, or `null` when there is nothing servable.
   *
   * `load()` returns whatever is on disk, and `serve({ tls })` **throws synchronously** on a pair that
   * does not match (`ERR_OSSL_X509_KEY_VALUES_MISMATCH`) — before `listen()`'s `ready()`/`error` race
   * can catch it. A mismatched pair therefore fails the reboot: hand-copied files, a restore, or a
   * crash between `save()`'s two writes all reach it, and the panel reports an OpenSSL code instead of
   * booting on http or naming the problem. Validated here, where the answer is still recoverable.
   */
  servable(): { cert: string, key: string } | null {
    const pair = this.load()
    if (pair === null)
      return null
    const validation = validatePair(pair.cert, pair.key)
    if (!validation.ok) {
      logger.warn(`the stored TLS pair will not be served: ${validation.error ?? 'it is not usable'}`)
      return null
    }
    return pair
  }

  clear(): void {
    for (const file of [this.certPath, this.keyPath]) {
      try {
        fs.rmSync(file, { force: true })
      }
      catch {
        // Nothing to remove.
      }
    }
    this.cached = null
  }

  status(enabled: boolean): TlsStatus {
    const base: TlsStatus = {
      enabled,
      certPresent: this.present,
      subject: null,
      issuer: null,
      validFrom: null,
      validTo: null,
      daysRemaining: null,
      fingerprint: null,
      keyMatches: null,
      error: null,
    }

    if (!this.present) {
      return enabled ? { ...base, error: 'TLS is enabled but no certificate has been uploaded' } : base
    }

    const pair = this.load()
    if (pair === null)
      return { ...base, error: 'the stored certificate could not be read' }

    try {
      const x509 = new X509Certificate(pair.cert)
      const validTo = new Date(x509.validTo)
      const daysRemaining = Math.floor((validTo.getTime() - Date.now()) / 86_400_000)
      // The key verdict is computed once, and never by `validatePair`: that also fails a certificate
      // outside its validity window, so a window problem would read as "the key does not match" and
      // send the reader to the wrong file.
      const keyMatches = publicKeysMatch(pair.cert, pair.key)
      return {
        ...base,
        subject: x509.subject.replace(/\n/g, ', '),
        issuer: x509.issuer.replace(/\n/g, ', '),
        validFrom: new Date(x509.validFrom).toISOString(),
        validTo: validTo.toISOString(),
        daysRemaining,
        fingerprint: x509.fingerprint256,
        keyMatches,
        // The same guards the upload path and `servable()` use, so the page names the real reason — and
        // a pair the server refuses is never shown as healthy while the panel quietly serves http. A
        // `keyMatches: false` with a null `error` read as "enabled and fine".
        error: validityError(x509) ?? (keyMatches ? null : 'the private key does not match the certificate'),
      }
    }
    catch (error) {
      return { ...base, error: `invalid certificate: ${error instanceof Error ? error.message : String(error)}` }
    }
  }
}

/** Whether the certificate's validity window covers now. Both ends, from one place. */
function validityError(x509: X509Certificate, now = Date.now()): string | null {
  if (new Date(x509.validFrom).getTime() > now)
    return `the certificate is not valid until ${x509.validFrom}`
  if (new Date(x509.validTo).getTime() < now)
    return `the certificate expired on ${x509.validTo}`
  return null
}

/** Whether the private key is the one that certificate was issued for. */
function publicKeysMatch(certificate: string, privateKey: string): boolean {
  const fromKey = createPublicKey(createPrivateKey(privateKey)).export({ type: 'spki', format: 'der' })
  const fromCert = new X509Certificate(certificate).publicKey.export({ type: 'spki', format: 'der' })
  return Buffer.from(fromKey).equals(Buffer.from(fromCert))
}

/** Checks the certificate parses, is time-valid, and matches the private key. */
export function validatePair(certificate: string, privateKey: string): { ok: boolean, error?: string } {
  let x509: X509Certificate
  try {
    x509 = new X509Certificate(certificate)
  }
  catch (error) {
    return { ok: false, error: `certificate is not a valid PEM: ${error instanceof Error ? error.message : String(error)}` }
  }

  try {
    if (!publicKeysMatch(certificate, privateKey))
      return { ok: false, error: 'the private key does not match the certificate' }
  }
  catch (error) {
    return { ok: false, error: `private key is not a valid PEM: ${error instanceof Error ? error.message : String(error)}` }
  }

  // Both ends of the window. Checking only `validTo` accepted a certificate whose `notBefore` is in
  // the future — browsers refuse one, so `POST /settings/tls` saved it and moved the panel to HTTPS
  // answering with an untrusted certificate.
  const invalid = validityError(x509)
  if (invalid !== null)
    return { ok: false, error: invalid }

  return { ok: true }
}
