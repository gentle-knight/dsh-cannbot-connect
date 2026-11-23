#!/usr/bin/env node
/**
 * Measure and gate offline coverage of `lib/` without adding a dependency.
 *
 * Every suite runs as a child process with `NODE_V8_COVERAGE` pointed at a
 * throwaway directory. Node writes one raw V8 coverage document per process;
 * this script aggregates them and projects the executed ranges onto source
 * lines and functions.
 *
 * How the projection works (also stated in docs/TEST-PLAN.md):
 *   - V8's top-level function range covers the whole module with count 1, so a
 *     naive "any positive range" check reports 100%. Ranges are instead applied
 *     from the WIDEST span to the narrowest; the innermost range covering each
 *     character wins. That is the same nested-range rule coverage libraries use.
 *   - A line counts as covered when at least one of its code characters ends up
 *     with an executed count, in at least one test process.
 *   - A function counts once its union of executed ranges is non-empty; the
 *     denominator is every function the runtime reported for the file.
 *   - Branch coverage is NOT claimed. V8 flat block ranges are not a branch
 *     model; the report keeps block counts only as diagnostics.
 *
 * Usage:
 *   node scripts/coverage.mjs [--min-lines 98] [--min-functions 90] [--keep]
 *
 * Exits 1 when a suite fails or a threshold is missed.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

import { OFFLINE_TESTS } from './test-suites.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const libDir = join(root, 'lib')
const coverageDir = join(root, 'coverage')

/** Parse `--flag value` pairs. */
function options(argv) {
  const parsed = { minLines: 98, minFunctions: 90, keep: false }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--min-lines') {
      parsed.minLines = Number(argv[index + 1])
      index += 1
    } else if (flag === '--min-functions') {
      parsed.minFunctions = Number(argv[index + 1])
      index += 1
    } else if (flag === '--keep') {
      parsed.keep = true
    }
  }
  return parsed
}

const opts = options(process.argv.slice(2))
const rawDir = mkdtempSync(join(tmpdir(), 'cannbot-coverage-'))

/** Run one suite with raw coverage enabled; return its exit status. */
function runSuite(script) {
  process.stdout.write(`\n=== coverage: ${script} ===\n`)
  const result = spawnSync(process.execPath, [script], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, NODE_V8_COVERAGE: rawDir },
  })
  return result.status ?? 1
}

let suiteFailed = false
for (const script of OFFLINE_TESTS) {
  if (runSuite(script) !== 0) {
    suiteFailed = true
    break
  }
}

/** URL → absolute path for every `lib/*.js` module. */
const libScripts = new Map()
for (const name of readdirSync(libDir)) {
  if (!name.endsWith('.js')) continue
  const absolute = join(libDir, name)
  libScripts.set(pathToFileURL(absolute).href, absolute)
}

/** Start offset of every line in `source` (UTF-16 code units, matching V8). */
function lineStarts(source) {
  const starts = [0]
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') starts.push(index + 1)
  }
  return starts
}

/** Lines that contain code rather than only blank space or a comment. */
function isCodeLine(text) {
  const trimmed = text.trim()
  if (trimmed === '') return false
  if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed === '*/') return false
  return true
}

/**
 * Apply one process's ranges to the character grid, widest span first.
 *
 * V8 emits a top-level range covering the whole module (count 1) plus function
 * and block ranges nested inside it. Applying widest-first and overwriting
 * leaves the innermost range as the authority for each character.
 */
function applyRanges(source, ranges) {
  const counts = new Uint8Array(source.length)
  const ordered = [...ranges].sort(
    (left, right) => right.endOffset - right.startOffset - (left.endOffset - left.startOffset),
  )
  for (const range of ordered) {
    const from = Math.max(0, Math.min(source.length, range.startOffset))
    const to = Math.max(from, Math.min(source.length, range.endOffset))
    counts.fill(range.count > 0 ? 1 : 0, from, to)
  }
  return counts
}

// ── per-file aggregation ────────────────────────────────────────────────────
const files = new Map()
for (const [url, absolute] of libScripts) {
  files.set(url, {
    absolute,
    source: readFileSync(absolute, 'utf8'),
    coveredLines: new Set(),
    totalFunctions: new Set(),
    executedFunctions: new Set(),
  })
}
for (const [url, file] of files) {
  file.starts = lineStarts(file.source)
  file.codeLines = []
  for (let index = 0; index < file.starts.length; index += 1) {
    const from = file.starts[index]
    const to = index + 1 < file.starts.length ? file.starts[index + 1] : file.source.length
    if (!isCodeLine(file.source.slice(from, to))) continue
    file.codeLines.push({ number: index + 1, from, to })
  }
}

for (const name of readdirSync(rawDir)) {
  if (!name.startsWith('coverage-') || !name.endsWith('.json')) continue
  let document
  try {
    document = JSON.parse(readFileSync(join(rawDir, name), 'utf8'))
  } catch {
    continue
  }
  for (const script of document.result ?? []) {
    const file = files.get(script.url)
    if (file === undefined) continue
    const ranges = []
    for (const fn of script.functions ?? []) {
      const identity = `${fn.functionName}@${fn.ranges?.[0]?.startOffset ?? 0}`
      file.totalFunctions.add(identity)
      let executed = false
      for (const range of fn.ranges ?? []) {
        ranges.push(range)
        if (range.count > 0) executed = true
      }
      if (executed) file.executedFunctions.add(identity)
    }
    const counts = applyRanges(file.source, ranges)
    for (const line of file.codeLines) {
      for (let index = line.from; index < line.to; index += 1) {
        if (counts[index] === 1) {
          file.coveredLines.add(line.number)
          break
        }
      }
    }
  }
}

const reports = [...files.values()].map((file) => ({
  file: relative(root, file.absolute),
  lines: file.codeLines.length,
  covered: file.coveredLines.size,
  functions: file.totalFunctions.size,
  executedFunctions: file.executedFunctions.size,
  uncoveredLines: file.codeLines.filter((line) => !file.coveredLines.has(line.number)).map((line) => line.number),
}))
reports.sort((left, right) => left.file.localeCompare(right.file))

const totals = reports.reduce(
  (sum, report) => ({
    lines: sum.lines + report.lines,
    covered: sum.covered + report.covered,
    functions: sum.functions + report.functions,
    executedFunctions: sum.executedFunctions + report.executedFunctions,
  }),
  { lines: 0, covered: 0, functions: 0, executedFunctions: 0 },
)
const lineRate = totals.lines === 0 ? 100 : (totals.covered / totals.lines) * 100
const functionRate = totals.functions === 0 ? 100 : (totals.executedFunctions / totals.functions) * 100
const percent = (value) => `${value.toFixed(2)}%`

// ── report ──────────────────────────────────────────────────────────────────
console.log('\n=== coverage (V8 nested ranges projected to lines/functions) ===')
for (const report of reports) {
  const uncovered = report.uncoveredLines.length === 0 ? '' : `   uncovered: ${report.uncoveredLines.join(',')}`
  console.log(
    `${report.file.padEnd(26)} lines ${String(report.covered).padStart(4)}/${String(report.lines).padEnd(4)} ${percent(
      report.lines === 0 ? 100 : (report.covered / report.lines) * 100,
    ).padStart(7)}   functions ${report.executedFunctions}/${report.functions}${uncovered}`,
  )
}
console.log(`\nTOTAL lines ${totals.covered}/${totals.lines} ${percent(lineRate)}`)
console.log(`TOTAL functions ${totals.executedFunctions}/${totals.functions} ${percent(functionRate)}`)

mkdirSync(coverageDir, { recursive: true })
writeFileSync(
  join(coverageDir, 'coverage-summary.json'),
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      method: 'v8-nested-ranges-projected-to-lines-and-functions',
      totals: { ...totals, lineRate, functionRate },
      thresholds: { minLines: opts.minLines, minFunctions: opts.minFunctions },
      files: reports,
    },
    null,
    2,
  )}\n`,
)
writeFileSync(
  join(coverageDir, 'coverage.md'),
  [
    '# Coverage',
    '',
    'Method: V8 nested ranges (innermost wins) projected to source lines and functions.',
    '',
    '| File | Lines | Line % | Functions | Function % |',
    '|---|---:|---:|---:|---:|',
    ...reports.map(
      (report) =>
        `| \`${report.file}\` | ${report.covered}/${report.lines} | ${percent(
          report.lines === 0 ? 100 : (report.covered / report.lines) * 100,
        )} | ${report.executedFunctions}/${report.functions} | ${percent(
          report.functions === 0 ? 100 : (report.executedFunctions / report.functions) * 100,
        )} |`,
    ),
    `| **Total** | **${totals.covered}/${totals.lines}** | **${percent(lineRate)}** | **${totals.executedFunctions}/${totals.functions}** | **${percent(functionRate)}** |`,
    '',
  ].join('\n'),
)
console.log('\nwrote coverage/coverage-summary.json and coverage/coverage.md')

if (!opts.keep) rmSync(rawDir, { recursive: true, force: true })

if (suiteFailed) {
  console.error('FAIL: a suite failed; coverage is not a pass.')
  process.exit(1)
}
if (lineRate < opts.minLines) {
  console.error(`FAIL: line coverage ${percent(lineRate)} is below the ${opts.minLines}% threshold.`)
  process.exit(1)
}
if (functionRate < opts.minFunctions && totals.functions > 0) {
  console.error(`FAIL: function coverage ${percent(functionRate)} is below the ${opts.minFunctions}% threshold.`)
  process.exit(1)
}
console.log(`\nPASS: coverage gates met (lines >= ${opts.minLines}%, functions >= ${opts.minFunctions}%).`)
