import type { TlsStatus } from '#src/shared/contracts'
import { Buffer } from 'node:buffer'
import { createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from '#src/helpers/atomic'

/**
 * Stores an uploaded PEM pair and reports what it contains.
 *
 * The key is written 0600 and both files stay out of git. Nothing here binds a
 * socket — the control server reads the pair and hands it to srvx.
 */
export class TlsStore {
  private cached: { cert: string, key: string } | null = null
  private cachedMtime = ''

  constructor(private readonly dir: string) {}

  get directory(): string {
    return this.dir
  }

  get certPath(): string {
    return path.join(this.dir, 'control.crt.pem')
  }

  get keyPath(): string {
    return path.join(this.dir, 'control.key.pem')
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
      return {
        ...base,
        subject: x509.subject.replace(/\n/g, ', '),
        issuer: x509.issuer.replace(/\n/g, ', '),
        validFrom: new Date(x509.validFrom).toISOString(),
        validTo: validTo.toISOString(),
        daysRemaining,
        fingerprint: x509.fingerprint256,
        keyMatches: validatePair(pair.cert, pair.key).ok,
        error: daysRemaining < 0 ? 'the certificate has expired' : null,
      }
    }
    catch (error) {
      return { ...base, error: `invalid certificate: ${error instanceof Error ? error.message : String(error)}` }
    }
  }
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
    const key = createPrivateKey(privateKey)
    const fromKey = createPublicKey(key).export({ type: 'spki', format: 'der' })
    const fromCert = x509.publicKey.export({ type: 'spki', format: 'der' })
    if (!Buffer.from(fromKey).equals(Buffer.from(fromCert))) {
      return { ok: false, error: 'the private key does not match the certificate' }
    }
  }
  catch (error) {
    return { ok: false, error: `private key is not a valid PEM: ${error instanceof Error ? error.message : String(error)}` }
  }

  if (new Date(x509.validTo).getTime() < Date.now()) {
    return { ok: false, error: `the certificate expired on ${x509.validTo}` }
  }

  return { ok: true }
}
