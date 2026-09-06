import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tokenize } from './parser.js'
import { describe } from './printer.js'

function sgrLine(input: string): string {
  const { tokens, errors } = tokenize(input)
  assert.strictEqual(errors.length, 0)
  const [token] = tokens
  if (token === undefined || token.kind !== 'csi') throw new Error('expected a CSI token')
  return describe(token)
}

test('SGR with no params describes as reset', () => {
  assert.strictEqual(sgrLine('\x1b[m'), '1:1    CSI     SGR: reset')
})

test('SGR describes named styles and basic colors', () => {
  assert.strictEqual(sgrLine('\x1b[1;31m'), '1:1    CSI     SGR: bold, foreground=red')
})

test('SGR describes 256-color foreground', () => {
  assert.strictEqual(sgrLine('\x1b[38;5;208m'), '1:1    CSI     SGR: foreground=color256(208)')
})

test('SGR describes 256-color background', () => {
  assert.strictEqual(sgrLine('\x1b[48;5;22m'), '1:1    CSI     SGR: background=color256(22)')
})

test('SGR describes truecolor foreground', () => {
  assert.strictEqual(sgrLine('\x1b[38;2;255;128;0m'), '1:1    CSI     SGR: foreground=rgb(255,128,0)')
})

test('SGR describes truecolor background alongside other params', () => {
  assert.strictEqual(
    sgrLine('\x1b[1;48;2;10;20;30;4m'),
    '1:1    CSI     SGR: bold, background=rgb(10,20,30), underline',
  )
})

test('SGR falls back to the raw code when the extended color introducer has no mode', () => {
  assert.strictEqual(sgrLine('\x1b[38m'), '1:1    CSI     SGR: code 38')
})

test('SGR treats an unknown color mode as an ordinary code, not a color', () => {
  assert.strictEqual(sgrLine('\x1b[38;20;1m'), '1:1    CSI     SGR: code 38, code 20, bold')
})
