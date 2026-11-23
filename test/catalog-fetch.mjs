/**
 * Offline checks for the roster HTTP call and the store's failure paths.
 *
 * The store's happy path is covered in catalog.mjs; this file forces the
 * gateway answers that a live run rarely produces (500, 401, malformed JSON,
 * an empty roster, a loader that throws) and the disposal races around
 * `refreshSoon`. They are the difference between "the endpoint is down" and
 * "the credentials expired" in the log a user reads.
 */
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CatalogStore, fetchCatalog } from '../lib/catalog.js'

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

const home = mkdtempSync(join(tmpdir(), 'dsh-cannbot-catalog-fetch-'))
mkdirSync(join(home, 'data', 'opencode'), { recursive: true })
writeFileSync(join(home, 'data', 'opencode', 'session.json'), JSON.stringify({ accessToken: 'test-jwt-catalog-0123456789' }))
const previous = {
  home: process.env.HOME,
  userProfile: process.env.USERPROFILE,
  data: process.env.XDG_DATA_HOME,
  config: process.env.XDG_CONFIG_HOME,
}
process.env.HOME = home
process.env.USERPROFILE = home
process.env.XDG_DATA_HOME = join(home, 'data')
process.env.XDG_CONFIG_HOME = join(home, 'config-empty')

/** One mock roster endpoint with a fixed status/body. */
async function withRoster(status, body, fn) {
  const server = createServer((_req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    return await fn(`http://127.0.0.1:${port}/models`)
  } finally {
    await new Promise((resolve) => {
      server.closeAllConnections?.()
      server.close(resolve)
    })
  }
}

const roster = (personal = [], builtin = []) =>
  JSON.stringify({ success: true, data: { personalModels: personal, builtinModels: builtin } })

try {
  await withRoster(500, 'boom', async (url) => {
    const result = await fetchCatalog({ modelsURL: url })
    eq('a 500 roster answer is a server failure', result.reason, 'server')
  })

  await withRoster(401, '{"message":"no"}', async (url) => {
    const result = await fetchCatalog({ modelsURL: url })
    eq('a 401 roster answer is an auth failure', result.reason, 'auth')
  })

  await withRoster(200, '{"success":false}', async (url) => {
    const result = await fetchCatalog({ modelsURL: url })
    eq('a success:false answer is a server failure', result.reason, 'server')
  })

  await withRoster(200, 'not json', async (url) => {
    const result = await fetchCatalog({ modelsURL: url })
    eq('a malformed roster body falls back to network/server', ['server', 'network'].includes(result.reason), true)
  })

  await withRoster(200, roster(), async (url) => {
    const result = await fetchCatalog({ modelsURL: url })
    eq('an empty roster is a server failure', result.reason, 'server')
  })

  await withRoster(
    200,
    roster(
      [
        { model: 'shared', title: 'Personal shared', apiKey: 'vk-personal', contextLength: 1000 },
        { model: 'personal-only', title: 'Personal', apiKey: 'vk-personal', contextLength: 2000 },
      ],
      [
        { model: 'shared', title: 'Builtin shared', apiKey: 'vk-builtin', contextLength: 1000 },
        { model: 'builtin-only', title: 'Builtin', contextLength: 3000 },
      ],
    ),
    async (url) => {
      const result = await fetchCatalog({ modelsURL: url })
      eq('a successful roster is ok', result.ok, true)
      eq('duplicate ids are deduped with the personal row winning', result.catalog.filter((row) => row.id === 'shared').length, 1)
      eq('the personal row keeps its title', result.catalog.find((row) => row.id === 'shared')?.name, 'Personal shared')
      eq('the personal row keeps its per-model VK', result.catalog.find((row) => row.id === 'shared')?.vk, 'vk-personal')
      eq('builtin rows fill in what personal does not own', result.catalog.some((row) => row.id === 'builtin-only'), true)
    },
  )

  {
    const result = await fetchCatalog({ modelsURL: 'http://127.0.0.1:9/models' })
    eq('an unreachable endpoint is a network failure', result.reason, 'network')
  }

  // ── store failure/disposal branches ──────────────────────────────────────
  {
    const observed = []
    const store = new CatalogStore({
      modelsURL: 'http://127.0.0.1:9/models',
      refreshMs: 0,
      loader: async () => {
        throw new Error('loader exploded')
      },
      onFailure: (reason, meta) => observed.push(`${reason}:${meta.reason}`),
    })
    const result = await store.refresh('manual')
    eq('a throwing loader reports unknown', result.reason, 'unknown')
    eq('a throwing loader reaches onFailure', observed.join(','), 'unknown:manual')
    store.dispose()
  }

  {
    const calls = []
    const store = new CatalogStore({
      modelsURL: 'https://example.test/models',
      refreshMs: 0,
      loader: async () => {
        calls.push(1)
        return { ok: true, catalog: [] }
      },
      onCatalog: () => {},
      onFailure: () => {},
    })
    store.refreshSoon(5)
    store.dispose()
    await new Promise((resolve) => setTimeout(resolve, 80))
    eq('dispose cancels a pending refreshSoon', calls.length, 0)
    const after = await store.refresh('manual')
    eq('refresh after dispose returns undefined', after, undefined)
    eq('refreshSoon after dispose is a no-op', (store.refreshSoon(1), true), true)
  }
} finally {
  if (previous.home === undefined) delete process.env.HOME
  else process.env.HOME = previous.home
  if (previous.userProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = previous.userProfile
  if (previous.data === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = previous.data
  if (previous.config === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = previous.config
  rmSync(home, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\nFAIL: ${failures} catalog-fetch check(s) failed.`)
  process.exit(1)
}
console.log('\nPASS: roster failures and store disposal branches hold.')
