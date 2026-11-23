#!/usr/bin/env node
/**
 * Run every offline suite in one process tree, stopping at the first failure.
 *
 * npm scripts are shell strings, and the Windows command processor and a POSIX
 * shell disagree about quoting and `&&` semantics. A Node runner gives Linux,
 * macOS, and Windows the same behaviour, and it is the one place the suite list
 * is consumed together with the host matrix and coverage.
 */
import { spawnSync } from 'node:child_process'

import { OFFLINE_TESTS } from './test-suites.mjs'

let failed = false
for (const script of OFFLINE_TESTS) {
  process.stdout.write(`\n=== ${script} ===\n`)
  const result = spawnSync(process.execPath, [script], { stdio: 'inherit' })
  if (result.status !== 0) {
    failed = true
    console.error(`\nFAIL: ${script} exited with ${result.status}`)
    break
  }
}

if (failed) process.exit(1)
console.log(`\nPASS: all ${OFFLINE_TESTS.length} offline suites.`)
