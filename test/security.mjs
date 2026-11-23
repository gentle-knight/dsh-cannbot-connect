/**
 * Offline security checks for the CANNBOT route.
 *
 * These run without the live gateway and without touching CANNWork, so they can
 * be run anywhere. They assert the three properties the plugin's credential
 * handling depends on:
 *
 *   1. an endpoint that would put the access token on the wire in the clear is
 *      refused where the configuration is written;
 *   2. a redirect never forwards the credentials to another origin;
 *   3. provider-supplied failure text never reaches a diagnostic with the
 *      credential still in it.
 *
 * Run with `npm test`. Exits 0 when every check passes, 1 otherwise.
 */
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CannbotAdapter, apply } from '../lib/index.js'

let failures = 0
const fail = (message) => {
  console.error(`FAIL: ${message}`)
  failures += 1
}
const ok = (message) => console.log(`ok   ${message}`)

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} }

// ── isolated credential fixture ─────────────────────────────────────────────
//
// These checks must never read the machine's real CANNWork sign-in: a test that
// prints or forwards a real token is a security defect of the test itself. The
// fake JWT/VK are also what the gateway echo below is asserted to redact.
const FAKE_JWT = 'test-jwt-0123456789abcdef'
const FAKE_VK = 'vk-test-0123456789abcdef'
const fixtureHome = mkdtempSync(join(tmpdir(), 'dsh-cannbot-security-'))
mkdirSync(join(fixtureHome, 'data', 'opencode'), { recursive: true })
mkdirSync(join(fixtureHome, 'config', 'opencode'), { recursive: true })
writeFileSync(join(fixtureHome, 'data', 'opencode', 'session.json'), JSON.stringify({ accessToken: FAKE_JWT }))
writeFileSync(join(fixtureHome, 'config', 'opencode', 'auth.json'), JSON.stringify({ cannbot: { key: FAKE_VK } }))
const previousHome = {
  home: process.env.HOME,
  userProfile: process.env.USERPROFILE,
  data: process.env.XDG_DATA_HOME,
  config: process.env.XDG_CONFIG_HOME,
}
process.env.HOME = fixtureHome
process.env.USERPROFILE = fixtureHome
process.env.XDG_DATA_HOME = join(fixtureHome, 'data')
process.env.XDG_CONFIG_HOME = join(fixtureHome, 'config')
const cleanupFixture = () => {
  if (previousHome.home === undefined) delete process.env.HOME
  else process.env.HOME = previousHome.home
  if (previousHome.userProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = previousHome.userProfile
  if (previousHome.data === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = previousHome.data
  if (previousHome.config === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = previousHome.config
  rmSync(fixtureHome, { recursive: true, force: true })
}

/** A context stub sufficient to call `apply()` without a real Cordis host. */
function stubContext() {
  return {
    logger: silentLogger,
    llm: { registerAdapter: () => () => {} },
    effect: (fn) => fn(),
    emit: () => {},
  }
}

const expectThrow = (label, fn) => {
  try {
    fn()
    fail(`${label}: expected a refusal, got none`)
  } catch {
    ok(label)
  }
}

// ── 1. insecure endpoints are refused ────────────────────────────────────────
expectThrow('plain-http baseURL is refused', () =>
  apply(stubContext(), { baseURL: 'http://gateway.example.com/v1' }),
)
expectThrow('plain-http modelsURL is refused', () =>
  apply(stubContext(), { modelsURL: 'http://gateway.example.com/models' }),
)
expectThrow('a malformed endpoint is refused', () => apply(stubContext(), { baseURL: 'not-a-url' }))

try {
  apply(stubContext(), { baseURL: 'http://127.0.0.1:9/v1', modelsURL: 'http://127.0.0.1:9/models' })
  ok('loopback http is allowed (local mock/proxy)')
} catch (error) {
  fail(`loopback http should be allowed: ${error.message}`)
}

// ── 2. a redirect must not forward credentials ───────────────────────────────
/** Start a server on loopback; returns { url, port, close, requests }. */
async function startServer(handler) {
  const server = createServer(handler)
  const requests = []
  server.on('request', (req) => requests.push(req))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    port,
    requests,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

const jwt = FAKE_JWT
const vk = FAKE_VK

{
  // The redirect target records whether it was ever contacted at all.
  const target = await startServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"choices":[]}')
  })
  const redirector = await startServer((_req, res) => {
    res.writeHead(302, { Location: `${target.url}/chat/completions` })
    res.end()
  })

  const adapter = new CannbotAdapter({
    baseURL: redirector.url,
    modelsURL: `${redirector.url}/models`,
    streamIdleTimeoutMs: 5_000,
    defaultContextWindow: 1_048_576,
    defaultMaxTokens: 1_024,
  })

  let redirected = false
  try {
    for await (const _chunk of adapter.stream({
      provider: 'cannbot',
      model: 'deepseek-v4.1-flash',
      messages: [
        { id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } },
      ],
    })) {
      // no chunks expected: the request must fail at the redirect
    }
  } catch {
    redirected = true
  }

  if (!redirected) fail('a redirecting endpoint did not fail the request')
  else ok('a redirecting endpoint fails the request instead of following it')

  if (target.requests.length !== 0) {
    const leaked = target.requests.some((req) => req.headers.authorization !== undefined)
    fail(
      `the redirect target was contacted ${target.requests.length} time(s)` +
        (leaked ? ' and received the Authorization header' : ''),
    )
  } else {
    ok('the redirect target was never contacted (credentials stayed put)')
  }

  await redirector.close()
  await target.close()

  // ── 3. provider failure text is redacted ───────────────────────────────────
  const echoing = await startServer((_req, res) => {
    // A hostile or careless endpoint echoing request headers back at us.
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        error: { message: `bad request; saw x-api-vkey=${vk} authorization=Bearer ${jwt}` },
      }),
    )
  })

  const echoAdapter = new CannbotAdapter({
    baseURL: echoing.url,
    modelsURL: `${echoing.url}/models`,
    streamIdleTimeoutMs: 5_000,
    defaultContextWindow: 1_048_576,
    defaultMaxTokens: 1_024,
  })

  let message = ''
  try {
    for await (const _chunk of echoAdapter.stream({
      provider: 'cannbot',
      model: 'deepseek-v4.1-flash',
      messages: [
        { id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } },
      ],
    })) {
      // no chunks expected
    }
  } catch (error) {
    message = String(error?.message ?? error)
  }

  await echoing.close()

  if (message === '') fail('an erroring endpoint produced no failure')
  else if (message.includes(jwt) || message.includes(vk)) {
    fail('the failure message still contains the credential')
  } else if (!message.includes('[redacted]')) {
    fail(`the failure message was not redacted: ${message.slice(0, 160)}`)
  } else {
    ok('credential material is redacted out of provider failure text')
  }
}

cleanupFixture()

if (failures > 0) {
  console.error(`\nFAIL: ${failures} check(s) failed.`)
  process.exit(1)
}
console.log('\nPASS: credential-handling checks hold.')
process.exit(0)
