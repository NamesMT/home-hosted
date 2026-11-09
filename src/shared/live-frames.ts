import type { AppState, SseMessage } from './contracts'
import { type } from 'arktype'
import { appStateSchema, sseMessageSchema } from './contracts'
import { isRecord } from './shape'

/**
 * The client side of the frame contract: strict where a UI depends on structure, tolerant of a value
 * it has not heard of.
 *
 * The full schema closes every enum (`serverStatusSchema`, `logStreamSchema`, …), which is right for
 * the panel and its spec but wrong for a client: one status a newer panel added failed the whole
 * frame, every frame after it too, and the UI froze on the last frame it understood. So a frame
 * that fails the full schema is still accepted when its envelope (`type`, `ts`) and the containers a
 * view walks (workspaces, servers, lines) have the right shape; the leaves are shown as they came.
 */

export interface ParsedFrame {
  frame: SseMessage
  /** True when the full schema refused the frame and only the structural check passed. */
  lenient: boolean
}

const isString = (value: unknown): value is string => typeof value === 'string'
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

function isServerShape(value: unknown): boolean {
  return isRecord(value) && isString(value.id) && isString(value.status) && isRecord(value.config)
}

function isWorkspaceShape(value: unknown): boolean {
  return isRecord(value)
    && isString(value.id)
    && Array.isArray(value.servers)
    && value.servers.every(isServerShape)
}

/** The containers every view reads without a guard; anything below them is a displayed leaf. */
export function isStateShape(value: unknown): value is AppState {
  return isRecord(value)
    && isRecord(value.control)
    && isRecord(value.host)
    && isRecord(value.backups)
    && isRecord(value.ui)
    && Array.isArray(value.workspaces)
    && value.workspaces.every(isWorkspaceShape)
    && (value.proxy === undefined || isRecord(value.proxy))
}

function isLineShape(value: unknown): boolean {
  return isRecord(value) && isNumber(value.ts) && isString(value.stream) && isString(value.text)
}

function isFrameShape(value: unknown): boolean {
  if (!isRecord(value) || !isNumber(value.ts))
    return false
  if (value.workspaceId !== undefined && !isString(value.workspaceId))
    return false
  switch (value.type) {
    case 'hello':
    case 'state':
      return isStateShape(value.state)
    case 'server':
      return isString(value.serverId) && isServerShape(value.server)
    case 'log':
      return isString(value.serverId) && Array.isArray(value.lines) && value.lines.every(isLineShape)
    default:
      return false
  }
}

/** One SSE `data` payload, or `null` for anything a UI could not safely render. */
export function parseFrame(raw: string): ParsedFrame | null {
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  }
  catch {
    return null
  }
  const strict = sseMessageSchema(payload)
  if (!(strict instanceof type.errors))
    return { frame: strict, lenient: false }
  return isFrameShape(payload) ? { frame: payload as SseMessage, lenient: true } : null
}

/** The same rule for `GET /api/state`: the snapshot a UI loads before its stream opens. */
export function parseState(payload: unknown): AppState | null {
  const strict = appStateSchema(payload)
  if (!(strict instanceof type.errors))
    return strict
  return isStateShape(payload) ? payload : null
}
