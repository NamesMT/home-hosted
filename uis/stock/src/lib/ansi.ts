/**
 * Minimal ANSI → span parser for log output.
 *
 * Handles SGR only (colour, weight, decoration) plus the common "erase line"
 * and OSC title sequences, which are stripped. Everything else passes through
 * as text so a badly behaved child cannot lose its own output.
 */

export interface AnsiSpan {
  text: string
  fg: string | null
  bg: string | null
  bold: boolean
  dim: boolean
  italic: boolean
  underline: boolean
}

/** xterm's 16 ANSI colours, tuned a touch for each theme. */
const BASE_DARK = [
  '#3f4a5c',
  '#f07178',
  '#7fd88f',
  '#e6b673',
  '#82aaff',
  '#c792ea',
  '#7fdbca',
  '#c7d2e3',
  '#5a6779',
  '#ff8b92',
  '#9ae6a8',
  '#f2c98a',
  '#9dbaff',
  '#d7aef0',
  '#9ce9dc',
  '#eef3fb',
]

const BASE_LIGHT = [
  '#4b5563',
  '#c0392b',
  '#1c7c3f',
  '#9a6700',
  '#2f5fe0',
  '#7c3aed',
  '#0b6f89',
  '#334155',
  '#6b7280',
  '#d64535',
  '#22854a',
  '#a8620d',
  '#3f6bff',
  '#8b5cf6',
  '#0e7d9c',
  '#0f1722',
]

/** ESC is the whole point of the parser, so control characters are expected here. */
/* eslint-disable no-control-regex */
const SGR_RE = /\u001B\[([0-9;]*)m/g
/** CSI sequences that are not SGR, plus OSC strings. */
const STRIP_RE = /\u001B(?:\[[0-9;?]*[A-HJKSTfhilmnprsu]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)?|[()][0-9A-Z])/g
/* eslint-enable no-control-regex */

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, value))
}

function cubeChannel(value: number): number {
  return value === 0 ? 0 : 55 + value * 40
}

function color256(index: number, dark: boolean): string {
  const base = dark ? BASE_DARK : BASE_LIGHT
  if (index < 16)
    return base[index] ?? base[7]!
  if (index < 232) {
    const n = index - 16
    const r = cubeChannel(Math.floor(n / 36))
    const g = cubeChannel(Math.floor((n % 36) / 6))
    const b = cubeChannel(n % 6)
    return `rgb(${r} ${g} ${b})`
  }
  const gray = 8 + (index - 232) * 10
  return `rgb(${gray} ${gray} ${gray})`
}

interface AnsiState {
  fg: string | null
  bg: string | null
  bold: boolean
  dim: boolean
  italic: boolean
  underline: boolean
}

function freshState(): AnsiState {
  return { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false }
}

function applySgr(state: AnsiState, params: string, dark: boolean): void {
  const codes = params.length === 0 ? [0] : params.split(';').map(part => (part.length === 0 ? 0 : Number(part)))
  for (let i = 0; i < codes.length; i += 1) {
    const code = codes[i]!
    if (code === 0) {
      Object.assign(state, freshState())
    }
    else if (code === 1) {
      state.bold = true
    }
    else if (code === 2) {
      state.dim = true
    }
    else if (code === 3) {
      state.italic = true
    }
    else if (code === 4) {
      state.underline = true
    }
    else if (code === 22) {
      state.bold = false
      state.dim = false
    }
    else if (code === 23) {
      state.italic = false
    }
    else if (code === 24) {
      state.underline = false
    }
    else if (code === 39) {
      state.fg = null
    }
    else if (code === 49) {
      state.bg = null
    }
    else if (code >= 30 && code <= 37) {
      state.fg = (dark ? BASE_DARK : BASE_LIGHT)[code - 30] ?? null
    }
    else if (code >= 90 && code <= 97) {
      state.fg = (dark ? BASE_DARK : BASE_LIGHT)[code - 90 + 8] ?? null
    }
    else if (code >= 40 && code <= 47) {
      state.bg = (dark ? BASE_DARK : BASE_LIGHT)[code - 40] ?? null
    }
    else if (code >= 100 && code <= 107) {
      state.bg = (dark ? BASE_DARK : BASE_LIGHT)[code - 100 + 8] ?? null
    }
    else if (code === 38 || code === 48) {
      const target: 'fg' | 'bg' = code === 38 ? 'fg' : 'bg'
      const mode = codes[i + 1]
      if (mode === 5 && codes[i + 2] !== undefined) {
        state[target] = color256(clampByte(codes[i + 2]!), dark)
        i += 2
      }
      else if (mode === 2) {
        const r = clampByte(codes[i + 2] ?? 0)
        const g = clampByte(codes[i + 3] ?? 0)
        const b = clampByte(codes[i + 4] ?? 0)
        state[target] = `rgb(${r} ${g} ${b})`
        i += 4
      }
    }
  }
}

function pushSpan(spans: AnsiSpan[], text: string, state: AnsiState): void {
  if (text.length === 0)
    return
  const previous = spans[spans.length - 1]
  // Coalesce identical runs: fewer nodes, same pixels.
  if (previous
    && previous.fg === state.fg
    && previous.bg === state.bg
    && previous.bold === state.bold
    && previous.dim === state.dim
    && previous.italic === state.italic
    && previous.underline === state.underline) {
    previous.text += text
    return
  }
  spans.push({ text, ...state })
}

/** True when the text carries any escape sequence worth parsing. */
export function hasAnsi(text: string): boolean {
  return text.includes('\u001B')
}

export function parseAnsi(text: string, dark = true): AnsiSpan[] {
  if (!hasAnsi(text))
    return [{ text, fg: null, bg: null, bold: false, dim: false, italic: false, underline: false }]

  const spans: AnsiSpan[] = []
  const state = freshState()
  let cursor = 0

  SGR_RE.lastIndex = 0
  let match = SGR_RE.exec(text)
  while (match !== null) {
    pushSpan(spans, text.slice(cursor, match.index).replace(STRIP_RE, ''), state)
    applySgr(state, match[1] ?? '', dark)
    cursor = match.index + match[0].length
    match = SGR_RE.exec(text)
  }
  pushSpan(spans, text.slice(cursor).replace(STRIP_RE, ''), state)

  return spans
}
