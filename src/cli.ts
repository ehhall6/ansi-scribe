#!/usr/bin/env node
// CLI wrapper: pipe a raw terminal capture in on stdin (or pass a file path)
// and get back the pretty-printed token stream, followed by any diagnostics.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { tokenize } from './parser.js'
import { print } from './printer.js'

export function format(input: string): { output: string; exitCode: number } {
  const { tokens, errors } = tokenize(input)
  const sections: string[] = []
  if (tokens.length > 0) sections.push(print(tokens))
  for (const error of errors) sections.push(error.format())
  return { output: sections.join('\n\n'), exitCode: errors.length > 0 ? 1 : 0 }
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk))
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    process.stdin.on('error', reject)
  })
}

async function main(): Promise<void> {
  const filePath = process.argv[2]
  const input = filePath !== undefined ? readFileSync(filePath, 'utf8') : await readStdin()
  const { output, exitCode } = format(input)
  process.stdout.write(output + '\n')
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
