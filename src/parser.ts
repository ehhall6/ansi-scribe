// Tokenizer and validator for the escape sequence grammar terminals actually
// implement (ECMA-48 / ANSI X3.64, informally): C0 controls, CSI, OSC, DCS,
// SS2/SS3, and the single ESC Fp/Fe/Fs sequences (charset designation,
// save/restore cursor, and so on). It does not attempt to model 8-bit C1
// controls yet -- see the README for what's out of scope.

export interface Position {
  readonly offset: number
  readonly line: number
  readonly column: number
}

const START: Position = { offset: 0, line: 1, column: 1 }

function advance(pos: Position, ch: string): Position {
  if (ch === '\n') {
    return { offset: pos.offset + 1, line: pos.line + 1, column: 1 }
  }
  return { offset: pos.offset + 1, line: pos.line, column: pos.column + 1 }
}

export interface TextToken {
  kind: 'text'
  value: string
  start: Position
  end: Position
}

export interface ControlToken {
  kind: 'control'
  name: string
  code: number
  start: Position
  end: Position
}

export interface CsiToken {
  kind: 'csi'
  params: string[]
  privateMarker: string
  intermediates: string
  final: string
  raw: string
  start: Position
  end: Position
}

export interface OscToken {
  kind: 'osc'
  identifier: string
  data: string
  terminator: 'BEL' | 'ST'
  raw: string
  start: Position
  end: Position
}

export interface DcsToken {
  kind: 'dcs'
  params: string[]
  intermediates: string
  final: string
  data: string
  raw: string
  start: Position
  end: Position
}

export interface SingleShiftToken {
  kind: 'ss2' | 'ss3'
  char: string | undefined
  raw: string
  start: Position
  end: Position
}

export interface EscToken {
  kind: 'esc'
  intermediates: string
  final: string
  raw: string
  start: Position
  end: Position
}

export type Token =
  | TextToken
  | ControlToken
  | CsiToken
  | OscToken
  | DcsToken
  | SingleShiftToken
  | EscToken

const CONTROL_GLYPHS: Record<string, string> = {
  '\x1b': '\\e',
  '\x07': '\\a',
  '\x08': '\\b',
  '\x09': '\\t',
  '\x0d': '\\r',
  '\x7f': '\\x7f',
}

function glyphFor(ch: string): string {
  if (ch in CONTROL_GLYPHS) return CONTROL_GLYPHS[ch]!
  const code = ch.charCodeAt(0)
  if (code < 0x20 || code === 0x7f) return `\\x${code.toString(16).padStart(2, '0')}`
  return ch
}

// Renders a source line with control bytes replaced by visible glyphs, and
// returns how far into the rendered text the caret should sit so it still
// lines up under the byte at `caretColumn` in the original (1-based) columns.
function renderLine(line: string, caretColumn: number): { text: string; caretOffset: number } {
  let text = ''
  let caretOffset = 0
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    const column = i + 1
    if (column < caretColumn) caretOffset += glyphFor(ch).length
    text += glyphFor(ch)
  }
  return { text, caretOffset }
}

export class ParseError extends Error {
  readonly position: Position
  readonly source: string
  readonly hint: string | undefined

  constructor(message: string, position: Position, source: string, hint?: string) {
    super(message)
    this.name = 'ParseError'
    this.position = position
    this.source = source
    this.hint = hint
  }

  // Renders a compiler-style diagnostic: message, location, source snippet,
  // and a caret pointing at the exact byte that broke the grammar.
  format(): string {
    const lines = this.source.split('\n')
    const rawLine = lines[this.position.line - 1] ?? ''
    const { text, caretOffset } = renderLine(rawLine, this.position.column)
    const lineLabel = String(this.position.line)
    const gutter = ' '.repeat(lineLabel.length)
    const caret = `${' '.repeat(caretOffset)}^${this.hint ? ' ' + this.hint : ''}`
    return [
      `error: ${this.message}`,
      `  --> line ${this.position.line}, column ${this.position.column}`,
      `${gutter} |`,
      `${lineLabel} | ${text}`,
      `${gutter} | ${caret}`,
    ].join('\n')
  }
}

class Cursor {
  private pos: Position = START

  constructor(private readonly input: string) {}

  get position(): Position {
    return this.pos
  }

  get atEnd(): boolean {
    return this.pos.offset >= this.input.length
  }

  peek(lookahead = 0): string | undefined {
    return this.input[this.pos.offset + lookahead]
  }

  next(): string {
    const ch = this.input[this.pos.offset]
    if (ch === undefined) throw new Error('cursor advanced past end of input')
    this.pos = advance(this.pos, ch)
    return ch
  }
}

const CONTROL_NAMES: Record<number, string> = {
  0x00: 'NUL',
  0x07: 'BEL',
  0x08: 'BS',
  0x09: 'HT',
  0x0a: 'LF',
  0x0b: 'VT',
  0x0c: 'FF',
  0x0d: 'CR',
  0x7f: 'DEL',
}

function readCsi(cursor: Cursor, source: string, start: Position, errors: ParseError[]): CsiToken {
  let paramText = ''
  let intermediates = ''
  let final = ''
  let raw = '\x1b['

  while (true) {
    const ch = cursor.peek()
    if (ch === undefined) {
      errors.push(
        new ParseError(
          'unterminated CSI sequence',
          cursor.position,
          source,
          'expected a final byte in the range 0x40-0x7E before the end of input',
        ),
      )
      break
    }
    const code = ch.charCodeAt(0)
    if (code >= 0x30 && code <= 0x3f && intermediates === '') {
      paramText += ch
      raw += ch
      cursor.next()
      continue
    }
    if (code >= 0x20 && code <= 0x2f) {
      intermediates += ch
      raw += ch
      cursor.next()
      continue
    }
    if (code >= 0x40 && code <= 0x7e) {
      final = ch
      raw += ch
      cursor.next()
      break
    }
    errors.push(
      new ParseError(
        `invalid byte 0x${code.toString(16).padStart(2, '0')} in CSI sequence`,
        cursor.position,
        source,
        'CSI parameters must be 0x30-0x3F, intermediates 0x20-0x2F, and the sequence must end with a final byte 0x40-0x7E',
      ),
    )
    raw += ch
    cursor.next()
  }

  let privateMarker = ''
  let params = paramText
  const marker = params[0]
  if (marker === '?' || marker === '<' || marker === '=' || marker === '>') {
    privateMarker = marker
    params = params.slice(1)
  }

  return {
    kind: 'csi',
    params: params.length > 0 ? params.split(';') : [],
    privateMarker,
    intermediates,
    final,
    raw,
    start,
    end: cursor.position,
  }
}

function readOsc(cursor: Cursor, source: string, start: Position, errors: ParseError[]): OscToken {
  let body = ''
  let raw = '\x1b]'
  let terminator: 'BEL' | 'ST' | null = null

  while (true) {
    const ch = cursor.peek()
    if (ch === undefined) {
      errors.push(
        new ParseError(
          'unterminated OSC sequence',
          cursor.position,
          source,
          'expected BEL (0x07) or the string terminator ESC \\ before the end of input',
        ),
      )
      break
    }
    if (ch === '\x07') {
      cursor.next()
      raw += ch
      terminator = 'BEL'
      break
    }
    if (ch === '\x1b' && cursor.peek(1) === '\\') {
      cursor.next()
      cursor.next()
      raw += '\x1b\\'
      terminator = 'ST'
      break
    }
    body += ch
    raw += ch
    cursor.next()
  }

  const separatorIndex = body.indexOf(';')
  const identifier = separatorIndex === -1 ? body : body.slice(0, separatorIndex)
  const data = separatorIndex === -1 ? '' : body.slice(separatorIndex + 1)

  return {
    kind: 'osc',
    identifier,
    data,
    terminator: terminator ?? 'ST',
    raw,
    start,
    end: cursor.position,
  }
}

function readDcs(cursor: Cursor, source: string, start: Position, errors: ParseError[]): DcsToken {
  let paramText = ''
  let intermediates = ''
  let final = ''
  let raw = '\x1bP'

  // Header bytes follow the same classes as CSI, but instead of ending the
  // sequence the final byte introduces a passthrough data string that runs
  // until the string terminator.
  while (final === '') {
    const ch = cursor.peek()
    if (ch === undefined) {
      errors.push(
        new ParseError(
          'unterminated DCS sequence',
          cursor.position,
          source,
          'expected a final byte in the range 0x40-0x7E before the end of input',
        ),
      )
      return { kind: 'dcs', params: paramText.length > 0 ? paramText.split(';') : [], intermediates, final, data: '', raw, start, end: cursor.position }
    }
    const code = ch.charCodeAt(0)
    if (code >= 0x30 && code <= 0x3f && intermediates === '') {
      paramText += ch
      raw += ch
      cursor.next()
      continue
    }
    if (code >= 0x20 && code <= 0x2f) {
      intermediates += ch
      raw += ch
      cursor.next()
      continue
    }
    if (code >= 0x40 && code <= 0x7e) {
      final = ch
      raw += ch
      cursor.next()
      break
    }
    errors.push(
      new ParseError(
        `invalid byte 0x${code.toString(16).padStart(2, '0')} in DCS sequence`,
        cursor.position,
        source,
        'DCS parameters must be 0x30-0x3F, intermediates 0x20-0x2F, and the header must end with a final byte 0x40-0x7E',
      ),
    )
    raw += ch
    cursor.next()
  }

  let data = ''
  while (true) {
    const ch = cursor.peek()
    if (ch === undefined) {
      errors.push(
        new ParseError(
          'unterminated DCS sequence',
          cursor.position,
          source,
          'expected the string terminator ESC \\ before the end of input',
        ),
      )
      break
    }
    if (ch === '\x1b' && cursor.peek(1) === '\\') {
      cursor.next()
      cursor.next()
      raw += '\x1b\\'
      break
    }
    data += ch
    raw += ch
    cursor.next()
  }

  return {
    kind: 'dcs',
    params: paramText.length > 0 ? paramText.split(';') : [],
    intermediates,
    final,
    data,
    raw,
    start,
    end: cursor.position,
  }
}

function readSingleShift(
  kind: 'ss2' | 'ss3',
  cursor: Cursor,
  source: string,
  start: Position,
  errors: ParseError[],
): SingleShiftToken {
  const label = kind === 'ss2' ? 'SS2' : 'SS3'
  const introducer = kind === 'ss2' ? 'N' : 'O'
  let raw = `\x1b${introducer}`

  const ch = cursor.peek()
  if (ch === undefined) {
    errors.push(
      new ParseError(
        `incomplete ${label} sequence`,
        cursor.position,
        source,
        `${label} must be followed by exactly one character before the end of input`,
      ),
    )
    return { kind, char: undefined, raw, start, end: cursor.position }
  }

  const code = ch.charCodeAt(0)
  if (code < 0x20 || code === 0x7f) {
    errors.push(
      new ParseError(
        `invalid byte 0x${code.toString(16).padStart(2, '0')} after ${label}`,
        cursor.position,
        source,
        `${label} selects the next printable character (0x20-0x7E), not a control byte`,
      ),
    )
  }
  cursor.next()
  raw += ch
  return { kind, char: ch, raw, start, end: cursor.position }
}

function readSimpleEscape(cursor: Cursor, source: string, start: Position, errors: ParseError[]): EscToken {
  let intermediates = ''
  let final = ''
  let raw = '\x1b'

  while (true) {
    const ch = cursor.peek()
    if (ch === undefined) {
      errors.push(
        new ParseError(
          'incomplete escape sequence',
          cursor.position,
          source,
          'expected a final byte in the range 0x30-0x7E before the end of input',
        ),
      )
      break
    }
    const code = ch.charCodeAt(0)
    if (code >= 0x20 && code <= 0x2f) {
      intermediates += ch
      raw += ch
      cursor.next()
      continue
    }
    if (code >= 0x30 && code <= 0x7e) {
      final = ch
      raw += ch
      cursor.next()
      break
    }
    errors.push(
      new ParseError(
        `invalid byte 0x${code.toString(16).padStart(2, '0')} in escape sequence`,
        cursor.position,
        source,
        'expected an intermediate byte (0x20-0x2F) or a final byte (0x30-0x7E)',
      ),
    )
    raw += ch
    cursor.next()
    break
  }

  return { kind: 'esc', intermediates, final, raw, start, end: cursor.position }
}

function readEscapeSequence(cursor: Cursor, source: string, start: Position, errors: ParseError[]): Token {
  const next = cursor.peek()
  if (next === undefined) {
    errors.push(
      new ParseError(
        'incomplete escape sequence',
        start,
        source,
        'ESC was not followed by any byte before the end of input',
      ),
    )
    return { kind: 'esc', intermediates: '', final: '', raw: '\x1b', start, end: cursor.position }
  }
  if (next === '[') {
    cursor.next()
    return readCsi(cursor, source, start, errors)
  }
  if (next === ']') {
    cursor.next()
    return readOsc(cursor, source, start, errors)
  }
  if (next === 'P') {
    cursor.next()
    return readDcs(cursor, source, start, errors)
  }
  if (next === 'N') {
    cursor.next()
    return readSingleShift('ss2', cursor, source, start, errors)
  }
  if (next === 'O') {
    cursor.next()
    return readSingleShift('ss3', cursor, source, start, errors)
  }
  return readSimpleEscape(cursor, source, start, errors)
}

export function tokenize(input: string): { tokens: Token[]; errors: ParseError[] } {
  const cursor = new Cursor(input)
  const tokens: Token[] = []
  const errors: ParseError[] = []
  let textStart: Position | null = null
  let textValue = ''

  const flushText = (end: Position) => {
    if (textStart !== null && textValue.length > 0) {
      tokens.push({ kind: 'text', value: textValue, start: textStart, end })
    }
    textStart = null
    textValue = ''
  }

  while (!cursor.atEnd) {
    const ch = cursor.peek()!
    const code = ch.charCodeAt(0)

    if (ch === '\x1b') {
      const start = cursor.position
      flushText(start)
      cursor.next()
      tokens.push(readEscapeSequence(cursor, input, start, errors))
      continue
    }

    if (code < 0x20 || code === 0x7f) {
      const start = cursor.position
      flushText(start)
      cursor.next()
      tokens.push({
        kind: 'control',
        name: CONTROL_NAMES[code] ?? `C0-0x${code.toString(16).padStart(2, '0')}`,
        code,
        start,
        end: cursor.position,
      })
      continue
    }

    if (textStart === null) textStart = cursor.position
    textValue += ch
    cursor.next()
  }

  flushText(cursor.position)
  return { tokens, errors }
}

// Convenience wrapper for callers that want an exception instead of an
// errors array -- throws the first ParseError encountered, if any.
export function tokenizeOrThrow(input: string): Token[] {
  const { tokens, errors } = tokenize(input)
  if (errors.length > 0) throw errors[0]
  return tokens
}

export function validate(input: string): ParseError[] {
  return tokenize(input).errors
}
