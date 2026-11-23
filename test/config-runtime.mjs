/**
 * Offline checks for the live configuration projection.
 *
 * A wrong projection here means the adapter sees `{ get() }` objects as values
 * and the settings page writes fields the Host never applies, so the plain
 * snapshot and the model-facing diff are pinned directly.
 */
import { Config } from '../lib/config.js'
import {
  DEFAULTS, modelFacingChanged, readConfig, refreshRequested,
} from '../lib/config-runtime.js'

let failures = 0
const fail = (message) => {
  console.error(`FAIL: ${message}`)
  failures += 1
}
const ok = (message) => console.log(`ok   ${message}`)

const eq = (label, actual, expected) => {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  if (same) ok(`${label} = ${JSON.stringify(actual)}`)
  else fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

const check = (label, predicate, detail) => {
  if (predicate) ok(label)
  else fail(`${label}${detail === undefined ? '' : `: ${detail}`}`)
}

// ── wrapper and plain records resolve the same way ──────────────────────────
const wrapped = readConfig(Config({ visionModels: ['model-a'] }))
eq('wrapper defaults still resolve', wrapped.streamIdleTimeoutMs, DEFAULTS.streamIdleTimeoutMs)
eq('wrapper overrides resolve', wrapped.visionModels, ['model-a'])
const visionInput = ['model-b']
const plain = readConfig({ visionModels: { get: () => visionInput }, refreshNonce: 'nonce-1' })
eq('plain records resolve with defaults', plain.defaultMaxTokens, DEFAULTS.defaultMaxTokens)
eq('plain arrays are detached', plain.visionModels, ['model-b'])
check('the resolved vision array is not the input array', plain.visionModels !== visionInput)

const empty = readConfig()
eq('an absent record reads all defaults', empty.catalogRefreshMs, DEFAULTS.catalogRefreshMs)
eq('an absent record has an empty refresh nonce', empty.refreshNonce, '')

// ── model-facing changes are only the metadata fields ───────────────────────
const base = readConfig(Config({}))
check(
  'visionModels changes model metadata',
  modelFacingChanged(base, { ...base, visionModels: ['model-a'] }),
)
check(
  'default capacities change model metadata',
  modelFacingChanged(base, { ...base, defaultContextWindow: 1_024 }),
)
check(
  'image budgets do not change model metadata',
  !modelFacingChanged(base, { ...base, requestImagePixelBudget: 1_024 }),
)
check(
  'stream timeouts do not change model metadata',
  !modelFacingChanged(base, { ...base, streamIdleTimeoutMs: 1_000 }),
)

// ── refresh nonce semantics ─────────────────────────────────────────────────
check('an empty nonce never refreshes', !refreshRequested(base, { ...base, refreshNonce: '' }))
check('a changed nonce refreshes', refreshRequested(base, { ...base, refreshNonce: 'nonce-2' }))
check('the same nonce does not refresh twice', !refreshRequested(
  { ...base, refreshNonce: 'nonce-2' },
  { ...base, refreshNonce: 'nonce-2' },
))

if (failures > 0) {
  console.error(`\nFAIL: ${failures} live-config check(s) failed.`)
  process.exit(1)
}
console.log('\nPASS: live config projection and change detection hold.')
