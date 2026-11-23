/**
 * Offline checks for the browser half's registration shape.
 *
 * The client module cannot be rendered without a React runtime, but its loader
 * entry, required services, and the two slot registrations are pure functions
 * of the module and can be exercised with a stub context. This catches a
 * missing `settings.models.footer` or a wrong settings namespace before the
 * page silently renders nothing.
 */
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

let entry
globalThis.window = {
  __ModuleLoader__: {
    load(value) { entry = value },
  },
}

await import(`${new URL('../client.js', import.meta.url).href}?test=${Date.now()}`)
check('the client registers a loader entry', entry !== undefined)
eq('the loader id is the package name', entry?.id, 'dsh-cannbot-connect')

const FakeReact = {
  createElement: () => null,
  useCallback: () => {},
  useEffect: () => {},
  useId: () => '',
  useMemo: () => {},
  useRef: () => ({}),
  useState: () => [],
  useSyncExternalStore: () => ({}),
}
const client = entry.factory((name) => {
  if (name === 'react') return FakeReact
  throw new Error(`unexpected client require: ${name}`)
})
eq('the client requires slots and locale', client.inject.join(','), 'slots,locale')

const namespaces = []
const registrations = []
const child = {
  configForms: {
    get: (ns) => {
      namespaces.push(ns)
      return { ns, getSnapshot: () => ({ status: 'ready' }) }
    },
  },
  slots: {
    inject: (_name, callback) => { callback(); return () => {} },
    register: (options, component) => {
      registrations.push({ options, component })
      return () => {}
    },
  },
  effect: (body) => { body(); return () => {} },
}
const ctx = {
  effect: (body) => { body(); return () => {} },
  locale: { register: () => () => {}, bind: () => (key) => key },
  inject: (services, callback) => { if (services.includes('configForms')) callback(child) },
}
client.apply(ctx)

eq(
  'the client registers the Settings section and Models footer',
  registrations.map(({ options }) => `${options.name}:${options.id}`).sort().join(','),
  'settings.models.footer:cannbot-connect,settings.section:cannbot-connect',
)
check(
  'the primary settings namespace is llm-cannbot',
  namespaces.includes('llm-cannbot'),
  namespaces.join(','),
)
check(
  'the section registration carries a label',
  typeof registrations.find(({ options }) => options.name === 'settings.section')?.options.label === 'function',
)

delete globalThis.window

if (failures > 0) {
  console.error(`\nFAIL: ${failures} client-bundle check(s) failed.`)
  process.exit(1)
}
console.log('\nPASS: the client loader registers both surfaces against the plugin namespace.')
