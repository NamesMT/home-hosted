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
