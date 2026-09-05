import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ParseError, tokenize, tokenizeOrThrow, validate } from './parser.js'

test('plain text produces a single text token', () => {
  const { tokens, errors } = tokenize('hello')
  assert.strictEqual(errors.length, 0)
  assert.strictEqual(tokens.length, 1)
  const [token] = tokens
  if (token === undefined || token.kind !== 'text') throw new Error('expected a text token')
  assert.strictEqual(token.value, 'hello')
  assert.deepStrictEqual(token.start, { offset: 0, line: 1, column: 1 })
  assert.deepStrictEqual(token.end, { offset: 5, line: 1, column: 6 })
})

test('a C0 control byte splits surrounding text and tracks columns', () => {
  const { tokens, errors } = tokenize('a\tb')
  assert.strictEqual(errors.length, 0)
  assert.strictEqual(tokens.length, 3)
  const [first, second, third] = tokens
  if (first === undefined || first.kind !== 'text') throw new Error('expected leading text token')
  if (second === undefined || second.kind !== 'control') throw new Error('expected a control token')
  if (third === undefined || third.kind !== 'text') throw new Error('expected trailing text token')
  assert.strictEqual(first.value, 'a')
  assert.strictEqual(second.name, 'HT')
  assert.strictEqual(second.code, 0x09)
  assert.deepStrictEqual(second.start, { offset: 1, line: 1, column: 2 })
  assert.deepStrictEqual(second.end, { offset: 2, line: 1, column: 3 })
  assert.strictEqual(third.value, 'b')
})

test('a newline control byte resets the column and advances the line', () => {
  const { tokens } = tokenize('a\nb')
  const [, control, text] = tokens
  if (control === undefined || control.kind !== 'control') throw new Error('expected a control token')
  if (text === undefined || text.kind !== 'text') throw new Error('expected a text token')
  assert.strictEqual(control.name, 'LF')
  assert.deepStrictEqual(control.end, { offset: 2, line: 2, column: 1 })
  assert.deepStrictEqual(text.start, { offset: 2, line: 2, column: 1 })
})

test('an unrecognized C0 byte is named by its code point', () => {
  const { tokens } = tokenize('\x01')
  const [token] = tokens
  if (token === undefined || token.kind !== 'control') throw new Error('expected a control token')
  assert.strictEqual(token.name, 'C0-0x01')
})

test('DEL is treated as a control byte, not text', () => {
  const { tokens } = tokenize('\x7f')
  const [token] = tokens
  if (token === undefined || token.kind !== 'control') throw new Error('expected a control token')
  assert.strictEqual(token.name, 'DEL')
  assert.strictEqual(token.code, 0x7f)
})

test('a well-formed CSI sequence parses params, final byte, and raw text', () => {
  const { tokens, errors } = tokenize('\x1b[1;31m')
  assert.strictEqual(errors.length, 0)
  const [token] = tokens
  if (token === undefined || token.kind !== 'csi') throw new Error('expected a CSI token')
  assert.deepStrictEqual(token.params, ['1', '31'])
  assert.strictEqual(token.privateMarker, '')
  assert.strictEqual(token.intermediates, '')
  assert.strictEqual(token.final, 'm')
  assert.strictEqual(token.raw, '\x1b[1;31m')
  assert.deepStrictEqual(token.start, { offset: 0, line: 1, column: 1 })
  assert.deepStrictEqual(token.end, { offset: 7, line: 1, column: 8 })
})

test('a private-marker CSI sequence separates the marker from the params', () => {
  const { tokens } = tokenize('\x1b[?25h')
  const [token] = tokens
  if (token === undefined || token.kind !== 'csi') throw new Error('expected a CSI token')
  assert.strictEqual(token.privateMarker, '?')
  assert.deepStrictEqual(token.params, ['25'])
  assert.strictEqual(token.final, 'h')
})

test('a CSI sequence truncated before its final byte reports an unterminated error', () => {
  const { tokens, errors } = tokenize('\x1b[38;5')
  assert.strictEqual(errors.length, 1)
  const [error] = errors
  if (error === undefined) throw new Error('expected an error')
  assert.strictEqual(error.message, 'unterminated CSI sequence')
  assert.deepStrictEqual(error.position, { offset: 6, line: 1, column: 7 })
  assert.match(error.hint ?? '', /0x40-0x7E/)

  const [token] = tokens
  if (token === undefined || token.kind !== 'csi') throw new Error('expected a CSI token')
  assert.strictEqual(token.final, '')
  assert.deepStrictEqual(token.params, ['38', '5'])
})

test('a byte outside every allowed CSI class is rejected but parsing resumes', () => {
  const { tokens, errors } = tokenize('\x1b[\x00m')
  assert.strictEqual(errors.length, 1)
  const [error] = errors
  if (error === undefined) throw new Error('expected an error')
  assert.strictEqual(error.message, 'invalid byte 0x00 in CSI sequence')
  assert.deepStrictEqual(error.position, { offset: 2, line: 1, column: 3 })

  const [token] = tokens
  if (token === undefined || token.kind !== 'csi') throw new Error('expected a CSI token')
  assert.strictEqual(token.final, 'm')
  assert.strictEqual(token.raw, '\x1b[\x00m')
})

test('a parameter byte following an intermediate is an invalid class transition', () => {
  // Per ECMA-48, once an intermediate byte (0x20-0x2F) appears, a parameter
  // byte (0x30-0x3F) is no longer legal -- the grammar only allows moving
  // toward the final byte, not back toward parameters.
  const { tokens, errors } = tokenize('\x1b[1 2m')
  assert.strictEqual(errors.length, 1)
  const [error] = errors
  if (error === undefined) throw new Error('expected an error')
  assert.strictEqual(error.message, 'invalid byte 0x32 in CSI sequence')
  assert.deepStrictEqual(error.position, { offset: 4, line: 1, column: 5 })

  const [token] = tokens
  if (token === undefined || token.kind !== 'csi') throw new Error('expected a CSI token')
  assert.deepStrictEqual(token.params, ['1'])
  assert.strictEqual(token.intermediates, ' ')
  assert.strictEqual(token.final, 'm')
  assert.strictEqual(token.raw, '\x1b[1 2m')
})

test('an OSC sequence terminated by BEL splits identifier from data', () => {
  const { tokens, errors } = tokenize('\x1b]0;title\x07')
  assert.strictEqual(errors.length, 0)
  const [token] = tokens
  if (token === undefined || token.kind !== 'osc') throw new Error('expected an OSC token')
  assert.strictEqual(token.identifier, '0')
  assert.strictEqual(token.data, 'title')
  assert.strictEqual(token.terminator, 'BEL')
  assert.strictEqual(token.raw, '\x1b]0;title\x07')
})

test('an OSC sequence terminated by the string terminator (ESC \\) is recognized', () => {
  const { tokens } = tokenize('\x1b]0;title\x1b\\')
  const [token] = tokens
  if (token === undefined || token.kind !== 'osc') throw new Error('expected an OSC token')
  assert.strictEqual(token.terminator, 'ST')
  assert.strictEqual(token.raw, '\x1b]0;title\x1b\\')
})

test('an OSC sequence with no terminator before the end of input is malformed', () => {
  const { tokens, errors } = tokenize('\x1b]0;title')
  assert.strictEqual(errors.length, 1)
  const [error] = errors
  if (error === undefined) throw new Error('expected an error')
  assert.strictEqual(error.message, 'unterminated OSC sequence')
  assert.deepStrictEqual(error.position, { offset: 9, line: 1, column: 10 })

  const [token] = tokens
  if (token === undefined || token.kind !== 'osc') throw new Error('expected an OSC token')
  assert.strictEqual(token.identifier, '0')
  assert.strictEqual(token.data, 'title')
  assert.strictEqual(token.terminator, 'ST')
})

test('a well-formed DCS sequence parses params, header, data, and raw text', () => {
  const { tokens, errors } = tokenize('\x1bP1;2$rfoo\x1b\\')
  assert.strictEqual(errors.length, 0)
  const [token] = tokens
  if (token === undefined || token.kind !== 'dcs') throw new Error('expected a DCS token')
  assert.deepStrictEqual(token.params, ['1', '2'])
  assert.strictEqual(token.intermediates, '$')
  assert.strictEqual(token.final, 'r')
  assert.strictEqual(token.data, 'foo')
  assert.strictEqual(token.raw, '\x1bP1;2$rfoo\x1b\\')
  assert.deepStrictEqual(token.end, { offset: 12, line: 1, column: 13 })
})

test('a DCS sequence with no data still parses once the final byte arrives', () => {
  const { tokens } = tokenize('\x1bPq\x1b\\')
  const [token] = tokens
  if (token === undefined || token.kind !== 'dcs') throw new Error('expected a DCS token')
  assert.deepStrictEqual(token.params, [])
  assert.strictEqual(token.final, 'q')
  assert.strictEqual(token.data, '')
})

test('a DCS sequence missing its final byte reports an unterminated error', () => {
  const { tokens, errors } = tokenize('\x1bP1;2')
  assert.strictEqual(errors.length, 1)
  const [error] = errors
  if (error === undefined) throw new Error('expected an error')
  assert.strictEqual(error.message, 'unterminated DCS sequence')
  assert.match(error.hint ?? '', /0x40-0x7E/)

  const [token] = tokens
  if (token === undefined || token.kind !== 'dcs') throw new Error('expected a DCS token')
  assert.strictEqual(token.final, '')
  assert.strictEqual(token.data, '')
})

test('a DCS sequence missing its string terminator reports an unterminated error', () => {
  const { tokens, errors } = tokenize('\x1bPqfoo')
  assert.strictEqual(errors.length, 1)
  const [error] = errors
  if (error === undefined) throw new Error('expected an error')
  assert.strictEqual(error.message, 'unterminated DCS sequence')
  assert.match(error.hint ?? '', /ESC \\/)

  const [token] = tokens
  if (token === undefined || token.kind !== 'dcs') throw new Error('expected a DCS token')
  assert.strictEqual(token.final, 'q')
  assert.strictEqual(token.data, 'foo')
})

test('a byte outside every allowed DCS header class is rejected but parsing resumes', () => {
  const { tokens, errors } = tokenize('\x1bP\x00qfoo\x1b\\')
  assert.strictEqual(errors.length, 1)
  const [error] = errors
  if (error === undefined) throw new Error('expected an error')
  assert.strictEqual(error.message, 'invalid byte 0x00 in DCS sequence')

  const [token] = tokens
  if (token === undefined || token.kind !== 'dcs') throw new Error('expected a DCS token')
  assert.strictEqual(token.final, 'q')
  assert.strictEqual(token.data, 'foo')
})

test('SS2 consumes exactly one following character', () => {
  const { tokens, errors } = tokenize('\x1bNx')
  assert.strictEqual(errors.length, 0)
  const [token] = tokens
  if (token === undefined || token.kind !== 'ss2') throw new Error('expected an SS2 token')
  assert.strictEqual(token.char, 'x')
  assert.strictEqual(token.raw, '\x1bNx')
  assert.deepStrictEqual(token.end, { offset: 3, line: 1, column: 4 })
})

test('SS3 consumes exactly one following character', () => {
  const { tokens } = tokenize('\x1bOy')
  const [token] = tokens
  if (token === undefined || token.kind !== 'ss3') throw new Error('expected an SS3 token')
  assert.strictEqual(token.char, 'y')
  assert.strictEqual(token.raw, '\x1bOy')
})

test('SS2 at the very end of input has no character to select', () => {
  const { tokens, errors } = tokenize('\x1bN')
  assert.strictEqual(errors.length, 1)
  const [error] = errors
  if (error === undefined) throw new Error('expected an error')
  assert.strictEqual(error.message, 'incomplete SS2 sequence')

  const [token] = tokens
  if (token === undefined || token.kind !== 'ss2') throw new Error('expected an SS2 token')
  assert.strictEqual(token.char, undefined)
  assert.strictEqual(token.raw, '\x1bN')
})

test('SS3 followed by a control byte is rejected but still consumes the byte', () => {
  const { tokens, errors } = tokenize('\x1bO\x01')
  assert.strictEqual(errors.length, 1)
  const [error] = errors
  if (error === undefined) throw new Error('expected an error')
  assert.strictEqual(error.message, 'invalid byte 0x01 after SS3')

  const [token] = tokens
  if (token === undefined || token.kind !== 'ss3') throw new Error('expected an SS3 token')
  assert.strictEqual(token.char, '\x01')
})

test('a simple Fp/Fs escape with no intermediates parses its final byte', () => {
  const { tokens, errors } = tokenize('\x1b7')
  assert.strictEqual(errors.length, 0)
  const [token] = tokens
  if (token === undefined || token.kind !== 'esc') throw new Error('expected an ESC token')
  assert.strictEqual(token.intermediates, '')
  assert.strictEqual(token.final, '7')
  assert.strictEqual(token.raw, '\x1b7')
})

test('a simple escape with an intermediate byte parses charset designation', () => {
  const { tokens } = tokenize('\x1b(B')
  const [token] = tokens
  if (token === undefined || token.kind !== 'esc') throw new Error('expected an ESC token')
  assert.strictEqual(token.intermediates, '(')
  assert.strictEqual(token.final, 'B')
})

test('ESC at the very end of input has no byte to dispatch on', () => {
  const { tokens, errors } = tokenize('\x1b')
  assert.strictEqual(errors.length, 1)
  const [error] = errors
  if (error === undefined) throw new Error('expected an error')
  assert.strictEqual(error.message, 'incomplete escape sequence')
  // The error points at ESC itself, not at the end-of-input position the
  // cursor has since advanced to -- there is no better byte to blame.
  assert.deepStrictEqual(error.position, { offset: 0, line: 1, column: 1 })

  const [token] = tokens
  if (token === undefined || token.kind !== 'esc') throw new Error('expected an ESC token')
  assert.strictEqual(token.raw, '\x1b')
})

test('an escape sequence truncated after an intermediate byte is malformed', () => {
  const { tokens, errors } = tokenize('\x1b(')
  assert.strictEqual(errors.length, 1)
  const [error] = errors
  if (error === undefined) throw new Error('expected an error')
  assert.strictEqual(error.message, 'incomplete escape sequence')
  // Here the cursor has consumed the intermediate, so the error position is
  // where the missing final byte would have been -- unlike the bare-ESC case.
  assert.deepStrictEqual(error.position, { offset: 2, line: 1, column: 3 })

  const [token] = tokens
  if (token === undefined || token.kind !== 'esc') throw new Error('expected an ESC token')
  assert.strictEqual(token.intermediates, '(')
  assert.strictEqual(token.final, '')
})

test('validate collects every malformed sequence instead of stopping at the first', () => {
  const errors = validate('\x1b[\x00m ok \x1b]untermin')
  assert.strictEqual(errors.length, 2)
  assert.strictEqual(errors[0]?.message, 'invalid byte 0x00 in CSI sequence')
  assert.strictEqual(errors[1]?.message, 'unterminated OSC sequence')
  assert.ok(errors.every((error) => error instanceof ParseError))
})

test('tokenizeOrThrow throws the first ParseError for malformed input', () => {
  assert.throws(() => tokenizeOrThrow('\x1b[38;5'), ParseError)
})

test('tokenizeOrThrow returns tokens for well-formed input instead of throwing', () => {
  const tokens = tokenizeOrThrow('hello')
  assert.strictEqual(tokens.length, 1)
})

test('ParseError.format renders message, location, source line, and caret', () => {
  const { errors } = tokenize('status: \x1b[38;5')
  const [error] = errors
  if (error === undefined) throw new Error('expected an error')
  const formatted = error.format()
  assert.ok(formatted.includes('error: unterminated CSI sequence'))
  assert.ok(formatted.includes('line 1, column 15'))
  assert.ok(formatted.includes('status: \\e[38;5'))
  assert.ok(/\^ expected a final byte/.test(formatted))
})
