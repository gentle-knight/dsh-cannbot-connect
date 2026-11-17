/**
 * Offline checks for CANNWork credential discovery.
 *
 * CANNWork writes the JWT to opencode's XDG data dir and the VK to its config
 * dir; older layouts kept both in the data dir, and some builds stored the VK
 * as `cannbot-cli.refresh`. The route and the standalone local service each
 * read these files on every request, so both must resolve the same layouts in
 * the same order — otherwise `/healthz` reports `missing` (or DSH and the
 * editor sidebar disagree) after a CANNWork update.
 *
 * These checks run against temporary `XDG_DATA_HOME` / `XDG_CONFIG_HOME` roots,
 * so they never read, print, or touch the real sign-in.
 *
 * Run with `npm test`. Exits 0 when every check passes, 1 otherwise.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readAccountVk as adapterVk, readJwt as adapterJwt } from '../lib/index.js'
import { readAccountVk as serviceVk, readJwt as serviceJwt } from '../lib/local-server.js'

const JWT_DATA = 'jwt-from-data-dir'
const JWT_CONFIG = 'jwt-from-config-dir'
const VK_DATA = 'vk-from-data-dir'
const VK_CONFIG = 'vk-from-config-dir'
const VK_REFRESH = 'vk-legacy-refresh'

let failures = 0
const fail = (message) => {
  console.error(`FAIL: ${message}`)
  failures += 1
}
const ok = (message) => console.log(`ok   ${message}`)

/**
 * Run one assertion with temp roots in place.
 *
 * `data`/`config` map a file name to its parsed value (or raw invalid text), so
 * each layout is written exactly where the lookup should find it.
 */
function withLayout({ data = {}, config = {} }, fn) {
  const base = mkdtempSync(join(tmpdir(), 'dsh-cannbot-creds-'))
  const roots = { data: join(base, 'data', 'opencode'), config: join(base, 'config', 'opencode') }
  mkdirSync(roots.data, { recursive: true })
  mkdirSync(roots.config, { recursive: true })

  const write = (root, name, value) => {
    if (value === undefined) return
    writeFileSync(join(root, name), typeof value === 'string' ? value : JSON.stringify(value))
  }
  write(roots.data, 'session.json', data.session)
  write(roots.data, 'auth.json', data.auth)
  write(roots.config, 'session.json', config.session)
  write(roots.config, 'auth.json', config.auth)

  const saved = { data: process.env.XDG_DATA_HOME, config: process.env.XDG_CONFIG_HOME }
  process.env.XDG_DATA_HOME = join(base, 'data')
  process.env.XDG_CONFIG_HOME = join(base, 'config')
  try {
    fn()
  } finally {
    if (saved.data === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = saved.data
    if (saved.config === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = saved.config
    rmSync(base, { recursive: true, force: true })
  }
}

/** Assert that both readers resolve the layout to the same values. */
function expectBoth(label, expectedJwt, expectedVk) {
  let bad = false
  for (const [who, readJwt, readVk] of [
    ['local service', serviceJwt, serviceVk],
    ['adapter', adapterJwt, adapterVk],
  ]) {
    const jwt = readJwt()
    const vk = readVk()
    if (jwt !== expectedJwt) {
      fail(`${label}: ${who} jwt expected ${JSON.stringify(expectedJwt)}, got ${JSON.stringify(jwt)}`)
      bad = true
    }
    if (vk !== expectedVk) {
      fail(`${label}: ${who} vk expected ${JSON.stringify(expectedVk)}, got ${JSON.stringify(vk)}`)
      bad = true
    }
  }
  if (!bad) ok(label)
}

// ── 1. current CANNWork layout: JWT in data, VK in config ───────────────────
withLayout(
  { data: { session: { accessToken: JWT_DATA } }, config: { auth: { cannbot: { key: VK_CONFIG } } } },
  () => expectBoth('current layout: data JWT + config VK', JWT_DATA, VK_CONFIG),
)

// ── 2. older layout: both files in the data dir ─────────────────────────────
withLayout(
  {
    data: {
      session: { accessToken: JWT_DATA },
      auth: { cannbot: { key: VK_DATA } },
    },
  },
  () => expectBoth('older layout: both files in the data dir', JWT_DATA, VK_DATA),
)

// ── 3. legacy oauth entry: cannbot-cli.refresh with the vk- prefix ──────────
withLayout(
  { data: { auth: { 'cannbot-cli': { refresh: VK_REFRESH } } } },
  () => expectBoth('legacy vk- refresh is accepted as the VK', undefined, VK_REFRESH),
)

// ── 4. an unrelated refresh token is never sent as the VK ───────────────────
withLayout(
  { data: { auth: { 'cannbot-cli': { refresh: 'refresh-token-without-prefix' } } } },
  () => expectBoth('a refresh token without the vk- prefix is refused', undefined, undefined),
)

// ── 5. lookup order: the data dir wins over the config dir ──────────────────
withLayout(
  {
    data: {
      session: { accessToken: JWT_DATA },
      auth: { cannbot: { key: VK_DATA } },
    },
    config: {
      session: { accessToken: JWT_CONFIG },
      auth: { cannbot: { key: VK_CONFIG } },
    },
  },
  () => expectBoth('the data dir wins when both roots carry a value', JWT_DATA, VK_DATA),
)

// ── 6. config-only sign-in is still found ───────────────────────────────────
withLayout(
  { config: { session: { accessToken: JWT_CONFIG }, auth: { cannbot: { key: VK_CONFIG } } } },
  () => expectBoth('config-only sign-in is found', JWT_CONFIG, VK_CONFIG),
)

// ── 7. unreadable JSON degrades to the next root ────────────────────────────
withLayout(
  {
    data: { session: '{ not json', auth: '{ not json' },
    config: { session: { accessToken: JWT_CONFIG }, auth: { cannbot: { key: VK_CONFIG } } },
  },
  () => expectBoth('unparseable JSON in one root falls through to the other', JWT_CONFIG, VK_CONFIG),
)

// ── 8. empty values are skipped, not mistaken for a credential ──────────────
withLayout(
  {
    data: { session: { accessToken: '' }, auth: { cannbot: { key: '' } } },
    config: { session: { accessToken: JWT_CONFIG }, auth: { cannbot: { key: VK_CONFIG } } },
  },
  () => expectBoth('empty values fall through to the next root', JWT_CONFIG, VK_CONFIG),
)

if (failures > 0) {
  console.error(`\nFAIL: ${failures} check(s) failed.`)
  process.exit(1)
}
console.log('\nPASS: both readers find every supported CANNWork layout.')
process.exit(0)
