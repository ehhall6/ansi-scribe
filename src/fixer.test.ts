import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tokenize } from './parser.js'
import { fix } from './fixer.js'

function assertClean(input: string): void {
  const { errors } = tokenize(input)
  assert.strictEqual(errors.length, 0, `expected fix() output to be well-formed, got errors for ${JSON.stringify(input)}`)
}

test('well-formed input passes through unchanged', () => {
  const input = 'hi \x1b[1;31mthere\x1b[0m\n'
  assert.strictEqual(fix(input), input)
})

test('a CSI sequence truncated before its final byte is dropped', () => {
  assert.strictEqual(fix('status: \x1b[38;5'), 'status: ')
})

test('a stray invalid byte inside a CSI sequence is dropped, not the whole sequence', () => {
  const fixed = fix('\x1b[\x00m')
  assert.strictEqual(fixed, '\x1b[m')
  assertClean(fixed)
})

test('a parameter byte stranded after an intermediate is dropped from the CSI sequence', () => {
  const fixed = fix('\x1b[1 2m')
  assert.strictEqual(fixed, '\x1b[1 m')
  assertClean(fixed)
})

test('an OSC sequence missing its terminator gets one appended', () => {
  const fixed = fix('\x1b]0;title')
  assert.strictEqual(fixed, '\x1b]0;title\x1b\\')
  assertClean(fixed)
})

test('an OSC sequence already terminated by BEL is left alone', () => {
  const input = '\x1b]0;title\x07'
  assert.strictEqual(fix(input), input)
})

test('a DCS sequence missing its final byte is dropped', () => {
  assert.strictEqual(fix('before\x1bP1;2'), 'before')
})

test('a DCS sequence missing its string terminator gets one appended', () => {
  const fixed = fix('\x1bPqfoo')
  assert.strictEqual(fixed, '\x1bPqfoo\x1b\\')
  assertClean(fixed)
})

test('a stray invalid byte in a DCS header is dropped, not the whole sequence', () => {
  const fixed = fix('\x1bP\x00qfoo\x1b\\')
  assert.strictEqual(fixed, '\x1bPqfoo\x1b\\')
  assertClean(fixed)
})

test('SS2 with no following character is dropped', () => {
  assert.strictEqual(fix('before\x1bN'), 'before')
})

test('SS3 followed by a control byte is dropped', () => {
  assert.strictEqual(fix('before\x1bO\x01after'), 'beforeafter')
})

test('a well-formed SS2 sequence passes through unchanged', () => {
  const input = 'a\x1bNxb'
  assert.strictEqual(fix(input), input)
})

test('a bare ESC at the end of input is dropped', () => {
  assert.strictEqual(fix('done\x1b'), 'done')
})

test('an escape sequence truncated after an intermediate byte is dropped', () => {
  assert.strictEqual(fix('before\x1b('), 'before')
})

test('text and control bytes are never touched', () => {
  const input = 'a\tb\nc'
  assert.strictEqual(fix(input), input)
})

test('fix accepts raw bytes the same as a decoded string', () => {
  const bytes = new TextEncoder().encode('status: \x1b[38;5')
  assert.strictEqual(fix(bytes), 'status: ')
})
