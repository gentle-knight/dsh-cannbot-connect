#!/usr/bin/env node
/**
 * Run the offline suite against more than one DSH host line.
 *
 * The plugin's `node_modules` symlinks point at one installed host, so the
 * default `npm test` only proves compatibility with that host. This script
 * builds a throwaway package root per host (copying `lib/` and `test/`,
 * symlinking the host's `@deepseek-ai/*` packages) and runs every offline
 * script there. It is the regression net for host export removals such as
 * 0.2.3-alpha dropping `assertUsableApiKey`.
 *
 * Usage:
 *   node scripts/host-matrix.mjs                 # stable + alpha when present
 *   node scripts/host-matrix.mjs --require-all   # a missing host is a failure
 *   node scripts/host-matrix.mjs --live          # also run e2e.mjs (credentials + quota)
 *
 * Override host roots with CANNBOT_HOST_STABLE / CANNBOT_HOST_ALPHA (either a
 * dsh install root or a workspace containing `node_modules/@deepseek-ai`).
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(here, '..')

const args = new Set(process.argv.slice(2))
const requireAll = args.has('--require-all')
const live = args.has('--live')

/** Host install roots; each must contain `node_modules/@deepseek-ai`. */
const HOSTS = [
  {
    name: 'stable',
    label: '0.2.2-rc.3',
    root:
      process.env.CANNBOT_HOST_STABLE ??
      '/home/developer/.nvm/versions/node/v24.22.3/lib/node_modules/@deepseek-ai/dsh',
  },
  {
    name: 'alpha',
    label: '0.2.3-alpha.2',
    root: process.env.CANNBOT_HOST_ALPHA ?? '/home/developer/agent/workspace/dsh-alpha',
  },
]

/** Offline scripts, in the order `npm test` runs them. */
const OFFLINE_TESTS = [
  'test/import-surface.mjs',
  'test/config.mjs',
  'test/manifest.mjs',
  'test/plugin.mjs',
  'test/wire.mjs',
  'test/errors.mjs',
  'test/security.mjs',
  'test/adapter-usage.mjs',
  'test/adapter-auth.mjs',
  'test/adapter-image.mjs',
]

/** Packages every host must provide for the offline suite. */
const HOST_PACKAGES = ['cordis', 'dsh-llm', 'schemastery']

let failed = false
let ran = 0
const skipped = []

/** Version of one host package, or undefined when it is absent. */
function versionOf(hostModules, name) {
  try {
    return JSON.parse(readFileSync(join(hostModules, name, 'package.json'), 'utf8')).version
  } catch {
    return undefined
  }
}

/** Copy the plugin sources into one throwaway package root for a host. */
function stageHost(host) {
  const hostModules = join(host.root, 'node_modules', '@deepseek-ai')
  const missing = HOST_PACKAGES.filter((name) => !existsSync(join(hostModules, name)))
  if (missing.length > 0) return { problem: `missing packages: ${missing.join(', ')}` }

  const dir = mkdtempSync(join(tmpdir(), `cannbot-matrix-${host.name}-`))
  for (const entry of ['lib', 'test']) cpSync(join(packageDir, entry), join(dir, entry), { recursive: true })
  for (const entry of ['package.json', 'cordis.patch.yml', 'README.md', 'e2e.mjs']) {
    if (existsSync(join(packageDir, entry))) cpSync(join(packageDir, entry), join(dir, entry))
  }
  mkdirSync(join(dir, 'node_modules', '@deepseek-ai'), { recursive: true })
  for (const name of HOST_PACKAGES) {
    symlinkSync(join(hostModules, name), join(dir, 'node_modules', '@deepseek-ai', name), 'dir')
  }
  return { dir }
}

/** Run one test file in a staged root and report the outcome. */
function runScript(dir, script, host) {
  const result = spawnSync(process.execPath, [script], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, DSH_MATRIX_HOST: host.name },
    timeout: 120_000,
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (result.status === 0) {
    console.log(`  ok   ${script}`)
    return true
  }
  failed = true
  console.error(`  FAIL ${script} (exit ${result.status})`)
  console.error(
    output
      .split('\n')
      .filter((line) => /FAIL|Error|error:|not defined|not exported|SyntaxError/.test(line))
      .slice(0, 12)
      .map((line) => `       ${line}`)
      .join('\n'),
  )
  return false
}

for (const host of HOSTS) {
  const version = versionOf(join(host.root, 'node_modules', '@deepseek-ai'), 'dsh-llm')
  console.log(`\n== ${host.name} (${version ?? host.label}) — ${host.root}`)
  const staged = stageHost(host)
  if (staged.problem !== undefined) {
    skipped.push(`${host.name}: ${staged.problem}`)
    console.warn(`  skip: ${staged.problem}`)
    if (requireAll) failed = true
    continue
  }

  ran += 1
  let hostFailed = false
  for (const script of OFFLINE_TESTS) {
    if (!runScript(staged.dir, script, host)) hostFailed = true
  }
  if (live) {
    const result = spawnSync(process.execPath, ['e2e.mjs'], {
      cwd: staged.dir,
      encoding: 'utf8',
      env: { ...process.env, DSH_MATRIX_HOST: host.name },
      timeout: 240_000,
    })
    if (result.status === 0) {
      console.log('  ok   e2e.mjs (live)')
    } else {
      hostFailed = true
      failed = true
      console.error(`  FAIL e2e.mjs (exit ${result.status})`)
      console.error((result.stdout ?? '').split('\n').slice(-12).map((line) => `       ${line}`).join('\n'))
    }
  }
  rmSync(staged.dir, { recursive: true, force: true })
  if (!hostFailed) console.log(`  PASS ${host.name}`)
  else console.log(`  FAIL ${host.name}`)
}

console.log('')
if (ran === 0) {
  console.error('FAIL: no host line could be staged.')
  process.exit(1)
}
if (skipped.length > 0) console.log(`skipped: ${skipped.join('; ')}`)
if (failed) {
  console.error(`\nFAIL: host matrix failed (${ran} host line(s) ran).`)
  process.exit(1)
}
console.log(`\nPASS: host matrix holds on ${ran} host line(s).`)
