#!/usr/bin/env node
// CLI wrapper: pipe a raw terminal capture in on stdin (or pass a file path)
// and get back the pretty-printed token stream, followed by any diagnostics
// -- or, with --fix, the repaired capture itself.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { tokenize } from './parser.js'
import { print } from './printer.js'
import { fix } from './fixer.js'

export interface FormatOptions {
  fix?: boolean
}

export function format(input: string | Uint8Array, options: FormatOptions = {}): { output: string; exitCode: number } {
  if (options.fix) {
    return { output: fix(input), exitCode: 0 }
  }
  const { tokens, errors } = tokenize(input)
  const sections: string[] = []
  if (tokens.length > 0) sections.push(print(tokens))
  for (const error of errors) sections.push(error.format())
  return { output: sections.join('\n\n'), exitCode: errors.length > 0 ? 1 : 0 }
}

function readStdin(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk))
    process.stdin.on('end', () => resolve(Buffer.concat(chunks)))
    process.stdin.on('error', reject)
  })
}

interface CliArgs {
  fix: boolean
  filePath: string | undefined
}

function parseArgs(argv: string[]): CliArgs {
  let fixFlag = false
  let filePath: string | undefined
  for (const arg of argv) {
    if (arg === '--fix') {
      fixFlag = true
    } else if (filePath === undefined) {
      filePath = arg
    }
  }
  return { fix: fixFlag, filePath }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const input = args.filePath !== undefined ? readFileSync(args.filePath) : await readStdin()
  const { output, exitCode } = format(input, { fix: args.fix })
  // --fix output is meant to be piped on to a file or another tool, so it
  // gets written byte-for-byte; the pretty-printed mode adds a trailing
  // newline for a human reading it in a terminal.
  process.stdout.write(args.fix ? output : output + '\n')
  process.exitCode = exitCode
}

// Only run when invoked directly (e.g. `node dist/cli.js`), not when
// imported by tests for the pure `format` function.
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
}
