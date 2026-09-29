// File-size rule (D-098): new non-test code files stay within 800 lines; files that already
// exceed it are recorded in file-size-baseline.json and may only shrink.
//   node scripts/check-file-size.mjs            check (exit 1 on a violation)
//   node scripts/check-file-size.mjs --update   lower recorded counts to the current sizes
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FILE_LINE_LIMIT = 800
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const baselinePath = join(root, 'scripts/file-size-baseline.json')
const CODE = /\.(ts|tsx|mjs|js|cjs)$/u
const EXEMPT = /\.(test|fixture)\.[a-z]+$|\/test-support\//u

function walk(directory, files = []) {
  if (!existsSync(directory)) return files
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) walk(path, files)
    else if (CODE.test(entry.name)) files.push(relative(root, path).split(sep).join('/'))
  }
  return files
}

export function measure() {
  const sizes = {}
  for (const path of ['src', 'scripts', 'extensions'].flatMap((directory) => walk(join(root, directory)))) {
    if (EXEMPT.test(path) || path.includes('/dist/')) continue
    const text = readFileSync(join(root, path), 'utf8')
    sizes[path] = text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
  }
  return sizes
}

export function checkFileSizes(sizes, baseline) {
  const violations = []
  const shrinkable = []
  for (const [path, lines] of Object.entries(sizes)) {
    const recorded = baseline[path]
    if (recorded === undefined) {
      if (lines > FILE_LINE_LIMIT) violations.push(`${path}: ${lines} lines; new files stay within ${FILE_LINE_LIMIT} lines.`)
    } else if (lines > recorded) {
      violations.push(`${path}: ${lines} lines; this oversized file may only shrink (recorded ${recorded}).`)
    } else if (lines < recorded) {
      shrinkable.push(`${path}: ${recorded} -> ${lines}`)
    }
  }
  for (const path of Object.keys(baseline)) if (sizes[path] === undefined) shrinkable.push(`${path}: removed`)
  return { violations, shrinkable }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
  const sizes = measure()
  if (process.argv.includes('--update')) {
    const next = {}
    for (const [path, recorded] of Object.entries(baseline)) {
      const lines = sizes[path]
      if (lines !== undefined && lines > FILE_LINE_LIMIT) next[path] = Math.min(recorded, lines)
    }
    writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`)
    console.log(`Recorded ${Object.keys(next).length} oversized files.`)
  } else {
    const { violations, shrinkable } = checkFileSizes(sizes, baseline)
    if (shrinkable.length > 0) console.log(`Smaller than recorded; run with --update to lock in:\n  ${shrinkable.join('\n  ')}`)
    if (violations.length > 0) {
      console.error(violations.join('\n'))
      process.exitCode = 1
    } else console.log(`File sizes OK (${Object.keys(sizes).length} files).`)
  }
}
