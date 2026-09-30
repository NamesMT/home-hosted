import type { ProxyRouteView } from '@shared/contracts'
import { describe, expect, it } from 'vitest'
import {
  CERTIFICATE_STATE_META,
  certificateTitle,
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
  it('slugs a label, and falls back to a usable id when there is nothing to slug', () => {
    expect(slugifyCertificateId('Home wildcard')).toBe('home-wildcard')
    expect(slugifyCertificateId('  *.example.com  ')).toBe('example-com')
    expect(slugifyCertificateId('')).toBe('certificate')
    expect(slugifyCertificateId('---')).toBe('certificate')
    // The schema requires a leading letter or digit.
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
  })

  it('reads every state the panel can report', () => {
    expect(routeCertificate(view({ state: 'issued', message: null }))).toMatchObject({ label: 'certificate ready', tone: 'ok' })
    expect(routeCertificate(view({ state: 'pending', message: null }))).toMatchObject({ label: 'waiting for the CA', tone: 'warn' })
    expect(routeCertificate(view({ state: 'local', message: null }))).toMatchObject({ label: 'engine CA', tone: 'neutral' })
    expect(routeCertificate(view({ state: 'uploaded', message: null }))).toMatchObject({ label: 'uploaded pair', tone: 'info' })
    expect(CERTIFICATE_STATE_META.off).toBeNull()
  })

  it('carries the panel’s own sentence for a failure', () => {
    const failed = routeCertificate(view({ state: 'failed', message: 'Timeout during connect (likely firewall problem)' }))
    expect(failed).toMatchObject({ tone: 'danger' })
    expect(failed?.message).toContain('Timeout during connect')
  })
})

describe('the certificate list', () => {
  it('shows the label, and the id when there is none', () => {
    expect(certificateTitle({ id: 'home', label: 'Home wildcard' })).toBe('Home wildcard')
    expect(certificateTitle({ id: 'home', label: '   ' })).toBe('home')
  })
})
