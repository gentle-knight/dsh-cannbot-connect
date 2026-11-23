import { LlmError, isContextWindowExceededError, isQuotaExceededError } from '@deepseek-ai/dsh-llm'

import { PACKAGE } from './constants.js'

// ── error classification ─────────────────────────────────────────────────────

/**
 * Parse a `Retry-After` header in either form the HTTP spec allows.
 *
 * @param value - the header value, in seconds or as an HTTP date.
 * @returns a positive delay in milliseconds capped at one hour, or undefined.
 */
function parseRetryAfter(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 3_600_000)
  const date = Date.parse(value)
  if (Number.isFinite(date)) {
    const delay = date - Date.now()
    if (delay > 0) return Math.min(delay, 3_600_000)
  }
  return undefined
}

/** Read the error text out of a response body, tolerating both shapes. */
function errorTextOf(text) {
  try {
    const json = JSON.parse(text)
    const error = json?.error ?? json
    return String(error?.message ?? error?.code ?? text)
  } catch {
    // An edge/proxy error page is HTML, not JSON. Keep one readable line rather
    // than echoing markup into a diagnostic.
    if (/^\s*</.test(text)) return text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    return text
  }
}

/**
 * Remove credential material from provider-supplied text before it is put in a
 * message a user or a log will read.
 *
 * The gateway is not expected to echo request headers, but the failure text is
 * the one place an endpoint gets to write into our diagnostics, so the exact
 * values we sent are scrubbed by identity rather than by pattern-matching.
 */
function redact(text, secrets) {
  let out = text
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0) out = out.split(secret).join('[redacted]')
  }
  return out
}

/**
 * A provider-reported token count, or undefined when the value is unusable.
 *
 * The harness accepts only non-negative safe integers in `TokenUsage` and drops
 * the whole sample on a null, a string, or a negative count, so the mapping below
 * normalizes before it emits rather than trusting the gateway's JSON types.
 * @param value - one provider-reported count.
 * @returns the count when it is a non-negative safe integer, otherwise undefined.
 */
function safeCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/**
 * Reject an endpoint that would put credentials on the wire in the clear.
 *
 * Both configured endpoints receive the JWT (and the chat endpoint the VK), so
 * a plaintext URL would leak them to anyone on the path. Plain HTTP stays
 * allowed for a loopback address, which is where a local mock or proxy lives.
 */
function assertSecureEndpoint(raw, field) {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new LlmError(`${PACKAGE}: ${field} is not a valid URL`, 'INVALID_CONFIG')
  }
  if (url.protocol === 'https:') return
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol === 'http:' && loopback) return
  throw new LlmError(
    `${PACKAGE}: ${field} must be https (plain http is allowed only for loopback) — it carries the CANNBOT access token`,
    'INVALID_CONFIG',
  )
}

/**
 * Wording the gateway uses when a model sits outside the caller's roster.
 *
 * The endpoint answers both "your token is stale" and "this model is not
 * allowed" with 403, so the status alone cannot pick the failure class. Only a
 * body that ties a refusal to a model is treated as an entitlement problem;
 * every other 403 stays AUTH so a real credential failure is never mistaken for
 * a model-selection mistake.
 */
const MODEL_REFUSAL =
  /\bmodel\b[^.]{0,120}?\b(?:not\s+(?:allowed|found|supported|available|permitted)|unsupported|unavailable|forbidden)\b/i

/**
 * Wording the gateway uses when it cannot read the image a request carries.
 *
 * Measured bodies: `Invalid content type. image_url is only supported by certain
 * models` (text-only model), `The image format is illegal and cannot be opened`
 * (undecodable bytes), and `The image length and width do not meet the model
 * restrictions` (sides of 10px or less). All are request-payload problems, so
 * they classify as unsupported content rather than a generic bad request.
 */
const IMAGE_REFUSAL =
  /\bimages?(?:_url|\s+(?:input|content|format|length|width))\b[^.]{0,120}?\b(?:only\s+supported|not\s+supported|unsupported|illegal|cannot\s+be\s+opened|do\s+not\s+meet)\b/i

/** Map a non-2xx provider response onto the harness failure taxonomy. */
function providerFailure(status, detailText, retryAfterHeader, secrets = []) {
  const detail = redact(detailText, secrets).slice(0, 2000)
  const retryAfterMs = parseRetryAfter(retryAfterHeader)
  const extra = { status, ...(retryAfterMs === undefined ? {} : { providerRetryAfterMs: retryAfterMs }) }

  if (isContextWindowExceededError(detail)) {
    return new LlmError(`${PACKAGE}: the request exceeds the model context window`, 'CONTEXT_WINDOW_EXCEEDED', extra)
  }
  if (isQuotaExceededError(detail)) {
    return new LlmError(`${PACKAGE}: the account quota is exhausted`, 'QUOTA', extra)
  }
  if (status === 400 && IMAGE_REFUSAL.test(detail)) {
    return new LlmError(
      `${PACKAGE}: the gateway rejected this image request (400): ${detail} — check that the routed model accepts image input (see visionModels), that the image is png/jpeg/webp/gif, and that it is larger than 10px per side`,
      'UNSUPPORTED_CONTENT',
      extra,
    )
  }
  // The gateway caps the whole request body (measured between 12MB and 16MB);
  // image bytes are the usual reason to hit it, but a huge text-only request can
  // reach it too.
  if (status === 413) {
    return new LlmError(
      `${PACKAGE}: the gateway refused the request body as too large (413); if the request carries images, lower maxRequestImageBytes or requestImageMaxBytes, otherwise compact the session`,
      'INVALID_REQUEST',
      extra,
    )
  }
  if (status === 403 && MODEL_REFUSAL.test(detail)) {
    return new LlmError(
      `${PACKAGE}: the gateway does not allow this model for the account (403): ${detail}`,
      'MODEL_UNSUPPORTED',
      extra,
    )
  }
  if (status === 401 || status === 403) {
    return new LlmError(
      `${PACKAGE}: the gateway refused the credentials (${status}); sign in with CANNWork so session.json and auth.json are current`,
      'AUTH',
      extra,
    )
  }
  if (status === 429) return new LlmError(`${PACKAGE}: the gateway is rate limiting`, 'RATE_LIMIT', extra)
  if (status >= 500) return new LlmError(`${PACKAGE}: the gateway failed (${status})`, 'SERVER', extra)
  return new LlmError(`${PACKAGE}: the gateway rejected the request (${status}): ${detail}`, 'INVALID_REQUEST', extra)
}

export { assertSecureEndpoint, errorTextOf, parseRetryAfter, providerFailure, redact, safeCount }
