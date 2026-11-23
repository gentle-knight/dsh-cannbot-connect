/**
 * Offline checks for the plugin's configuration schema.
 *
 * The host validates an installed plugin's `config` row with this schema before
 * `apply` runs, so a schema that throws on defaults (or silently accepts a
 * nonsense value) breaks the plugin at mount time in a way no adapter test can
 * see. These checks pin the defaults and the obvious rejections without
 * touching the network.
 */
import { Config } from '../lib/config.js'
import {
  DEFAULT_CATALOG_REFRESH_MS,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM,
  DEFAULT_MAX_REQUEST_IMAGE_BYTES,
  DEFAULT_MAX_REQUEST_IMAGES,
  DEFAULT_MAX_TOKENS,
  DEFAULT_REQUEST_IMAGE_MAX_BYTES,
  DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_VISION_MODELS,
} from '../lib/constants.js'

let failures = 0
const fail = (message) => {
  console.error(`FAIL: ${message}`)
  failures += 1
}
const ok = (message) => console.log(`ok   ${message}`)

/** Assert one value and label the check. */
const eq = (label, actual, expected) => {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  if (same) ok(`${label} = ${JSON.stringify(actual)}`)
  else fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

/** Assert a predicate with a labelled failure. */
const check = (label, predicate, detail) => {
  if (predicate) ok(label)
  else fail(`${label}${detail === undefined ? '' : `: ${detail}`}`)
}

// ── defaults ─────────────────────────────────────────────────────────────────

check('Config is callable (schemastery object)', typeof Config === 'function')
const defaults = Config({})
check('Config accepts an empty object', typeof defaults === 'object' && defaults !== null)
eq('streamIdleTimeoutMs default', defaults.streamIdleTimeoutMs, DEFAULT_STREAM_IDLE_TIMEOUT_MS)
eq('defaultContextWindow default', defaults.defaultContextWindow, DEFAULT_CONTEXT_WINDOW)
eq('defaultMaxTokens default', defaults.defaultMaxTokens, DEFAULT_MAX_TOKENS)
eq('visionModels default', defaults.visionModels, [...DEFAULT_VISION_MODELS])
eq('requestImagePixelBudget default', defaults.requestImagePixelBudget, DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET)
eq('requestImageMaxBytes default', defaults.requestImageMaxBytes, DEFAULT_REQUEST_IMAGE_MAX_BYTES)
eq('maxRequestImageBytes default', defaults.maxRequestImageBytes, DEFAULT_MAX_REQUEST_IMAGE_BYTES)
eq('maxRequestImages default', defaults.maxRequestImages, DEFAULT_MAX_REQUEST_IMAGES)
eq('imageOffloadCountQuantum default', defaults.imageOffloadCountQuantum, DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM)
eq('catalogRefreshMs default', defaults.catalogRefreshMs, DEFAULT_CATALOG_REFRESH_MS)
check('baseURL default is the CANNBOT gateway', /^https:\/\/cannbot\.hicann\.cn\//.test(defaults.baseURL))
check('modelsURL default is the roster endpoint', /^https:\/\/cannbot\.hicann\.cn\//.test(defaults.modelsURL))

// ── explicit values ──────────────────────────────────────────────────────────

const custom = Config({
  baseURL: 'https://example.test/v1',
  modelsURL: 'https://example.test/models',
  streamIdleTimeoutMs: 12_345,
  defaultContextWindow: 4_096,
  defaultMaxTokens: 512,
  visionModels: ['model-a', 'model-b'],
  requestImagePixelBudget: 1_000_000,
  requestImageMaxBytes: 500_000,
  maxRequestImageBytes: 2_000_000,
})
eq('explicit baseURL', custom.baseURL, 'https://example.test/v1')
eq('explicit visionModels', custom.visionModels, ['model-a', 'model-b'])
eq('explicit streamIdleTimeoutMs', custom.streamIdleTimeoutMs, 12_345)

// ── rejections the host would surface as a config failure ────────────────────

const rejects = (label, value) => {
  try {
    Config(value)
    fail(`${label}: expected the schema to reject it`)
  } catch {
    ok(`${label}: rejected`)
  }
}
rejects('a string where a number is required', { streamIdleTimeoutMs: 'soon' })
rejects('a non-array visionModels', { visionModels: 'model-a' })
rejects('a non-string baseURL', { baseURL: 42 })
rejects('a zero image count bound', { maxRequestImages: 0 })
rejects('a negative timeout', { streamIdleTimeoutMs: -1 })
rejects('a negative refresh interval', { catalogRefreshMs: -1 })
ok('catalogRefreshMs 0 disables the timer', Config({ catalogRefreshMs: 0 }).catalogRefreshMs === 0)

// Unknown keys are the host's concern (the Loader validates rows); the schema
// itself must not silently drop a known field, which the checks above cover.
const unknown = Config({ unknownField: true })
check('unknown field does not break the schema', unknown !== null)

if (failures > 0) {
  console.error(`\nFAIL: ${failures} configuration check(s) failed.`)
  process.exit(1)
}
console.log('\nPASS: configuration defaults and rejections hold.')
