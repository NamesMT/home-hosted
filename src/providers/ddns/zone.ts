import { normalizeHost } from '#src/providers/ddns/types'

/**
 * Public suffixes that take one extra label, so `home.example.co.uk` splits as
 * `home` in `example.co.uk` instead of `home.example` in `co.uk`. A per-domain
 * `zone` overrides this, which is the escape hatch for anything not listed.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  'ac.uk',
  'co.in',
  'co.jp',
  'co.ke',
  'co.kr',
  'co.nz',
  'co.uk',
  'co.za',
  'com.au',
  'com.br',
  'com.cn',
  'com.hk',
  'com.mx',
  'com.sg',
  'com.tr',
  'com.tw',
  'edu.au',
  'gov.uk',
  'net.au',
  'net.uk',
  'org.au',
  'org.uk',
])

export interface HostParts {
  /** The registered domain (the zone), e.g. `example.com`. */
  zone: string
  /** The record name inside that zone; `@` for the apex. */
  name: string
}

/**
 * Splits a hostname into the zone and the record name, which is what every
 * provider that has no zone lookup needs. `zone` short-circuits the heuristic.
 */
export function splitHost(host: string, zone?: string): HostParts {
  const normalized = normalizeHost(host)
  const override = normalizeHost(zone ?? '')
  const resolved = override.length > 0 ? override : guessZone(normalized)
  if (normalized === resolved)
    return { zone: resolved, name: '@' }
  return { zone: resolved, name: normalized.endsWith(`.${resolved}`) ? normalized.slice(0, -(resolved.length + 1)) : normalized }
}

function guessZone(host: string): string {
  const labels = host.split('.')
  if (labels.length <= 2)
    return host
  const lastTwo = labels.slice(-2).join('.')
  const lastThree = labels.slice(-3).join('.')
  return MULTI_LABEL_SUFFIXES.has(lastTwo) ? lastThree : lastTwo
}
