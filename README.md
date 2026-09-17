# ansi-scribe

Terminal programs, log capture tools, and recorded test fixtures are full of
ANSI/VT escape sequences that are effectively invisible in a normal text
editor. When one of them is malformed -- a CSI sequence truncated by a
crashed process, an OSC that never got its terminator, a stray control byte
from a corrupted capture -- you usually find out by staring at mojibake on
your screen, not by getting a clear error.

ansi-scribe tokenizes a string containing terminal escape sequences, tells
you exactly which byte broke the grammar and where (line and column, with a
caret pointing at the offending byte, in the style of a compiler diagnostic),
and pretty-prints a token stream into something a human can read.

It covers the subset of ECMA-48 / ANSI X3.64 that real terminals implement:
C0 controls, CSI sequences (cursor movement, SGR/color codes, erase
functions), OSC sequences (window title, hyperlinks), DCS sequences (device
control strings, e.g. Sixel or terminal passthrough), SS2/SS3 single shifts,
and the other ESC Fp/Fe/Fs single-sequences (charset designation,
save/restore cursor, and so on).

## Install

Nothing is published yet. Clone the repo and build it with the TypeScript
compiler -- there are no runtime dependencies:

```
npm run build
```

## Usage

```ts
import { tokenize, print } from './dist/index.js'

const input = 'hello \x1b[1;31mworld\x1b[0m\n'
const { tokens, errors } = tokenize(input)

console.log(print(tokens))
// 1:1    text    "hello "
// 1:7    CSI     SGR: bold, foreground=red
// 1:14   text    "world"
// 1:19   CSI     SGR: reset
// 1:23   control LF

if (errors.length > 0) {
  throw errors[0]
}
```

Malformed input produces a diagnostic instead of an exception with no
context:

```ts
import { tokenize } from './dist/index.js'

const { errors } = tokenize('status: \x1b[38;5')
console.log(errors[0].format())
```

```
error: unterminated CSI sequence
  --> line 1, column 15
  |
1 | status: \e[38;5
  |                ^ expected a final byte in the range 0x40-0x7E before the end of input
```

The column counts decoded characters, not rendered glyphs, so it stays
correct even once a control byte like ESC has been swapped out for a
printable `\e` glyph in the snippet above.

## CLI

`ansi-scribe` reads a terminal capture from stdin (or a file path given as
the first argument) and writes the pretty-printed token stream to stdout,
followed by any diagnostics. It exits non-zero if the input contained
malformed sequences.

```
$ printf 'hello \x1b[1;31mworld\x1b[0m\n' | npx ansi-scribe
1:1    text    "hello "
1:7    CSI     SGR: bold, foreground=red
1:14   text    "world"
1:19   CSI     SGR: reset
1:23   control LF

$ printf 'status: \x1b[38;5' | npx ansi-scribe; echo "exit $?"
error: unterminated CSI sequence
  --> line 1, column 15
  |
1 | status: \e[38;5
  |                ^ expected a final byte in the range 0x40-0x7E before the end of input
exit 1
```

Pass `--fix` to rewrite the malformed sequences to the nearest valid form and
write the repaired capture to stdout instead of the token stream and
diagnostics. A sequence truncated before it named a final byte is dropped --
there's no honest guess for what a cut-off capture meant to send:

```
$ printf 'status: \x1b[38;5' | npx ansi-scribe --fix; echo "|$?"
status: |0
```

A sequence that's otherwise intact but lost its string terminator gets one
appended:

```
$ printf 'title: \x1b]0;untitled' | npx ansi-scribe --fix | cat -v
title: ^[]0;untitled^[\
```

`--fix` always exits 0 and writes the output byte-for-byte, with no trailing
newline added, so it can be piped straight into a file or another tool.

## API

- `tokenize(input): { tokens, errors }` -- never throws; collects every
  malformed sequence it finds instead of stopping at the first one. `input`
  can be a `string` or a `Uint8Array` (including `Buffer`) -- raw bytes are
  decoded as UTF-8 before tokenizing, since escape sequence bytes are always
  ASCII and don't need any special handling.
- `tokenizeOrThrow(input): Token[]` -- throws the first `ParseError`.
- `validate(input): ParseError[]` -- just the errors, if you only care
  whether the input is well-formed.
- `print(tokens): string` / `describe(token): string` -- pretty-print a
  token stream, or a single token, as one line each with its position.
- `fix(input): string` -- rewrites every malformed sequence in `input` to
  the nearest valid form and returns the repaired text. Well-formed input
  passes through unchanged.
- `ParseError` -- extends `Error`, carries `position` (`{ offset, line,
  column }`) and `format()` for the diagnostic shown above.

## What it does not do yet

- Bytes that aren't valid UTF-8 are replaced with the U+FFFD glyph rather
  than reported as a diagnostic, and positions are tracked in decoded
  characters, not raw bytes -- a multi-byte character before a malformed
  sequence will throw off the column count.

## License

MIT, see LICENSE.
