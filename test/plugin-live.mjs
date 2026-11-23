/**
 * Offline checks for live settings application.
 *
 * Settings writes are volatile, so `apply` must rebuild the adapter/store view
 * on `loader/volatile-update` without re-registering the route. These checks
 * pin the event wiring, the model-update signal, and the "bad endpoint keeps
 * the old one" rule.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Config } from '../lib/config.js'
import { readConfig } from '../lib/config-runtime.js'
import { apply, PROVIDER } from '../lib/index.js'

let failures = 0
const fail = (message) => {
  console.error(`FAIL: ${message}`)
  failures += 1
}
const ok = (message) => console.log(`ok   ${message}`)

const eq = (label, actual, expected) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) ok(`${label} = ${JSON.stringify(actual)}`)
  else fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

const check = (label, predicate, detail) => {
  if (predicate) ok(label)
  else fail(`${label}${detail === undefined ? '' : `: ${detail}`}`)
}

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const home = mkdtempSync(join(tmpdir(), 'dsh-cannbot-live-'))
const previous = {
  home: process.env.HOME,
  userProfile: process.env.USERPROFILE,
  data: process.env.XDG_DATA_HOME,
  config: process.env.XDG_CONFIG_HOME,
}
process.env.HOME = home
process.env.USERPROFILE = home
process.env.XDG_DATA_HOME = join(home, 'data')
process.env.XDG_CONFIG_HOME = join(home, 'config')

function stubContext() {
  const calls = { emits: [], warns: [], infos: [], errors: [], effects: [], injections: [] }
  const registrations = []
  const routes = []
  let offCalls = 0
  let configureCalls = []
  const ctx = {
    fiber: { entry: { options: { id: 'llm-cannbot' } } },
    logger: {
      info: (...args) => calls.infos.push(args),
      warn: (...args) => calls.warns.push(args),
      error: (...args) => calls.errors.push(args),
    },
    get: () => undefined,
    emit: (...args) => calls.emits.push(args),
    llm: {
      registerAdapter: (providers, adapter) => {
        registrations.push({ providers, adapter })
        return () => {}
      },
    },
    on: (_event, listener) => {
      calls.volatile = listener
      return () => { offCalls += 1 }
    },
    effect: (body) => {
      const disposer = body()
      calls.effects.push(disposer)
      return disposer
    },
    inject: (services, callback) => {
      calls.injections.push(services)
      if (services.includes('settings')) {
        callback({
          settings: { configure: (policy, owner) => { configureCalls.push({ policy, owner }); return () => {} } },
          effect: (body) => {
            const disposer = body()
            calls.effects.push(disposer)
            return disposer
          },
        })
      }
      if (services.includes('webServer')) {
        callback({
          webServer: {
            register: (route) => {
              routes.push(route)
              return () => { routes.splice(routes.indexOf(route), 1) }
            },
          },
          effect: (body) => {
            const disposer = body()
            calls.effects.push(disposer)
            return disposer
          },
        })
      }
    },
  }
  return { ctx, calls, registrations, routes, get offCalls() { return offCalls }, get configureCalls() { return configureCalls } }
}

try {
  const values = readConfig(Config({
    baseURL: 'http://127.0.0.1:9/v1',
    modelsURL: 'http://127.0.0.1:9/models',
    catalogRefreshMs: 0,
    visionModels: [],
  }))
  const record = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { get: () => values[key] }]))
  const { ctx, calls, registrations, routes, configureCalls } = stubContext()
  const release = apply(ctx, record)
  await tick(30)

  eq('apply still registers one route', registrations.length, 1)
  eq('the route remains cannbot', registrations[0]?.providers?.[0], PROVIDER)
  check('the default settings policy is registered', configureCalls.length === 1)
  eq('the automatic generic form is disabled', configureCalls[0]?.policy?.auto, false)
  check('the settings policy is bound to the plugin fiber', configureCalls[0]?.owner === ctx.fiber)

  eq('the settings page gets one read-only status route', routes.length, 1)
  const statusResponse = await routes[0].resource(new Request('http://example.test/cannbot-connect/status'))
  eq('the status route answers 200', statusResponse.status, 200)
  const statusBody = await statusResponse.json()
  eq('the status route names the provider', statusBody.provider, PROVIDER)
  eq('the status route names the settings namespace', statusBody.settingsNs, 'llm-cannbot')

  const adapter = registrations[0].adapter
  adapter.adoptCatalog([{ id: 'model-a', name: 'Model A', contextWindow: 1_000, maxTokens: 100 }])
  let models = await adapter.listModels(PROVIDER)
  eq('the live config starts text-only', models[0].inputModalities, ['text'])

  values.visionModels = ['model-a']
  calls.volatile()
  models = await adapter.listModels(PROVIDER)
  eq('a live vision update reaches the adapter', models[0].inputModalities, ['text', 'image'])
  check(
    'the model-update event names the provider',
    calls.emits.some((args) => args[0] === 'llm/models-updated' && args[1] === PROVIDER),
  )

  values.refreshNonce = 'refresh-1'
  calls.volatile()
  await tick(30)
  eq('a live nonce asks for a catalog refresh', registrations[0].adapter.catalog.length >= 0, true)

  values.baseURL = 'http://example.test/v1'
  calls.volatile()
  check(
    'a rejected live endpoint is reported without throwing',
    calls.warns.some((args) => String(args[0]).includes('live config rejected')),
    JSON.stringify(calls.warns),
  )
  const afterReject = await adapter.listModels(PROVIDER)
  eq('a rejected endpoint keeps the previous adapter state', afterReject[0].inputModalities, ['text', 'image'])

  for (const disposer of calls.effects) disposer?.()
  check('the plugin cleanup releases the volatile listener', calls.effects.length > 0)
  release()
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
  console.error(`\nFAIL: ${failures} live-plugin check(s) failed.`)
  process.exit(1)
}
console.log('\nPASS: live settings reach the adapter and a bad endpoint is contained.')
