/**
 * Offline checks for platform-specific credential discovery.
 *
 * Development happens on Linux, so this suite is the only executable evidence
 * for the macOS and Windows path candidates. It tests two things separately:
 *
 *   1. the PURE resolver's candidate list and order for linux/darwin/win32,
 *      which is where a platform convention can be wrong without any I/O; and
 *   2. real file reads against a fake home tree on Linux, using the same
 *      relative layout each platform would have, so the lookup logic (not the
 *      separator) is exercised.
 *
 * The runtime separator on Windows is `node:path`'s `win32.join`; this test
 * cannot reproduce that from Linux, so the residual risk is documented in
 * docs/PLATFORMS.md.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { authStatus, credentialRootEntries, readAccountVk, readJwt } from '../lib/credentials.js'

let failures = 0
const fail = (message) => {
  console.error(`FAIL: ${message}`)
  failures += 1
}
const ok = (message) => console.log(`ok   ${message}`)

const eq = (label, actual, expected) => {
  const same = Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected)
  if (same) ok(`${label} = ${JSON.stringify(actual)}`)
  else fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

const check = (label, predicate, detail) => {
  if (predicate) ok(label)
  else fail(`${label}${detail === undefined ? '' : `: ${detail}`}`)
}

const labels = (entries) => entries.map((entry) => entry.label)

// ── pure resolver: the candidate lists per platform ─────────────────────────
{
  const entries = credentialRootEntries({
    platform: 'linux',
    home: '/home/u',
    env: { XDG_DATA_HOME: '/xdg/data', XDG_CONFIG_HOME: '/xdg/config' },
  })
  eq('linux XDG data candidates', labels(entries.filter((e) => e.kind === 'data')), ['xdg-data', 'home-data'])
  eq('linux XDG config candidates', labels(entries.filter((e) => e.kind === 'config')), ['xdg-config', 'home-config'])
  check('linux XDG dirs are absolute joins', entries[0].dir === '/xdg/data/opencode')
}

{
  const entries = credentialRootEntries({ platform: 'linux', home: '/home/u', env: {} })
  eq('linux without XDG falls back to the home layout', labels(entries), ['home-data', 'home-config'])
  eq('linux home data path', entries[0].dir, '/home/u/.local/share/opencode')
}

{
  const entries = credentialRootEntries({ platform: 'darwin', home: '/Users/<user>', env: {} })
  eq('macOS candidates', labels(entries), ['home-data', 'mac-app-support', 'home-config', 'mac-preferences'])
  eq('macOS app-support path', entries[1].dir, '/Users/<user>/Library/Application Support/opencode')
}

{
  const entries = credentialRootEntries({
    platform: 'win32',
    home: 'C:/Users/<user>',
    env: { LOCALAPPDATA: 'C:/Users/<user>/AppData/Local', APPDATA: 'C:/Users/<user>/AppData/Roaming' },
  })
  eq('Windows data candidates', labels(entries.filter((e) => e.kind === 'data')), [
    'home-data',
    'win-local-data',
    'win-local',
  ])
  eq('Windows config candidates', labels(entries.filter((e) => e.kind === 'config')), [
    'home-config',
    'win-roaming-config',
    'win-roaming',
  ])
  eq('Windows local-data path', entries[1].dir, 'C:/Users/<user>/AppData/Local/opencode/Data')
}

{
  const entries = credentialRootEntries({ platform: 'win32', home: 'C:/Users/<user>', env: {} })
  eq('Windows without APPDATA keeps only the home layout', labels(entries), ['home-data', 'home-config'])
}

{
  const entries = credentialRootEntries({
    platform: 'linux',
    home: '/home/u',
    env: { XDG_DATA_HOME: '/home/u/.local/share', XDG_CONFIG_HOME: '/home/u/.config' },
  })
  eq('an XDG value equal to the home layout is not duplicated', labels(entries), ['xdg-data', 'xdg-config'])
  eq('dedupe keeps one candidate per kind', entries.length, 2)
}

// ── real reads against per-platform fake home trees ─────────────────────────
const FAKE_JWT = 'test-jwt-platform-0123456789abcdef'
const FAKE_VK = 'vk-platform-0123456789abcdef'
const root = mkdtempSync(join(tmpdir(), 'dsh-cannbot-platform-'))

/** Write one JSON file under `root/relative`, creating directories as needed. */
function writeJson(relative, value) {
  const path = join(root, relative)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(value))
}

try {
  // The current layout on every platform: ~/.local/share + ~/.config.
  writeJson('.local/share/opencode/session.json', { accessToken: FAKE_JWT })
  writeJson('.config/opencode/auth.json', { cannbot: { key: FAKE_VK } })
  eq('current layout: JWT is found', readJwt({ platform: 'linux', home: root, env: {} }), FAKE_JWT)
  eq('current layout: VK is found', readAccountVk({ platform: 'linux', home: root, env: {} }), FAKE_VK)

  // macOS env-paths fallback: ~/Library/Application Support + Preferences.
  rmSync(join(root, '.local'), { recursive: true, force: true })
  rmSync(join(root, '.config'), { recursive: true, force: true })
  writeJson('Library/Application Support/opencode/session.json', { accessToken: FAKE_JWT })
  writeJson('Library/Preferences/opencode/auth.json', { cannbot: { key: FAKE_VK } })
  eq('macOS app-support fallback: JWT is found', readJwt({ platform: 'darwin', home: root, env: {} }), FAKE_JWT)
  eq('macOS preferences fallback: VK is found', readAccountVk({ platform: 'darwin', home: root, env: {} }), FAKE_VK)

  // Windows env-paths fallback: %LOCALAPPDATA%\\opencode\\Data + %APPDATA%\\opencode\\Config.
  rmSync(join(root, 'Library'), { recursive: true, force: true })
  const local = join(root, 'AppData', 'Local')
  const roaming = join(root, 'AppData', 'Roaming')
  writeJson('AppData/Local/opencode/Data/session.json', { accessToken: FAKE_JWT })
  writeJson('AppData/Roaming/opencode/Config/auth.json', { cannbot: { key: FAKE_VK } })
  const windowsEnv = { LOCALAPPDATA: local, APPDATA: roaming }
  eq('Windows local-data fallback: JWT is found', readJwt({ platform: 'win32', home: root, env: windowsEnv }), FAKE_JWT)
  eq('Windows roaming-config fallback: VK is found', readAccountVk({ platform: 'win32', home: root, env: windowsEnv }), FAKE_VK)

  // A UTF-8 BOM is tolerated (Windows editors add one).
  writeFileSync(join(root, 'AppData', 'Local', 'opencode', 'Data', 'session.json'), `\uFEFF${JSON.stringify({ accessToken: FAKE_JWT })}`)
  eq('a BOM-prefixed session.json is still parsed', readJwt({ platform: 'win32', home: root, env: windowsEnv }), FAKE_JWT)

  // authStatus reports the platform label without leaking a value.
  const status = authStatus({ platform: 'win32', home: root, env: windowsEnv })
  eq('status reports the Windows data label', status.jwt.label, 'win-local-data')
  eq('status reports the Windows config label', status.vk.label, 'win-roaming-config')
  check('status still contains no JWT value', JSON.stringify(status).includes(FAKE_JWT) === false)
  check('status still contains no VK value', JSON.stringify(status).includes(FAKE_VK) === false)

  // XDG is authoritative first when set, but the home layout remains a fallback.
  const xdgRoot = join(root, 'xdg')
  writeJson('xdg/opencode/session.json', { accessToken: FAKE_JWT })
  eq(
    'an explicit XDG data root is used first',
    readJwt({ platform: 'linux', home: root, env: { XDG_DATA_HOME: xdgRoot } }),
    FAKE_JWT,
  )
} finally {
  rmSync(root, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\nFAIL: ${failures} platform-path check(s) failed.`)
  process.exit(1)
}
console.log('\nPASS: platform credential candidates and fallbacks hold.')
