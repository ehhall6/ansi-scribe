// Rewrites malformed escape sequences to the nearest valid form instead of
// just reporting where the grammar broke.
//
// The repair per token kind follows from why tokenize() flagged it:
//   - a sequence that never reached a final byte (ran off the end of the
//     input) carries no reliable intent to recover -- there's no honest
//     guess for what final byte a truncated capture meant to send, so it's
//     dropped entirely.
//   - a sequence that reached its final byte but picked up a stray byte
//     along the way (an invalid class transition, a stray control byte in
//     a CSI/DCS header) is rebuilt from the clean params/intermediates/final
//     the parser already extracted, which never included the bad byte.
//   - a sequence that's otherwise intact but lost its string terminator
//     (OSC, DCS) gets one appended.
import { tokenize } from './parser.js'
import type { CsiToken, DcsToken, OscToken, SingleShiftToken, Token } from './parser.js'

const ST = '\x1b\\'

function fixCsi(token: CsiToken): string {
  if (token.final === '') return ''
  return `\x1b[${token.privateMarker}${token.params.join(';')}${token.intermediates}${token.final}`
}

function fixDcs(token: DcsToken): string {
  if (token.final === '') return ''
  // `data` never includes the terminator bytes (the parser stops collecting
  // data as soon as it sees ESC \), so appending ST here is safe whether or
  // not the original already had one.
  return `\x1bP${token.params.join(';')}${token.intermediates}${token.final}${token.data}${ST}`
}

function fixOsc(token: OscToken): string {
  if (token.raw.endsWith('\x07') || token.raw.endsWith(ST)) return token.raw
  return token.raw + ST
}

function fixSingleShift(token: SingleShiftToken): string {
  if (token.char === undefined) return ''
  const code = token.char.charCodeAt(0)
  if (code < 0x20 || code === 0x7f) return ''
  const introducer = token.kind === 'ss2' ? 'N' : 'O'
  return `\x1b${introducer}${token.char}`
}

function fixToken(token: Token): string {
  switch (token.kind) {
    case 'text':
      return token.value
    case 'control':
      return String.fromCharCode(token.code)
    case 'csi':
      return fixCsi(token)
    case 'osc':
      return fixOsc(token)
    case 'dcs':
      return fixDcs(token)
    case 'ss2':
    case 'ss3':
      return fixSingleShift(token)
    case 'esc':
      return token.final === '' ? '' : `\x1b${token.intermediates}${token.final}`
  }
}

// Repairs every malformed sequence in `input`, dropping the ones truncated
// too early to know their intent and patching the ones that just lost a
// trailing byte. Well-formed input passes through unchanged. Always
// succeeds -- there is no error tokenize() reports that fix() can't resolve.
export function fix(input: string | Uint8Array): string {
  const { tokens } = tokenize(input)
  return tokens.map(fixToken).join('')
}
