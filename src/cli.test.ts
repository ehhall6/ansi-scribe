import { test } from 'node:test'
import assert from 'node:assert/strict'
import { format } from './cli.js'

test('valid input prints the token stream and exits clean', () => {
  const { output, exitCode } = format('hi\x1b[1mthere\x1b[0m')
  assert.strictEqual(exitCode, 0)
  assert.match(output, /SGR: bold/)
  assert.match(output, /SGR: reset/)
})

test('malformed input appends a diagnostic and exits non-zero', () => {
  const { output, exitCode } = format('status: \x1b[38;5')
  assert.strictEqual(exitCode, 1)
  assert.match(output, /unterminated CSI sequence/)
  assert.match(output, /line 1, column 15/)
})

test('input with no tokens at all still exits clean with empty output', () => {
  const { output, exitCode } = format('')
  assert.strictEqual(exitCode, 0)
  assert.strictEqual(output, '')
})
