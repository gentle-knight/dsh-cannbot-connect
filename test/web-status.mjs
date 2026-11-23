/**
 * Offline checks for the read-only status route.
 *
 * The route is the only HTTP surface this plugin adds. Its shape matters:
 * exact path, authenticated GET, no-store JSON, and a generic 500 body that
 * never carries internal diagnostics.
 */
import { registerStatusRoute, STATUS_PATH } from '../lib/web.js'

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

const registered = []
const ctx = {
  webServer: {
    register(route) {
      registered.push(route)
      return () => { registered.pop() }
    },
  },
}

const dispose = registerStatusRoute(ctx, () => ({
  ok: true,
  credentials: { jwt: { present: true } },
  models: [{ id: 'model-a' }],
}))
eq('the route is exact and at the documented path', registered[0]?.kind === 'exact' && registered[0]?.path === STATUS_PATH, true)
eq('the route requires authentication', registered[0]?.auth, 'required')
check('the route is a resource, not a mutating handler', typeof registered[0]?.resource === 'function')

const response = await registered[0].resource(new Request(`http://example.test${STATUS_PATH}`))
eq('the status route answers 200', response.status, 200)
eq('the status route is no-store', response.headers.get('cache-control'), 'no-store')
check('the status route is JSON', response.headers.get('content-type')?.startsWith('application/json') === true)
const body = await response.json()
eq('the status body is passed through', body.ok, true)
eq('the model rows are passed through', body.models[0].id, 'model-a')

dispose()
eq('the disposer removes the registration', registered.length, 0)

const failing = registerStatusRoute(ctx, () => {
  throw new Error('secret path /home/user/.config/opencode/auth.json')
})
const failed = await registered[0].resource(new Request(`http://example.test${STATUS_PATH}`))
eq('a failed status read answers 500', failed.status, 500)
const failureBody = await failed.json()
eq('a failed status read has a generic body', failureBody.error, 'status unavailable')
check('a failed status read leaks no diagnostic', !JSON.stringify(failureBody).includes('auth.json'))
failing()

const noop = registerStatusRoute({}, () => ({}))
check('a profile without a WebServer gets a no-op disposer', typeof noop === 'function')
noop()

if (failures > 0) {
  console.error(`\nFAIL: ${failures} status-route check(s) failed.`)
  process.exit(1)
}
console.log('\nPASS: the status route is read-only, authenticated, and secret-free.')
