import type { ProxyRouteView } from '@shared/contracts'
import { proxyPatchSchema } from '@shared/contracts'
import { type } from 'arktype'
import { describe, expect, it } from 'vitest'
import {
  CERTIFICATE_STATE_META,
  certificateTitle,
  keepPort,
  routeCertificate,
  slugifyCertificateId,
  uniqueCertificateId,
} from '../src/lib/proxy'

/** A route view carrying only what the certificate line reads. */
function view(certificate?: { state: string, message: string | null }): ProxyRouteView {
  return {
    route: { id: 'a', host: 'a.example.com', enabled: true, target: 'external', workspace: '', server: '', url: 'http://10.0.0.5:1', path: '', tls: 'auto' },
    status: 'ok',
    upstream: '10.0.0.5:1',
    message: null,
    ...(certificate === undefined ? {} : { certificate }),
  } as ProxyRouteView
}

describe('certificate ids', () => {
  it('slugs a label, and falls back when there is nothing to slug', () => {
    expect(slugifyCertificateId('Home wildcard')).toBe('home-wildcard')
    expect(slugifyCertificateId('')).toBe('certificate')
    expect(slugifyCertificateId('---')).toBe('certificate')
    expect(slugifyCertificateId('_private')).toMatch(/^[a-z0-9]/)
  })

  it('steps around an id another certificate already uses', () => {
    expect(uniqueCertificateId('home', [])).toBe('home')
    expect(uniqueCertificateId('home', ['home'])).toBe('home-2')
    expect(uniqueCertificateId('home', ['home', 'home-2'])).toBe('home-3')
  })
})

describe('the certificate line', () => {
  it('says nothing for a route with TLS off, and nothing when the panel is older', () => {
    expect(routeCertificate(view({ state: 'off', message: null }))).toBeNull()
    expect(routeCertificate(view())).toBeNull()
    expect(CERTIFICATE_STATE_META.off).toBeNull()
  })

  it('maps every state to its chip, and flags the ones that need attention', () => {
    expect(routeCertificate(view({ state: 'issued', message: null }))).toMatchObject({ label: 'certificate ready', chip: 'chip--ok', danger: false, warn: false })
    expect(routeCertificate(view({ state: 'pending', message: null }))).toMatchObject({ chip: 'chip--warn', warn: true })
    expect(routeCertificate(view({ state: 'local', message: null }))).toMatchObject({ chip: 'chip--idle' })
    expect(routeCertificate(view({ state: 'uploaded', message: null }))).toMatchObject({ chip: 'chip--neutral' })
    expect(routeCertificate(view({ state: 'failed', message: 'boom' }))).toMatchObject({ chip: 'chip--danger', danger: true })
  })

  it('carries the panel’s own sentence for a failure', () => {
    expect(routeCertificate(view({ state: 'failed', message: 'Timeout during connect' }))?.message).toBe('Timeout during connect')
  })
})

describe('the certificate list', () => {
  it('shows the label, and the id when there is none', () => {
    expect(certificateTitle({ id: 'home', label: 'Home wildcard' })).toBe('Home wildcard')
    expect(certificateTitle({ id: 'home', label: '  ' })).toBe('home')
  })
})

/**
 * `v-model.number` writes an empty **string** when a port box is cleared — not a number and
 * not null. That string reached `patchProxy`'s own `proxyPatchSchema`, which rejected the
 * whole patch with "httpPort must be a number (was a string)" before sending anything, so
 * clearing one port to retype it lost every other pending proxy edit. Ordinary editing.
 */
describe('keepPort', () => {
  it('keeps the last valid port while the box is empty', () => {
    expect(keepPort('', 80)).toBe(80)
    expect(keepPort('', 443)).toBe(443)
    expect(keepPort('abc', 80)).toBe(80)
    expect(keepPort(null, 80)).toBe(80)
    expect(keepPort(undefined, 80)).toBe(80)
  })

  it('refuses a value the schema would refuse', () => {
    expect(keepPort('0', 80)).toBe(80)
    expect(keepPort('70000', 80)).toBe(80)
    expect(keepPort('-1', 80)).toBe(80)
  })

  it('takes a valid port, as a string or a number', () => {
    expect(keepPort('8080', 80)).toBe(8080)
    expect(keepPort(8443, 443)).toBe(8443)
    // The input reports an integer; a float is truncated rather than sent.
    expect(keepPort('8080.7', 80)).toBe(8080)
  })

  it('produces a body the client-side schema accepts', () => {
    // This is the point: the draft is validated by `proxyPatchSchema` before the request.
    const draft = { httpPort: keepPort('', 80), httpsPort: keepPort('8080', 443) }
    expect(draft).toEqual({ httpPort: 80, httpsPort: 8080 })
    expect(proxyPatchSchema(draft) instanceof type.errors).toBe(false)
  })
})
