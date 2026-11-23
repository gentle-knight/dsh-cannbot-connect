/**
 * Offline checks for credential discovery, ordering, and expiry decoding.
 *
 * Both credentials live in opencode's own files; the plugin only reads them.
 * The ordering rules matter because a stale copy in one root must not shadow a
 * rotated one in the other, and the JWT expiry is a diagnostic (not an auth
 * decision) that drives the "reopen CANNWork" warning. No test touches the real
 * CANNWork state: every case points XDG at a fresh temporary root.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  authStatus,
  jwtExpiresAt,
  normalizeCredential,
  readAccountVk,
  readJwt,
} from '../lib/credentials.js'

let failures = 0
const fail = (message) => {
  console.error(`FAIL: ${message}`)
  failures += 1
}
const ok = (message) => console.log(`ok   ${message}`)

const eq = (label, actual, expected) => {
  if (Object.is(actual, expected)) ok(`${label} = ${JSON.stringify(actual)}`)
  else fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

const check = (label, predicate, detail) => {
  if (predicate) ok(label)
  else fail(`${label}${detail === undefined ? '' : `: ${detail}`}`)
}

/** A fresh pair of XDG roots with the supplied files in each `opencode/` dir. */
async function withRoots({ data = {}, config = {} }, fn) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-cannbot-creds-'))
  const dataRoot = join(home, 'data')
  const configRoot = join(home, 'config')
  mkdirSync(join(dataRoot, 'opencode'), { recursive: true })
  mkdirSync(join(configRoot, 'opencode'), { recursive: true })
  for (const [name, value] of Object.entries(data)) {
    writeFileSync(join(dataRoot, 'opencode', name), typeof value === 'string' ? value : JSON.stringify(value))
  }
  for (const [name, value] of Object.entries(config)) {
    writeFileSync(join(configRoot, 'opencode', name), typeof value === 'string' ? value : JSON.stringify(value))
  }
  const previous = {
    data: process.env.XDG_DATA_HOME,
    config: process.env.XDG_CONFIG_HOME,
    home: process.env.HOME,
    userProfile: process.env.USERPROFILE,
  }
  process.env.XDG_DATA_HOME = dataRoot
  process.env.XDG_CONFIG_HOME = configRoot
  process.env.HOME = home
  process.env.USERPROFILE = home
  try {
    return await fn({ home, dataRoot, configRoot })
  } finally {
    if (previous.data === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previous.data
    if (previous.config === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous.config
    if (previous.home === undefined) delete process.env.HOME
    else process.env.HOME = previous.home
    if (previous.userProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previous.userProfile
    rmSync(home, { recursive: true, force: true })
  }
}

/** A syntactically valid JWT with an arbitrary payload (signature ignored). */
function makeJwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.not-a-real-signature`
}

// ── VK lookup order ─────────────────────────────────────────────────────────
await withRoots(
  {
    data: { 'auth.json': { cannbot: { key: 'vk-from-data' } } },
    config: { 'auth.json': { cannbot: { key: 'vk-from-config' } } },
  },
  () => {
    eq('the config-dir VK wins over a stale data-dir copy', readAccountVk(), 'vk-from-config')
  },
)

await withRoots(
  { data: { 'auth.json': { cannbot: { key: 'vk-only-data' } } } },
  () => {
    eq('a data-dir-only VK is still found', readAccountVk(), 'vk-only-data')
  },
)

await withRoots(
  { data: { 'auth.json': { 'cannbot-cli': { refresh: 'vk-legacy-refresh' } } } },
  () => {
    eq('the legacy cannbot-cli refresh shape is the fallback', readAccountVk(), 'vk-legacy-refresh')
  },
)

await withRoots(
  { data: { 'auth.json': { 'cannbot-cli': { refresh: 'not-a-vk-token' } } } },
  () => {
    eq('a non-vk refresh token is never sent as the VK', readAccountVk(), undefined)
  },
)

await withRoots({ data: { 'session.json': '{not json' } }, () => {
  eq('an unparseable session.json reads as absent', readJwt(), undefined)
})

await withRoots({}, async ({ dataRoot }) => {
  mkdirSync(join(dataRoot, 'opencode', 'session.json'))
  eq('a directory named session.json reads as absent', readJwt(), undefined)
})

// ── JWT lookup order and parsing ────────────────────────────────────────────
const expiredJwt = makeJwt({ exp: 1_700_000_000, sub: 'a' })
const liveJwt = makeJwt({ exp: 4_000_000_000, sub: 'b' })

await withRoots(
  {
    data: { 'session.json': { accessToken: liveJwt } },
    config: { 'session.json': { accessToken: expiredJwt } },
  },
  () => {
    eq('the data-dir JWT is preferred', readJwt() === liveJwt, true)
  },
)

await withRoots({ data: { 'session.json': { accessToken: '' } }, config: { 'session.json': { accessToken: liveJwt } } }, () => {
  eq('an empty data-dir token falls through to the config dir', readJwt() === liveJwt, true)
})

eq('a JWT expiry is decoded', jwtExpiresAt(liveJwt), 4_000_000_000 * 1000)
eq('an opaque token has no known expiry', jwtExpiresAt('opaque-token'), undefined)
eq('a non-token value has no expiry', jwtExpiresAt(undefined), undefined)
const malformed = 'header.not-json.signature'
eq('a malformed payload reads as unknown', jwtExpiresAt(malformed), undefined)

// ── authStatus is value-free and provenance-aware ───────────────────────────
await withRoots(
  {
    data: { 'session.json': { accessToken: liveJwt } },
    config: { 'auth.json': { cannbot: { key: 'vk-status-value' } } },
  },
  () => {
    const status = authStatus()
    eq('status reports the JWT present', status.jwt.present, true)
    eq('status reports the JWT root', status.jwt.root, 'data')
    eq('status reports the JWT expiry', status.jwt.expiresAtMs, 4_000_000_000 * 1000)
    eq('status reports the VK present', status.vk.present, true)
    eq('status reports the VK root', status.vk.root, 'config')
    check('status carries a source path', typeof status.jwt.source === 'string' && status.jwt.source.length > 0)
    check('status carries an mtime', Number.isFinite(status.jwt.mtimeMs) && status.jwt.mtimeMs > 0)
    const serialized = JSON.stringify(status)
    check('status never contains the JWT value', serialized.includes(liveJwt) === false)
    check('status never contains the VK value', serialized.includes('vk-status-value') === false)
  },
)

// ── normalisation rules ─────────────────────────────────────────────────────
const rejects = (label, value, code) => {
  try {
    normalizeCredential(value, 'the test credential')
    fail(`${label}: expected a refusal`)
  } catch (error) {
    eq(`${label}: code`, error.code, code)
  }
}
rejects('an empty credential is missing', '', 'MISSING_CREDENTIAL')
rejects('a whitespace-only credential is missing', '   ', 'MISSING_CREDENTIAL')
rejects('an embedded newline is malformed', 'abc\ndef', 'INVALID_CREDENTIAL')
rejects('an embedded space is malformed', 'abc def', 'INVALID_CREDENTIAL')
rejects('a non-ASCII credential is malformed', 'vk-非ascii', 'INVALID_CREDENTIAL')
eq('a padded credential is trimmed', normalizeCredential('  vk-ok  ', 'the test credential'), 'vk-ok')

if (failures > 0) {
  console.error(`\nFAIL: ${failures} credential check(s) failed.`)
  process.exit(1)
}
console.log('\nPASS: credential ordering, expiry decoding, and normalisation hold.')
