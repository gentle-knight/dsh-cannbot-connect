/**
 * Offline checks for the roster lifecycle.
 *
 * The adapter mounts immediately with a fallback model and swaps in the live
 * roster later, so the store's concurrency, failure, retry, and disposal rules
 * are part of the request contract: a disposed plugin must not keep polling, a
 * slow endpoint must not stack requests, and a failure must never erase the
 * roster the user is already using.
 */
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

const check = (label, predicate, detail) => {
  if (predicate) ok(label)
  else fail(`${label}${detail === undefined ? '' : `: ${detail}`}`)
}

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const CATALOG = [{ id: 'model-a', name: 'Model A', contextWindow: 1_000, maxTokens: 100 }]

/** A loader whose calls are recorded and whose answer is controlled per call. */
function controlledLoader() {
  const calls = []
  let answer = { ok: true, catalog: CATALOG }
  let gate
  const loader = async (options) => {
    calls.push(options)
    if (gate !== undefined) await gate
    return answer
  }
  return {
    calls,
    loader,
    setAnswer(next) {
      answer = next
    },
    hold() {
      let release
      gate = new Promise((resolve) => {
        release = resolve
      })
      return () => {
        gate = undefined
        release()
      }
    },
  }
}

// ── mount fetch and observers ────────────────────────────────────────────────
{
  const control = controlledLoader()
  const observed = []
  const store = new CatalogStore({
    modelsURL: 'https://example.test/models',
    refreshMs: 0,
    loader: control.loader,
    onCatalog: (catalog, meta) => observed.push({ type: 'catalog', catalog, reason: meta.reason }),
    onFailure: (reason, meta) => observed.push({ type: 'failure', reason, reasonKind: meta.reason }),
  })
  store.start()
  await tick(10)
  eq('start fetches once', control.calls.length, 1)
  eq('loader receives the roster endpoint', control.calls[0]?.modelsURL, 'https://example.test/models')
  eq('a successful fetch reaches onCatalog', observed[0]?.type, 'catalog')
  eq('the mount reason is recorded', observed[0]?.reason, 'mount')
  eq('the catalog is passed through', observed[0]?.catalog.length, 1)
  store.dispose()
}

// ── a failure reports its reason and keeps the store alive ──────────────────
{
  const control = controlledLoader()
  control.setAnswer({ ok: false, reason: 'auth', catalog: [] })
  const observed = []
  const store = new CatalogStore({
    modelsURL: 'https://example.test/models',
    refreshMs: 0,
    loader: control.loader,
    onCatalog: () => observed.push('catalog'),
    onFailure: (reason) => observed.push(`failure:${reason}`),
  })
  await store.refresh('manual')
  eq('a failed fetch reaches onFailure with its reason', observed.join(','), 'failure:auth')
  eq('a failed fetch does not call onCatalog', observed.includes('catalog'), false)
  store.dispose()
}

// ── concurrent callers share one in-flight request ──────────────────────────
{
  const control = controlledLoader()
  const release = control.hold()
  const store = new CatalogStore({
    modelsURL: 'https://example.test/models',
    refreshMs: 0,
    loader: control.loader,
    onCatalog: () => {},
    onFailure: () => {},
  })
  const first = store.refresh('manual')
  const second = store.refresh('manual')
  eq('concurrent refreshes share one loader call', control.calls.length, 1)
  release()
  await Promise.all([first, second])
  eq('the shared request settles once', control.calls.length, 1)
  store.dispose()
}

// ── the timer refreshes periodically and stops on dispose ───────────────────
{
  const control = controlledLoader()
  const store = new CatalogStore({
    modelsURL: 'https://example.test/models',
    refreshMs: 20,
    loader: control.loader,
    onCatalog: () => {},
    onFailure: () => {},
  })
  store.start()
  await tick(75)
  check('the timer fetches more than once', control.calls.length >= 2, `${control.calls.length}`)
  store.dispose()
  const afterDispose = control.calls.length
  await tick(60)
  eq('dispose stops the timer', control.calls.length, afterDispose)
}

// ── refreshSoon retries once and ignores a burst ────────────────────────────
{
  const control = controlledLoader()
  const store = new CatalogStore({
    modelsURL: 'https://example.test/models',
    refreshMs: 0,
    loader: control.loader,
    onCatalog: () => {},
    onFailure: () => {},
  })
  store.refreshSoon(5)
  store.refreshSoon(5)
  store.refreshSoon(5)
  await tick(30)
  eq('a burst of refreshSoon calls results in one retry', control.calls.length, 1)
  store.dispose()
}

// ── a disposed store ignores a late answer ─────────────────────────────────
{
  const control = controlledLoader()
  const release = control.hold()
  const observed = []
  const store = new CatalogStore({
    modelsURL: 'https://example.test/models',
    refreshMs: 0,
    loader: control.loader,
    onCatalog: () => observed.push('catalog'),
    onFailure: () => observed.push('failure'),
  })
  const pending = store.refresh('manual')
  store.dispose()
  release()
  await pending
  eq('a disposed store drops the late answer', observed.length, 0)
}

// ── fetchCatalog without a JWT is an auth result, not a throw ───────────────
{
  const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const previous = { data: process.env.XDG_DATA_HOME, config: process.env.XDG_CONFIG_HOME }
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cannbot-catalog-'))
  mkdirSync(join(dir, 'opencode'), { recursive: true })
  process.env.XDG_DATA_HOME = dir
  process.env.XDG_CONFIG_HOME = join(dir, 'empty-config')
  try {
    const result = await fetchCatalog({ modelsURL: 'http://127.0.0.1:9/models' })
    eq('a credential-less catalog fetch reports auth', result.reason, 'auth')
    eq('a credential-less catalog fetch returns no models', result.catalog.length, 0)
  } finally {
    if (previous.data === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previous.data
    if (previous.config === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous.config
    rmSync(dir, { recursive: true, force: true })
  }
}

if (failures > 0) {
  console.error(`\nFAIL: ${failures} catalog check(s) failed.`)
  process.exit(1)
}
console.log('\nPASS: roster lifecycle, retry, and disposal hold.')
