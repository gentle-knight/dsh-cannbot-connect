/**
 * Offline checks for provider-failure classification.
 *
 * The host routes retries and user-facing advice on `LlmError.code`, and a
 * misclassification is a correctness bug even when every turn "works": a
 * gateway 403 for an unentitled model must not tell the user to sign in again,
 * and a content-free 200 must not look like a clean stop. These checks pin the
 * mapping without a network.
 */
import { assertSecureEndpoint, errorTextOf, providerFailure, redact, safeCount } from '../lib/errors.js'

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

const failure = (status, detail, retryAfter) => providerFailure(status, detail, retryAfter, [])

// ── the status table ─────────────────────────────────────────────────────────

eq('401 stays AUTH', failure(401, 'invalid token').code, 'AUTH')
eq('403 without a model stays AUTH', failure(403, 'forbidden by gateway policy').code, 'AUTH')
eq(
  '403 naming a model is an entitlement failure',
  failure(403, 'Model no-such-model not allowed').code,
  'MODEL_UNSUPPORTED',
)
eq(
  '403 naming a dotted model id is an entitlement failure',
  failure(403, 'Model deepseek-v4.1-flash not allowed').code,
  'MODEL_UNSUPPORTED',
)
eq(
  '403 with unsupported-model wording is an entitlement failure',
  failure(403, 'this model is unsupported on this route').code,
  'MODEL_UNSUPPORTED',
)
eq('429 is RATE_LIMIT', failure(429, 'slow down').code, 'RATE_LIMIT')
eq('500 is SERVER', failure(500, 'boom').code, 'SERVER')
eq('413 is INVALID_REQUEST', failure(413, 'body too large').code, 'INVALID_REQUEST')
eq(
  '400 image refusal is UNSUPPORTED_CONTENT',
  failure(400, 'Invalid content type. image_url is only supported by certain models').code,
  'UNSUPPORTED_CONTENT',
)
eq(
  '400 context overflow keeps its own code',
  failure(400, 'This model maximum context length is 128000 tokens').code,
  'CONTEXT_WINDOW_EXCEEDED',
)
eq('400 quota wording keeps QUOTA', failure(400, 'insufficient quota for this account').code, 'QUOTA')
eq('generic 400 is INVALID_REQUEST', failure(400, 'bad parameter').code, 'INVALID_REQUEST')

// ── structured provider facts ────────────────────────────────────────────────

const model403 = failure(403, 'Model x not allowed')
eq('model refusal retains status', model403.failure?.status, 403)
check('model refusal does not tell the user to sign in', /sign in/i.test(model403.message) === false)
check('model refusal names the verdict', /does not allow this model/.test(model403.message))

const image400 = failure(400, 'The image format is illegal and cannot be opened')
check('image refusal points at visionModels', /visionModels/.test(image400.message))
check('image refusal keeps status 400', image400.failure?.status === 400)
check('image refusal does not tell the user to sign in', /sign in/i.test(image400.message) === false)

const limited = providerFailure(429, 'rate limited', '2', [])
eq('Retry-After seconds become providerRetryAfterMs', limited.failure?.providerRetryAfterMs, 2_000)
const noRetry = failure(429, 'rate limited')
eq('missing Retry-After leaves the fact absent', noRetry.failure?.providerRetryAfterMs, undefined)
const dateRetry = providerFailure(429, 'rate limited', new Date(Date.now() + 30_000).toUTCString(), [])
check(
  'an HTTP-date Retry-After becomes a positive delay',
  dateRetry.failure?.providerRetryAfterMs > 0 && dateRetry.failure.providerRetryAfterMs <= 30_000,
  dateRetry.failure?.providerRetryAfterMs,
)
check('an unparsable Retry-After is ignored', failure(429, 'x', 'soon').failure?.providerRetryAfterMs === undefined)

// ── redaction ────────────────────────────────────────────────────────────────

const secret = 'vk-secret-0123456789'
const redacted = providerFailure(403, `Model x not allowed for ${secret}`, undefined, [secret])
check('provider echo is redacted by value', redacted.message.includes(secret) === false)
check('redaction keeps a marker', /\[redacted\]/.test(redacted.message))
eq('redact is identity for absent secrets', redact('plain', []), 'plain')
eq('redact replaces every occurrence', redact('a b a', ['a']), '[redacted] b [redacted]')

// ── body helper ──────────────────────────────────────────────────────────────

eq('error text reads error.message', errorTextOf(JSON.stringify({ error: { message: 'boom' } })), 'boom')
eq('error text reads top-level message', errorTextOf(JSON.stringify({ message: 'boom' })), 'boom')
eq('error text falls back to the raw body', errorTextOf('not json'), 'not json')

// ── counts ───────────────────────────────────────────────────────────────────

eq('a safe count passes through', safeCount(12), 12)
eq('a negative count is unusable', safeCount(-1), undefined)
eq('a fractional count is unusable', safeCount(1.5), undefined)
eq('a numeric string is unusable', safeCount('12'), undefined)
eq('NaN is unusable', safeCount(Number.NaN), undefined)

// ── endpoint gate ────────────────────────────────────────────────────────────

assertSecureEndpoint('https://example.test/v1', 'baseURL')
ok('https is accepted')
assertSecureEndpoint('http://127.0.0.1:8080/v1', 'baseURL')
ok('loopback http is accepted')
assertSecureEndpoint('http://localhost:8080/v1', 'baseURL')
ok('localhost http is accepted')

const rejects = (label, url) => {
  try {
    assertSecureEndpoint(url, 'baseURL')
    fail(`${label}: expected a refusal`)
  } catch (error) {
    eq(`${label}: code`, error.code, 'INVALID_CONFIG')
  }
}
rejects('plain http to a remote host', 'http://example.test/v1')
rejects('a malformed URL', 'not a url')

if (failures > 0) {
  console.error(`\nFAIL: ${failures} error-classification check(s) failed.`)
  process.exit(1)
}
console.log('\nPASS: provider failures map onto the harness taxonomy.')
