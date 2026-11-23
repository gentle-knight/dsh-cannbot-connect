#!/usr/bin/env node
/**
 * The single verification entry point, with no shell operators.
 *
 * `npm run check` must behave the same in bash, zsh, cmd.exe, and PowerShell.
 * npm runs scripts through a platform shell, and `&&` chaining is not uniform
 * across those shells; this runner spawns each step directly with the current
 * Node binary instead.
 */
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { OFFLINE_TESTS } from './test-suites.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STEPS = [
  ['syntax', 'scripts/check-syntax.mjs'],
  ['offline tests', 'scripts/run-tests.mjs'],
  ['host matrix', 'scripts/host-matrix.mjs'],
  ['coverage', 'scripts/coverage.mjs'],
  ['secret scan', 'scripts/check-secrets.mjs'],
]

let failed = false
for (const [label, script] of STEPS) {
  process.stdout.write(`\n=== check: ${label} ===\n`)
  const result = spawnSync(process.execPath, [resolve(root, script)], { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) {
    failed = true
    console.error(`\nFAIL: ${label} (${script}) exited with ${result.status}`)
    break
  }
}

if (failed) process.exit(1)
console.log(`\nPASS: check — ${STEPS.length} steps (syntax, ${OFFLINE_TESTS.length} offline suites, host matrix, coverage, secrets).`)
