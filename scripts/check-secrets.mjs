#!/usr/bin/env node
/**
 * Pre-publish guard: fail if a credential literal or machine-specific path
 * reaches the tracked tree or the Git history.
 *
 * The POSIX shell version of this check existed first, but `npm run check` is
 * also invoked on Windows, where `./check-secrets.sh` is not executable. This
 * Node implementation is the canonical one; `check-secrets.sh` now delegates to
 * it so a Linux shell habit and `npm run check` cannot drift.
 *
 * The patterns are the shape of real credentials, not words like "token":
 * a real CANNBOT VK is `vk-` plus 32 hex characters, so the test fixtures such
 * as `test-vk-...` do not trip the scanner (and the history scan stays usable
 * without rewriting history).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const SELF = ['scripts/check-secrets.mjs', 'check-secrets.sh']

const PATTERNS = [
  String.raw`vk-[0-9a-fA-F]{32,}`,
  String.raw`eyJ[A-Za-z0-9_-]{20,}`,
  String.raw`sk-[A-Za-z0-9]{20,}`,
  'GITCODE_API_TOKEN',
  String.raw`ghp_[A-Za-z0-9]{20,}`,
  String.raw`/Users/[A-Za-z0-9_-]+/`,
  String.raw`-----BEGIN [A-Z ]+PRIVATE KEY-----`,
]

/** Run a git command and return its stdout, or undefined when git is unusable. */
function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.error !== undefined) {
    console.error(`FAIL: git is not available (${result.error.message}); the history scan needs it.`)
    return undefined
  }
  return result.status === 0 ? result.stdout : result.status === 1 ? '' : undefined
}

const tracked = git(['ls-files', '-z'])
if (tracked === undefined) process.exit(1)
const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']) ?? ''
const files = [...new Set(`${tracked}${untracked}`.split('\0').filter(Boolean))]
  .filter((path) => !SELF.includes(path))
  .sort()

let findings = 0

// ── working tree ────────────────────────────────────────────────────────────
console.log('== working tree ==')
for (const path of files) {
  let text
  try {
    text = readFileSync(join(root, path), 'utf8')
  } catch {
    continue // a deleted tracked file, or a directory entry
  }
  for (const pattern of PATTERNS) {
    const regex = new RegExp(pattern)
    const lines = text.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      if (!regex.test(lines[index])) continue
      console.log(`${path}:${index + 1}: matched ${pattern}`)
      findings += 1
      break
    }
  }
}
console.log(findings === 0 ? 'clean' : '^^ FOUND — remove before publishing')

// ── Git history ─────────────────────────────────────────────────────────────
console.log('\n== git history ==')
const revisions = (git(['rev-list', '--all']) ?? '').split('\n').filter(Boolean)
if (revisions.length === 0) {
  console.log('clean (no history yet)')
} else {
  const excluded = SELF.flatMap((path) => [':(exclude)' + path])
  const result = spawnSync(
    'git',
    ['grep', '-nE', PATTERNS.join('|'), ...revisions, '--', '.', ...excluded],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  if (result.error !== undefined) {
    console.error(`FAIL: history scan failed (${result.error.message})`)
    findings += 1
  } else if (result.status === 0) {
    console.log(result.stdout.trim().split('\n').slice(0, 20).join('\n'))
    console.log('^^ FOUND in history — rewrite history before publishing')
    findings += 1
  } else if (result.status === 1) {
    console.log('clean')
  } else {
    console.error(`FAIL: history scan exited with ${result.status}`)
    findings += 1
  }
}

// ── tracked inventory (diagnostic only) ────────────────────────────────────
console.log('\n== tracked files ==')
for (const path of files) console.log(path)

if (findings > 0) {
  console.error(`\nFAIL: ${findings} secret-pattern finding(s).`)
  process.exit(1)
}
console.log('\nPASS: no credential literals or machine-specific paths found.')
