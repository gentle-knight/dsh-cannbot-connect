/**
 * Offline checks for the Cordis plugin contract.
 *
 * `apply` is the one function the host calls. These checks mount it against a
 * minimal context stub to prove the route is registered under the expected
 * provider, the returned disposer is callable, an invalid endpoint fails at
 * mount instead of on the first request, and a profile without the attachment
 * or effect APIs still mounts.
 */
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CannbotAdapter, Config, PROVIDER, apply, readAccountVk, readJwt } from '../lib/index.js'

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

/** An XDG root with no CANNWork files, so `apply` never touches the network. */
function isolateCredentials() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-cannbot-plugin-'))
  mkdirSync(join(home, 'opencode'), { recursive: true })
  const previousHome = { home: process.env.HOME, userProfile: process.env.USERPROFILE }
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.XDG_DATA_HOME = home
  process.env.XDG_CONFIG_HOME = join(home, 'config-empty')
  return () => {
    if (previousHome.home === undefined) delete process.env.HOME
    else process.env.HOME = previousHome.home
    if (previousHome.userProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previousHome.userProfile
    rmSync(home, { recursive: true, force: true })
  }
}

/** A Cordis context with only what `apply` reads. */
function stubContext({ withEffect = true } = {}) {
  const calls = { info: [], warn: [], emit: [], effects: [] }
  const registrations = []
  let release
  const ctx = {
    logger: {
      info: (...args) => calls.info.push(args),
      warn: (...args) => calls.warn.push(args),
    },
    get: () => undefined,
    emit: (...args) => calls.emit.push(args),
    llm: {
      registerAdapter: (providers, adapter) => {
        registrations.push({ providers, adapter })
        release = () => {
          calls.released = true
        }
        return release
      },
    },
  }
  if (withEffect) {
    ctx.effect = (body) => {
      const disposer = body()
      calls.effects.push(disposer)
      return disposer
    }
  }
  return { ctx, calls, registrations }
}

const cleanup = isolateCredentials()
try {
  // ── mount without credentials ─────────────────────────────────────────────
  {
    const { ctx, calls, registrations } = stubContext()
    const returned = apply(ctx, Config({}))
    eq('apply registers one provider route', registrations.length, 1)
    eq('provider route is cannbot', registrations[0]?.providers?.[0], PROVIDER)
    check('registered adapter is a CannbotAdapter', registrations[0]?.adapter instanceof CannbotAdapter)
    check('apply returns the registration disposer', typeof returned === 'function')
    eq('apply ran one effect', calls.effects.length, 1)
    check('mount logged the credential presence', calls.info.some(([line]) => /jwt=missing/.test(line)))
    returned()
    eq('returned disposer is callable', calls.released, true)
  }

  // ── no credentials are a normal mount state, not a throw ──────────────────
  eq('readJwt resolves nothing in an empty root', readJwt(), undefined)
  eq('readAccountVk resolves nothing in an empty root', readAccountVk(), undefined)

  // ── an insecure non-loopback endpoint fails at mount ──────────────────────
  {
    const { ctx } = stubContext()
    let error
    try {
      apply(ctx, Config({ baseURL: 'http://example.test/v1' }))
    } catch (thrown) {
      error = thrown
    }
    check('plain-http non-loopback baseURL is refused at mount', error !== undefined)
    eq('insecure endpoint keeps a stable failure code', error?.code, 'INVALID_CONFIG')
  }

  // ── loopback http is allowed for local mocks ─────────────────────────────
  {
    const { ctx, registrations } = stubContext()
    const returned = apply(ctx, Config({ baseURL: 'http://127.0.0.1:9/v1', modelsURL: 'http://127.0.0.1:9/models' }))
    eq('loopback http mounts', registrations.length, 1)
    check('loopback mount returns a disposer', typeof returned === 'function')
  }

  // ── a profile without ctx.effect still mounts ────────────────────────────
  {
    const { ctx, registrations } = stubContext({ withEffect: false })
    const returned = apply(ctx, Config({ baseURL: 'http://127.0.0.1:9/v1', modelsURL: 'http://127.0.0.1:9/models' }))
    eq('apply without ctx.effect registers the route', registrations.length, 1)
    check('apply without ctx.effect still returns the disposer', typeof returned === 'function')
  }


  // ── a successful roster notifies both catalog events ─────────────────────
  {
    const roster = {
      success: true,
      data: {
        personalModels: [
          { model: 'model-a', title: 'Model A', apiKey: 'vk-model-a', contextLength: 1_000 },
          { model: 'model-b', title: 'Model B', contextLength: 2_000 },
        ],
        builtinModels: [],
      },
    }
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(roster))
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    // The isolated fixture has no sign-in; give it one so fetchCatalog runs.
    writeFileSync(
      join(process.env.XDG_DATA_HOME, 'opencode', 'session.json'),
      JSON.stringify({ accessToken: 'test-jwt-plugin-0123456789abcdef' }),
    )
    try {
      const { ctx, calls, registrations } = stubContext()
      apply(ctx, Config({ baseURL: `http://127.0.0.1:${port}/v1`, modelsURL: `http://127.0.0.1:${port}/models` }))
      await new Promise((resolve) => setTimeout(resolve, 300))
      check(
        'a successful roster is logged with its model count',
        calls.info.some(([line]) => /2 models available/.test(line)),
        JSON.stringify(calls.info),
      )
      check(
        'the topology event is emitted',
        calls.emit.some((args) => args[0] === 'llm/adapters-updated'),
      )
      check(
        'the catalog event names the provider',
        calls.emit.some((args) => args[0] === 'llm/models-updated' && args[1] === PROVIDER),
      )
      const models = await registrations[0].adapter.listModels(PROVIDER)
      eq('the registered adapter adopted the roster', models.length, 2)
      for (const disposer of calls.effects) disposer?.()
    } finally {
      await new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(resolve)
      })
    }
  }

  // ── an expired JWT is warned about at mount ───────────────────────────────
  {
    const expired = (() => {
      const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
      return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ exp: 1 })}.not-a-signature`
    })()
    writeFileSync(
      join(process.env.XDG_DATA_HOME, 'opencode', 'session.json'),
      JSON.stringify({ accessToken: expired }),
    )
    const { ctx, calls } = stubContext()
    apply(ctx, Config({ baseURL: 'http://127.0.0.1:9/v1', modelsURL: 'http://127.0.0.1:9/models' }))
    check(
      'an expired JWT is reported with a re-sign-in hint',
      calls.warn.some(([line]) => /access token is expired/.test(line)),
      JSON.stringify(calls.warn),
    )
    for (const disposer of calls.effects) disposer?.()
  }

  // ── catalog probing happens after mount and never blocks it ──────────────
  {
    const { ctx, calls } = stubContext()
    apply(ctx, Config({ baseURL: 'http://127.0.0.1:9/v1', modelsURL: 'http://127.0.0.1:9/models' }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    check(
      'a credential-less catalog probe is logged as unavailable',
      calls.warn.some(([line]) => /catalog unavailable/.test(line)),
      JSON.stringify(calls.warn),
    )
  }
} finally {
  cleanup()
}

if (failures > 0) {
  console.error(`\nFAIL: ${failures} plugin-contract check(s) failed.`)
  process.exit(1)
}
console.log('\nPASS: the plugin contract mounts, registers, and disposes as expected.')
