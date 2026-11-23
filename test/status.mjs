/**
 * Offline checks for the Settings page status projection.
 *
 * This is a browser-facing payload: a leaked JWT, VK, or credential path here
 * is a real disclosure, not a cosmetic bug. The checks pin the safe shape and
 * the modality mapping the image switches depend on.
 */
import { buildStatus } from '../lib/status.js'

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

const JWT = 'jwt-secret-value'
const VK = 'vk-secret-value'
const status = buildStatus({
  version: '0.5.0',
  provider: 'cannbot',
  settingsNs: 'llm-cannbot',
  active: true,
  models: [
    { id: 'vision-model', name: 'Vision', contextWindow: 1_000, maxTokens: 100, vk: VK },
    { id: 'text-model', contextWindow: 2_000, vk: VK },
  ],
  auth: {
    jwt: {
      present: true,
      source: `/home/user/.local/share/opencode/session.json`,
      root: 'data',
      label: 'home-data',
      expiresAtMs: Date.now() + 60_000,
    },
    vk: {
      present: true,
      source: `/home/user/.config/opencode/auth.json`,
      root: 'config',
      label: 'home-config',
    },
  },
  catalog: { lastRefreshAt: 1_700_000_000_000, lastReason: 'mount', isRefreshing: false },
  config: {
    baseURL: 'https://example.test/v1',
    modelsURL: 'https://example.test/models',
    catalogRefreshMs: 600_000,
    streamIdleTimeoutMs: 300_000,
    defaultContextWindow: 1_048_576,
    defaultMaxTokens: 131_072,
    visionModels: ['vision-model'],
    requestImagePixelBudget: 4_194_304,
    requestImageMaxBytes: 1_048_576,
    maxRequestImageBytes: 8_388_608,
    maxRequestImages: 1_000_000,
    imageOffloadCountQuantum: 1_000_000,
  },
})

eq('the provider is preserved', status.provider, 'cannbot')
eq('the settings namespace is preserved', status.settingsNs, 'llm-cannbot')
eq('the model count is derived', status.modelCount, 2)
eq('vision modalities follow config', status.models[0].inputModalities, ['text', 'image'])
eq('text models stay text-only', status.models[1].inputModalities, ['text'])
eq('the credential source label is kept', status.credentials.jwt.sourceLabel, 'home-data')
eq('the catalog reason is kept', status.catalog.lastReason, 'mount')

const serialized = JSON.stringify(status)
check('the status never contains the JWT value', !serialized.includes(JWT))
check('the status never contains the VK value', !serialized.includes(VK))
check('the status never contains a credential path', !serialized.includes('/session.json'))
check('the status never contains the VK path', !serialized.includes('/auth.json'))
check('the model rows carry no vk field', status.models.every((model) => !('vk' in model)))

const expired = buildStatus({
  auth: { jwt: { present: true, expiresAtMs: 1 }, vk: { present: false } },
  models: [],
  catalog: {},
  config: { visionModels: [] },
})
check('an expired JWT is marked expired', expired.credentials.jwt.expired === true)
check('a missing VK is marked absent', expired.credentials.vk.present === false)
eq('an unknown catalog failure is dropped', expired.catalog.lastFailure, undefined)

const failed = buildStatus({
  auth: {},
  models: [],
  catalog: { lastFailure: 'auth' },
  config: { visionModels: [] },
  configError: 'baseURL must be https',
})

const endpoint = buildStatus({
  auth: {},
  models: [],
  catalog: {},
  config: {
    baseURL: 'https://user:pass@example.test/v1?token=secret',
    modelsURL: 'https://example.test/models?key=secret',
    visionModels: [],
  },
})
eq('endpoint userinfo is stripped', endpoint.config.baseURL, 'https://example.test/v1')
eq('endpoint query is stripped', endpoint.config.modelsURL, 'https://example.test/models')
check('endpoint status carries no credential', !JSON.stringify(endpoint).includes('secret'))
const badEndpoint = buildStatus({
  auth: {}, models: [], catalog: {},
  config: { baseURL: 'not a url', modelsURL: '', visionModels: [] },
})
eq('a malformed endpoint is not echoed', badEndpoint.config.baseURL, undefined)
eq('a known catalog failure is kept', failed.catalog.lastFailure, 'auth')
eq('a config diagnostic is kept', failed.configError, 'baseURL must be https')

if (failures > 0) {
  console.error(`\nFAIL: ${failures} status check(s) failed.`)
  process.exit(1)
}
console.log('\nPASS: status projection is secret-free and modality-accurate.')
