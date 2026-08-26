import type { CsiToken, Position, Token } from './parser.js'

const SGR_NAMES: Record<number, string> = {
  0: 'reset',
  1: 'bold',
  2: 'dim',
  3: 'italic',
  4: 'underline',
  5: 'blink (slow)',
  6: 'blink (fast)',
  7: 'reverse video',
  8: 'conceal',
  9: 'strikethrough',
  22: 'normal intensity',
  23: 'not italic',
  24: 'not underlined',
  25: 'not blinking',
  27: 'not reversed',
  28: 'reveal',
  29: 'not struck through',
  39: 'default foreground',
  49: 'default background',
}

const BASE_COLORS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']

function describeSgrParam(param: string): string {
  const n = param === '' ? 0 : Number(param)
  if (Number.isNaN(n)) return `unknown(${param})`
  const named = SGR_NAMES[n]
  if (named !== undefined) return named
  if (n >= 30 && n <= 37) return `foreground=${BASE_COLORS[n - 30]}`
  if (n >= 40 && n <= 47) return `background=${BASE_COLORS[n - 40]}`
  if (n >= 90 && n <= 97) return `foreground=bright-${BASE_COLORS[n - 90]}`
  if (n >= 100 && n <= 107) return `background=bright-${BASE_COLORS[n - 100]}`
  return `code ${n}`
}

function describeSgr(token: CsiToken): string {
  if (token.params.length === 0) return 'SGR: reset'
  return 'SGR: ' + token.params.map(describeSgrParam).join(', ')
}

function describeCsi(token: CsiToken): string {
  if (token.final === 'm') return describeSgr(token)
  const first = token.params[0] ?? '1'
  const params = token.params.join(';') || '(none)'
  switch (token.final) {
    case 'A':
      return `cursor up ${first}`
    case 'B':
      return `cursor down ${first}`
    case 'C':
      return `cursor forward ${first}`
    case 'D':
      return `cursor back ${first}`
    case 'H':
    case 'f':
      return `cursor position (row=${token.params[0] ?? '1'}, col=${token.params[1] ?? '1'})`
    case 'J':
      return `erase in display (mode ${token.params[0] ?? '0'})`
    case 'K':
      return `erase in line (mode ${token.params[0] ?? '0'})`
    case '':
      return `incomplete sequence, params=${params}`
    default:
      return `CSI final='${token.final}' params=${params}`
  }
}

const LABELS: Record<Token['kind'], string> = {
  text: 'text',
  control: 'control',
  csi: 'CSI',
  osc: 'OSC',
  esc: 'ESC',
}

function positionLabel(pos: Position): string {
  return `${pos.line}:${pos.column}`
}

export function describe(token: Token): string {
  const pos = positionLabel(token.start).padEnd(6)
  const label = LABELS[token.kind].padEnd(8)
  switch (token.kind) {
    case 'text':
      return `${pos} ${label}${JSON.stringify(token.value)}`
    case 'control':
      return `${pos} ${label}${token.name}`
    case 'csi':
      return `${pos} ${label}${describeCsi(token)}`
    case 'osc':
      return `${pos} ${label}${token.identifier || '(none)'} ${JSON.stringify(token.data)} [${token.terminator}]`
    case 'esc':
      return `${pos} ${label}${token.intermediates}${token.final}`
  }
}

export function print(tokens: Token[]): string {
  return tokens.map(describe).join('\n')
}
