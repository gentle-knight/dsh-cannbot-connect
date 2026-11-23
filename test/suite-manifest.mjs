/**
 * The suite list must match the files on disk.
 *
 * `scripts/test-suites.mjs` is the one list `npm test`, the host matrix, and
 * coverage consume. A new `test/*.mjs` file that nobody adds to it would run
 * nowhere, which is exactly the kind of gap this project is trying to close.
 * The reverse also matters: a deleted file left in the list would fail only
 * when a runner happens to reach it.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { LIVE_TEST, OFFLINE_TESTS } from '../scripts/test-suites.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const onDisk = readdirSync(here)
  .filter((name) => name.endsWith('.mjs'))
  .map((name) => `test/${name}`)
  .sort()

let failures = 0
const fail = (message) => {
  console.error(`FAIL: ${message}`)
  failures += 1
}
const ok = (message) => console.log(`ok   ${message}`)

const listed = [...OFFLINE_TESTS].sort()
const duplicates = listed.filter((path, index) => listed.indexOf(path) !== index)
if (duplicates.length > 0) fail(`duplicate entries in OFFLINE_TESTS: ${duplicates.join(', ')}`)
else ok('the suite list has no duplicates')

const missingFromList = onDisk.filter((path) => !OFFLINE_TESTS.includes(path))
const missingOnDisk = OFFLINE_TESTS.filter((path) => !onDisk.includes(path))
if (missingFromList.length > 0) fail(`test files not run by any suite: ${missingFromList.join(', ')}`)
else ok('every test file is in OFFLINE_TESTS')
if (missingOnDisk.length > 0) fail(`listed test files that do not exist: ${missingOnDisk.join(', ')}`)
else ok('every listed suite exists')

if (OFFLINE_TESTS.includes(LIVE_TEST)) fail(`${LIVE_TEST} must not be part of the offline list`)
else if (onDisk.includes(LIVE_TEST)) fail(`${LIVE_TEST} must live at the repository root, not under test/`)
else ok('the live suite is separate from the offline list')

const manifest = JSON.parse(readFileSync(resolve(here, '..', 'package.json'), 'utf8'))
if (manifest.scripts?.test !== 'node scripts/run-tests.mjs') {
  fail(`package.json test should run scripts/run-tests.mjs, got ${manifest.scripts?.test}`)
} else ok('package.json test points at the Node runner')
if (manifest.scripts?.check !== 'node scripts/check-all.mjs') {
  fail(`package.json check should run scripts/check-all.mjs, got ${manifest.scripts?.check}`)
} else ok('package.json check points at the Node orchestrator')

if (failures > 0) {
  console.error(`\nFAIL: ${failures} suite-manifest check(s) failed.`)
  process.exit(1)
}
console.log(`\nPASS: ${OFFLINE_TESTS.length} offline suites are listed and present.`)
