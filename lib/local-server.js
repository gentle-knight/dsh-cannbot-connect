#!/usr/bin/env node
/**
 * CANNBOT **local model service** — an OpenAI-compatible HTTP endpoint that
 * proxies to the CANNBOT gateway while reusing the sign-in CANNWork established
 * for opencode.
 *
 * The DSH plugin (`lib/index.js`) is a first-class `LlmAdapter`: it speaks to
 * the gateway in-process, inside DeepSeek Harness. This module is the *other*
 * half of the same idea for editors that are not DSH: it serves the gateway over
 * loopback so VS Code's chat sidebar (Copilot Chat → "Custom Endpoint") — and
 * any other OpenAI-compatible client — can pick CANNBOT models up as if they
 * were a local model server.
 *
 * Design notes:
 *
 *   - **Zero runtime dependencies.** `node:http` + global `fetch` only, so it
 *     runs under a bare Node without the DSH kernel.
 *   - **Credentials are read per request, never cached.** CANNWork refreshes the
 *     JWT on its own schedule; the next request here picks the refresh up with
 *     no restart (same contract as the adapter).
 *   - **OpenAI in, OpenAI out.** Unlike the adapter, this does not translate:
 *     the client already speaks chat-completions, so request bodies are
 *     sanitised and forwarded, and the upstream SSE is passed through byte for
 *     byte. Non-streaming clients are served by aggregating that same stream.
 *   - **Loopback only by default**, and the JWT/VK never leave the process
 *     except towards the configured gateway.
 *
 * Run it directly:
 *
 *     node lib/local-server.js --port 8788
 *
 * @module dsh-cannbot-connect/local-server
 */

import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Provider name shown to clients that care. */
export const PROVIDER = 'cannbot'

/** Gateway base URL (OpenAI-compatible mode). */
export const GATEWAY_BASE_URL = 'https://cannbot.hicann.cn/gateway/compatible-mode/v1'

/** Model-list endpoint; returns `builtinModels` + `personalModels`. */
export const MODELS_URL = 'https://cannbot.hicann.cn/cannbot/api/models/personal'

/** Default loopback port for the local service. */
export const DEFAULT_PORT = 8788

/** Loopback is the only address this service binds unless asked otherwise. */
export const DEFAULT_HOST = '127.0.0.1'

/** Bounds one outstanding upstream read, not consumer think time. */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

/** Sizing fallbacks for a model the catalog did not describe. */
const DEFAULT_CONTEXT_WINDOW = 1_048_576
const DEFAULT_MAX_TOKENS = 131_072

/** Thinking levels this gateway validates and honours (`off` is a 400). */
const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'max', 'xhigh']

/** Refuse oversized request bodies instead of buffering them without bound. */
const MAX_BODY_BYTES = 32 * 1024 * 1024

/** How long a fetched catalog is served before it is refreshed. */
const CATALOG_TTL_MS = 60_000

/** Conservative fallback so a failed catalog fetch never hides the service. */
const FALLBACK_CATALOG = [
  {
    id: 'deepseek-v4.1-flash',
    name: 'DeepSeek-V4.1-Flash (CANNBOT)',
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  },
]

/** Fields forwarded to the gateway. Anything else is dropped on purpose. */
const FORWARDED_FIELDS = [
  'temperature',
  'top_p',
  'max_tokens',
  'stop',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'response_format',
  'presence_penalty',
  'frequency_penalty',
  'seed',
  'reasoning_effort',
]

/** Package version, read once for the `User-Agent` and `/` banner. */
const PACKAGE_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/** Package name used in diagnostics. */
const PACKAGE = 'dsh-cannbot-connect'

// ── errors ───────────────────────────────────────────────────────────────────

/**
 * One failure that is already classified for the OpenAI error envelope.
 *
 * The local service has no harness error taxonomy to lean on: it classifies
 * the gateway's failure itself and reports it with the OpenAI `error` shape so
 * every client can render a message.
 */
class ProxyError extends Error {
  /**
   * @param {number} status HTTP status to answer with.
   * @param {string} code OpenAI-style error code.
   * @param {string} message Human-readable message (already redacted).
   * @param {{ retryAfterMs?: number, type?: string }} [extra]
   */
  constructor(status, code, message, extra = {}) {
    super(message)
    this.name = 'ProxyError'
    this.status = status
    this.code = code
    this.retryAfterMs = extra.retryAfterMs
    this.type = extra.type ?? code
  }
}

// ── credentials (read per request, never cached) ─────────────────────────────

/**
 * The opencode directories that can hold CANNWork's sign-in, in lookup order.
 *
 * This mirrors the adapter's lookup (`lib/index.js`) so the standalone service
 * finds the same credentials as the in-DSH route. CANNWork writes the JWT to
 * opencode's XDG data dir and the VK to its config dir; older layouts kept
 * both in the data dir, so every reader consults both roots.
 */
function opencodeRoots() {
  const home = homedir()
  return [
    join(process.env.XDG_DATA_HOME || join(home, '.local', 'share'), 'opencode'),
    join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode'),
  ]
}

/** Read a JSON file, returning undefined when it is absent or unparseable. */
function readJson(path) {
  try {
    if (!existsSync(path)) return undefined
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return undefined
  }
}

/** Every readable JSON file of that name across the opencode roots. */
function readJsonCopies(name) {
  const copies = []
  for (const root of opencodeRoots()) {
    const value = readJson(join(root, name))
    if (value !== undefined) copies.push(value)
  }
  return copies
}

/** CANNWork's JWT — the `Bearer` the gateway calls the "Access Token". */
export function readJwt() {
  for (const session of readJsonCopies('session.json')) {
    const token = session?.accessToken
    if (typeof token === 'string' && token !== '') return token
  }
  return undefined
}

/**
 * The account-level VK from opencode's auth.json.
 *
 * CANNWork's current `auth` hook stores it as `cannbot.key` under the config
 * dir; older opencode builds kept the same `vk-…` value as the `refresh` field
 * of the `cannbot-cli` oauth entry in the data dir. Only that exact shape is
 * accepted as the fallback, so an unrelated refresh token is never sent as the
 * VK. That file is opencode's own secret store, so a missing or unreadable
 * value is a normal state to degrade from, not an error to throw.
 */
export function readAccountVk() {
  const auths = readJsonCopies('auth.json')
  for (const auth of auths) {
    const key = auth?.cannbot?.key
    if (typeof key === 'string' && key !== '') return key
  }
  for (const auth of auths) {
    const key = auth?.['cannbot-cli']?.refresh
    if (typeof key === 'string' && key.startsWith('vk-')) return key
  }
  return undefined
}

/**
 * Reject a credential that no HTTP header can carry.
 *
 * Printable ASCII without spaces is the exact subset a header value may hold;
 * anything else (a newline, a space) is a malformed value rather than a
 * missing one, and is refused before it can reach the header table.
 */
function assertUsableToken(value, label) {
  if (typeof value !== 'string' || value === '') {
    throw new ProxyError(401, 'AUTH', `${PACKAGE}: ${label} is missing — open CANNWork and sign in`, {
      type: 'authentication_error',
    })
  }
  // eslint-disable-next-line no-control-regex
  if (!/^[\x21-\x7e]+$/.test(value)) {
    throw new ProxyError(401, 'AUTH', `${PACKAGE}: ${label} contains characters a header cannot carry`, {
      type: 'authentication_error',
    })
  }
  return value
}

// ── catalog ──────────────────────────────────────────────────────────────────

/**
 * Fetch the models this account may use.
 *
 * The gateway splits them into `builtinModels` (shared) and `personalModels`
 * (this account's roster) and the lists overlap; the personal row is the more
 * specific one, so it wins and builtin rows only fill in the rest. Clients do
 * not require uniqueness, but a de-duplicated list keeps pickers readable.
 */
export async function fetchCatalog({ modelsURL = MODELS_URL, signal, jwt } = {}) {
  const token = jwt ?? readJwt()
  if (token === undefined) return { ok: false, reason: 'auth', catalog: [] }

  const timeout = AbortSignal.timeout(15_000)
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  try {
    const res = await fetch(modelsURL, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: combined,
      // The request carries the access token: never let a redirect forward it.
      redirect: 'error',
    })
    if (!res.ok) {
      return { ok: false, reason: res.status === 401 || res.status === 403 ? 'auth' : 'server', catalog: [] }
    }
    const json = await res.json()
    const data = json?.data
    if (json?.success !== true || data === undefined) return { ok: false, reason: 'server', catalog: [] }

    const seen = new Set()
    const catalog = []
    for (const row of [...(data.personalModels ?? []), ...(data.builtinModels ?? [])]) {
      if (typeof row?.model !== 'string' || row.model === '' || seen.has(row.model)) continue
      seen.add(row.model)
      catalog.push({
        id: row.model,
        name: row.title ?? row.model,
        contextWindow: Number.isFinite(row.contextLength) ? row.contextLength : DEFAULT_CONTEXT_WINDOW,
        maxTokens: Number.isFinite(row?.completionOptions?.maxTokens)
          ? row.completionOptions.maxTokens
          : DEFAULT_MAX_TOKENS,
        // Each roster row carries the VK the gateway expects for that model,
        // and a builtin row's key is not the account-level one. Keep it so the
        // request path can prefer the row's own credential; rows without a key
        // fall back to CANNWork's account VK. Never expose it to clients.
        ...(typeof row.apiKey === 'string' && row.apiKey !== '' ? { vk: row.apiKey } : {}),
      })
    }
    return catalog.length === 0
      ? { ok: false, reason: 'server', catalog: [] }
      : { ok: true, catalog }
  } catch {
    return { ok: false, reason: 'network', catalog: [] }
  }
}

// ── request sanitising ───────────────────────────────────────────────────────

/** Refuse an endpoint that would put credentials on the wire in the clear. */
export function assertSecureEndpoint(raw, field) {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new ProxyError(400, 'INVALID_REQUEST', `${PACKAGE}: ${field} is not a valid URL`)
  }
  if (url.protocol === 'https:') return url
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol === 'http:' && loopback) return url
  throw new ProxyError(
    400,
    'INVALID_REQUEST',
    `${PACKAGE}: ${field} must be https (plain http is allowed only for loopback) — it carries the CANNBOT access token`,
  )
}

/** Flatten one message's `content` into the text the gateway accepts. */
function contentToText(content) {
  if (typeof content === 'string') return content
  if (content === null || content === undefined) return ''
  // One part object is legal in some client SDKs and must not be stringified
  // into "[object Object]".
  if (!Array.isArray(content)) return Array.isArray(content) ? '' : contentToText([content])
  let text = ''
  for (const part of content) {
    if (typeof part === 'string') {
      text += part
      continue
    }
    const type = part?.type
    if (type === 'text' || type === 'input_text' || type === 'output_text') {
      text += typeof part.text === 'string' ? part.text : ''
      continue
    }
    if (type === 'image_url' || type === 'input_image' || type === 'image') {
      // The route declares text-only input: refuse loudly instead of sending a
      // body the gateway cannot read.
      throw new ProxyError(
        400,
        'UNSUPPORTED_CONTENT',
        `${PACKAGE}: this route is configured for text input only; refusing an image part`,
      )
    }
    // Unknown parts are ignored rather than failing an otherwise usable turn.
  }
  return text
}

/** Normalise a message array, keeping tool calls and tool results intact. */
function toMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ProxyError(400, 'INVALID_REQUEST', `${PACKAGE}: "messages" must be a non-empty array`)
  }
  const out = []
  for (const message of messages) {
    if (message === null || typeof message !== 'object') {
      throw new ProxyError(400, 'INVALID_REQUEST', `${PACKAGE}: every message must be an object`)
    }
    const role = message.role
    if (role === 'tool') {
      const toolCallId = message.tool_call_id ?? message.toolCallId
      if (typeof toolCallId !== 'string' || toolCallId === '') {
        throw new ProxyError(
          400,
          'INVALID_REQUEST',
          `${PACKAGE}: a tool message is missing its tool_call_id`,
        )
      }
      out.push({ role: 'tool', tool_call_id: toolCallId, content: contentToText(message.content) })
      continue
    }
    if (role === 'assistant') {
      const entry = { role: 'assistant', content: contentToText(message.content) }
      if (typeof message.reasoning_content === 'string' && message.reasoning_content !== '') {
        entry.reasoning_content = message.reasoning_content
      }
      if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        entry.tool_calls = message.tool_calls.map((call, index) => ({
          id: call?.id ?? `call_${index}`,
          type: 'function',
          function: {
            name: call?.function?.name ?? '',
            arguments:
              typeof call?.function?.arguments === 'string'
                ? call.function.arguments
                : JSON.stringify(call?.function?.arguments ?? {}),
          },
        }))
      }
      out.push(entry)
      continue
    }
    if (role !== 'system' && role !== 'developer' && role !== 'user') {
      throw new ProxyError(400, 'INVALID_REQUEST', `${PACKAGE}: unsupported message role "${String(role)}"`)
    }
    out.push({ role: role === 'developer' ? 'system' : role, content: contentToText(message.content) })
  }
  return out
}

/** Keep a model id the gateway may understand; strip client-side namespacing. */
function normaliseModelId(model) {
  if (typeof model !== 'string' || model.trim() === '') {
    throw new ProxyError(400, 'INVALID_REQUEST', `${PACKAGE}: "model" must be a non-empty string`)
  }
  let id = model.trim()
  if (id.startsWith(`${PROVIDER}/`)) id = id.slice(PROVIDER.length + 1)
  return id
}

/**
 * Build the body actually sent upstream.
 *
 * The client speaks the same protocol as the gateway, so this is mostly a
 * whitelist: a field the gateway does not know is a 400 `InvalidParameter`, and
 * a client is free to send plenty of those (`store`, `metadata`,
 * `prompt_cache_key`, …). `max_completion_tokens` is renamed because that is
 * the spelling the gateway accepts, and an unsupported reasoning effort is
 * dropped (the gateway 400s on `off`, so "no opinion" is the safe default).
 */
function toGatewayBody(body, { model, stream }) {
  if (body.n !== undefined && body.n !== null && body.n !== 1) {
    throw new ProxyError(400, 'INVALID_REQUEST', `${PACKAGE}: only n=1 is supported (the gateway returns one choice)`)
  }
  const out = { model, messages: toMessages(body.messages), stream }
  for (const field of FORWARDED_FIELDS) {
    if (body[field] === undefined || body[field] === null) continue
    out[field] = body[field]
  }
  if (out.max_tokens === undefined && Number.isFinite(body.max_completion_tokens)) {
    out.max_tokens = body.max_completion_tokens
  }
  if (out.reasoning_effort !== undefined) {
    const effort = String(out.reasoning_effort)
    if (REASONING_EFFORTS.includes(effort)) out.reasoning_effort = effort
    else delete out.reasoning_effort
  }
  if (stream) out.stream_options = { include_usage: true }
  return out
}

// ── SSE plumbing ─────────────────────────────────────────────────────────────

/** Extract the `data:` payload of one SSE frame, or undefined for a comment. */
function frameData(frame) {
  const parts = []
  for (const line of frame.split('\n')) {
    if (!line.startsWith('data:')) continue
    parts.push(line.slice(5).replace(/^ /, ''))
  }
  if (parts.length === 0) return undefined
  return parts.join('\n')
}

// ── upstream failure classification ─────────────────────────────────────────

/** Read the error text out of a response body, tolerating both shapes. */
function errorTextOf(text) {
  try {
    const json = JSON.parse(text)
    const error = json?.error ?? json
    return String(error?.message ?? error?.code ?? text)
  } catch {
    return text
  }
}

/** Replace the exact credential values we sent with `[redacted]`. */
function redact(text, secrets) {
  let out = text
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0) out = out.split(secret).join('[redacted]')
  }
  return out
}

/**
 * Wording the gateway uses when it refuses a model for this account.
 *
 * It answers 403 for both this and a dead sign-in, so the body is the only
 * signal that separates "this model is not in your roster" from "sign in
 * again". Mirrors the adapter's `MODEL_REFUSAL` so both routes agree.
 */
const MODEL_REFUSAL =
  /\bmodel\b[^.]{0,120}?\b(?:not\s+(?:allowed|found|supported|available|permitted)|unsupported|unavailable|forbidden)\b/i

/** Classify a non-2xx gateway response into a `ProxyError`. */
function providerFailure(status, detailText, retryAfterHeader, secrets = []) {
  const detail = redact(errorTextOf(detailText), secrets).slice(0, 2000)
  const retryAfterMs = Number(retryAfterHeader) > 0 ? Number(retryAfterHeader) * 1000 : undefined
  const extra = retryAfterMs === undefined ? {} : { retryAfterMs }

  if (/context|too many tokens|maximum context/i.test(detail)) {
    return new ProxyError(400, 'context_length_exceeded', `${PACKAGE}: the request exceeds the model context window`, extra)
  }
  if (/quota|insufficient/i.test(detail)) {
    return new ProxyError(429, 'QUOTA', `${PACKAGE}: the account quota is exhausted`, extra)
  }
  // The gateway answers a model this account may not use with 403
  // `{"message":"Model x not allowed"}` — that is a request problem, not an
  // expired sign-in, and telling an editor user to "sign in again" for a stale
  // model id would send them debugging the wrong thing.
  if ((status === 400 || status === 403) && MODEL_REFUSAL.test(detail)) {
    return new ProxyError(
      400,
      'MODEL_UNSUPPORTED',
      `${PACKAGE}: the gateway does not allow this model for the account (${detail})`,
      { type: 'invalid_request_error' },
    )
  }
  if (status === 401 || status === 403) {
    return new ProxyError(
      401,
      'AUTH',
      `${PACKAGE}: the gateway refused the credentials (${status}); sign in with CANNWork so session.json and auth.json are current`,
      { ...extra, type: 'authentication_error' },
    )
  }
  if (status === 429) {
    return new ProxyError(429, 'RATE_LIMIT', `${PACKAGE}: the gateway is rate limiting`, {
      ...extra,
      type: 'rate_limit_error',
    })
  }
  if (status >= 500) return new ProxyError(502, 'SERVER', `${PACKAGE}: the gateway failed (${status})`)
  return new ProxyError(status, 'INVALID_REQUEST', `${PACKAGE}: the gateway rejected the request (${status}): ${detail}`)
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

/*
 * Deliberately no CORS headers anywhere in this file.
 *
 * The endpoint attaches the account's CANNBOT credentials to whatever it is
 * asked, so a browser page on any origin must not be able to call it and read
 * the answer. Editors (VS Code's extension host, Cline, Continue, opencode) call
 * it from Node and never perform a CORS preflight; a browser preflight gets no
 * `Access-Control-Allow-Origin` and the request is blocked.
 */

/** Send one JSON response and finish it. */
function sendJson(res, status, payload, headers = {}) {
  const text = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    ...headers,
  })
  res.end(text)
}

/** Send one OpenAI-shaped error response. */
function sendError(res, error) {
  if (res.headersSent || res.destroyed) {
    if (!res.destroyed) res.end()
    return
  }
  const headers = {}
  if (Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0) {
    headers['Retry-After'] = String(Math.ceil(error.retryAfterMs / 1000))
  }
  sendJson(
    res,
    error.status ?? 500,
    { error: { message: error.message, type: error.type ?? 'server_error', code: error.code ?? 'INTERNAL' } },
    headers,
  )
}

/** Write to a client that may already be gone; never throw on a dead socket. */
function safeWrite(res, chunk) {
  if (res.writableEnded || res.destroyed) return false
  try {
    res.write(chunk)
    return true
  } catch {
    return false
  }
}

/** Read a whole JSON request body, refusing oversized or malformed input. */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      throw new ProxyError(413, 'INVALID_REQUEST', `${PACKAGE}: request body is too large`, {
        type: 'invalid_request_error',
      })
    }
    chunks.push(chunk)
  }
  if (chunks.length === 0) {
    throw new ProxyError(400, 'INVALID_REQUEST', `${PACKAGE}: request body is empty`, {
      type: 'invalid_request_error',
    })
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    return value
  } catch {
    throw new ProxyError(400, 'INVALID_REQUEST', `${PACKAGE}: request body is not a JSON object`, {
      type: 'invalid_request_error',
    })
  }
}

/** Resolve the model id a client asked for against the live catalog. */
function resolveModelId(requested, catalog) {
  const id = normaliseModelId(requested)
  if (!Array.isArray(catalog) || catalog.length === 0) return id
  const byId = catalog.find((model) => model.id === id)
  if (byId !== undefined) return byId.id
  const lower = id.toLowerCase()
  const byLooseId = catalog.find((model) => model.id.toLowerCase() === lower)
  if (byLooseId !== undefined) return byLooseId.id
  // A client configured with the display name works too (`name` in
  // `chatLanguageModels.json` is tempting to use as an id).
  const byName = catalog.find((model) => model.name.toLowerCase() === lower)
  if (byName !== undefined) return byName.id
  return id
}

// ── streaming / non-streaming turn ──────────────────────────────────────────

/**
 * Aggregate an upstream chat-completions SSE stream into one JSON response.
 *
 * Used for `stream: false` clients. Reusing the streaming path (instead of
 * asking the gateway for a buffered response) keeps exactly one wire code path
 * against the gateway, and therefore one thing to keep working.
 */
async function aggregateCompletion(body, { idleTimeoutMs, requestedModel, secrets = [] }) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let idleTimer
  let idleExpired = false
  let sawDone = false

  const armIdle = () => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleExpired = true
      reader.cancel().catch(() => {})
    }, idleTimeoutMs)
    idleTimer.unref?.()
  }

  const content = []
  const reasoning = []
  const toolCalls = new Map()
  let usage
  let id
  let created
  let model
  let providerFinish
  let sawError

  /** Absorb one SSE `data:` payload. */
  const consume = (data) => {
    if (data === '[DONE]') {
      sawDone = true
      return
    }
    let event
    try {
      event = JSON.parse(data)
    } catch {
      return
    }
    if (event.error !== undefined) {
      sawError = errorTextOf(JSON.stringify(event))
      return
    }
    id ??= event.id
    created ??= event.created
    model ??= event.model
    if (event.usage !== undefined && event.usage !== null) usage = event.usage
    const choice = event.choices?.[0]
    if (choice === undefined) return
    if (typeof choice.finish_reason === 'string') providerFinish = choice.finish_reason
    const delta = choice.delta
    if (delta === undefined) return
    if (typeof delta.content === 'string' && delta.content !== '') content.push(delta.content)
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
      reasoning.push(delta.reasoning_content)
    }
    for (const call of delta.tool_calls ?? []) {
      const index = Number.isInteger(call.index) ? call.index : 0
      const existing = toolCalls.get(index) ?? { id: undefined, name: '', arguments: '' }
      if (typeof call.id === 'string' && call.id !== '') existing.id = call.id
      if (typeof call.function?.name === 'string' && call.function.name !== '') existing.name = call.function.name
      if (typeof call.function?.arguments === 'string') existing.arguments += call.function.arguments
      toolCalls.set(index, existing)
    }
  }

  /** Consume every complete frame currently in the buffer. */
  const drainFrames = () => {
    for (;;) {
      const match = /\r?\n\r?\n/.exec(buffer)
      if (match === null) break
      const frame = buffer.slice(0, match.index)
      buffer = buffer.slice(match.index + match[0].length)
      const data = frameData(frame)
      if (data !== undefined) consume(data)
    }
  }

  try {
    armIdle()
    for (;;) {
      let read
      try {
        read = await reader.read()
      } catch {
        if (idleExpired) {
          throw new ProxyError(504, 'TIMEOUT', `${PACKAGE}: the gateway stopped sending data`, {
            type: 'timeout_error',
          })
        }
        throw new ProxyError(502, 'TRANSPORT', `${PACKAGE}: the gateway stream failed`, { type: 'server_error' })
      }
      if (read.done) break
      armIdle()
      buffer += decoder.decode(read.value, { stream: true })
      drainFrames()
    }
    // A gateway may close without the final blank line: flush the decoder and
    // consume whatever the last frame was instead of dropping it.
    buffer += decoder.decode()
    drainFrames()
    const residue = frameData(buffer)
    if (residue !== undefined) consume(residue)
  } finally {
    clearTimeout(idleTimer)
  }

  if (idleExpired) {
    throw new ProxyError(504, 'TIMEOUT', `${PACKAGE}: the gateway stopped sending data`, { type: 'timeout_error' })
  }
  if (sawError !== undefined) {
    // An error frame is still provider-supplied text: redact it like any other.
    throw providerFailure(400, sawError, undefined, secrets)
  }
  // An upstream that dies without a `finish_reason` and without `[DONE]` is a
  // truncated answer, not a short one: reporting it as `stop` would hand a
  // client half a reply it believes is complete.
  if (!sawDone && providerFinish === undefined) {
    throw new ProxyError(502, 'STREAM_CLOSED', `${PACKAGE}: the gateway closed the stream early`, {
      type: 'server_error',
    })
  }

  const message = { role: 'assistant', content: content.join('') }
  if (reasoning.length > 0) message.reasoning_content = reasoning.join('')
  if (toolCalls.size > 0) {
    message.tool_calls = [...toolCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, call]) => ({
        id: call.id ?? `call_${index}`,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      }))
  }
  // Pass the provider's verdict through; only infer one when it sent none. A
  // tool call does not override an explicit `stop`, and `content_filter` must
  // stay visible rather than masquerade as a normal finish.
  const finishReason =
    providerFinish === 'function_call'
      ? 'tool_calls'
      : providerFinish !== undefined
        ? providerFinish
        : toolCalls.size > 0
          ? 'tool_calls'
          : 'stop'
  const payload = {
    id: id ?? `chatcmpl-${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: created ?? Math.floor(Date.now() / 1000),
    model: model ?? requestedModel ?? '',
    choices: [{ index: 0, message, finish_reason: finishReason }],
  }
  if (usage !== undefined) payload.usage = usage
  return payload
}

/**
 * Proxy one chat-completions turn.
 *
 * Upstream is always requested as a stream; streaming clients receive those
 * bytes verbatim (the gateway already speaks the protocol the client asked for)
 * while non-streaming clients get the aggregated JSON above.
 */
async function proxyCompletion({ body, state, res }) {
  const catalog = await state.getCatalog()
  const model = resolveModelId(body.model, catalog)
  const wantsStream = body.stream === true
  const upstreamBody = toGatewayBody(body, { model, stream: true })

  const modelRow = catalog.find((entry) => entry.id === model)
  const jwt = assertUsableToken(state.options.credentials?.jwt ?? readJwt(), 'no CANNBOT access token')
  // Prefer the catalog row's own VK (builtin models issue a different key from
  // the account-level one); fall back to CANNWork's account VK when the row has
  // none or the catalog is still the fallback roster.
  const vk = assertUsableToken(
    modelRow?.vk ?? state.options.credentials?.vk ?? readAccountVk(),
    'no CANNBOT virtual key',
  )

  const controller = new AbortController()
  let clientClosed = false
  // A client that hangs up must not leave an upstream read running.
  res.on('close', () => {
    clientClosed = true
    controller.abort()
  })

  let response
  try {
    response = await fetch(`${state.options.baseURL.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'User-Agent': `${PACKAGE}/${PACKAGE_VERSION} (local-model-service)`,
        'x-api-vkey': vk,
        'api-key': vk,
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify(upstreamBody),
      signal: controller.signal,
      // This request carries both credentials: never let a redirect hand them
      // to another origin.
      redirect: 'error',
    })
  } catch (error) {
    if (clientClosed) return
    throw new ProxyError(502, 'TRANSPORT', `${PACKAGE}: cannot reach the gateway (${error.message})`, {
      type: 'api_connection_error',
    })
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw providerFailure(response.status, text, response.headers.get('retry-after'), [jwt, vk])
  }
  if (response.body === null) {
    throw new ProxyError(502, 'SERVER', `${PACKAGE}: the gateway returned no response body`)
  }

  if (!wantsStream) {
    const payload = await aggregateCompletion(response.body, {
      idleTimeoutMs: state.options.streamIdleTimeoutMs,
      requestedModel: model,
      secrets: [jwt, vk],
    })
    if (!clientClosed && !res.writableEnded) sendJson(res, 200, payload)
    return
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Defeat buffering proxies on the loopback hop (VS Code itself is a direct
    // consumer, but people also put this behind a local gateway).
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders?.()

  let idleTimer
  let idleExpired = false
  const armIdle = () => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleExpired = true
      controller.abort()
    }, state.options.streamIdleTimeoutMs)
    idleTimer.unref?.()
  }

  const decoder = new TextDecoder()
  let tail = ''
  let sawDone = false
  /**
   * Forward one upstream chunk.
   *
   * Decoding (rather than writing the raw bytes) buys exactly one thing: a
   * credential the gateway might echo inside an error frame is redacted before
   * it reaches the client. Everything else stays byte-for-byte equivalent, and
   * `stream: true` keeps a multi-byte character split across chunks intact.
   */
  const forward = (chunk) => {
    const text = redact(decoder.decode(chunk, { stream: true }), [jwt, vk])
    if (text === '') return
    safeWrite(res, text)
    tail = (tail + text).slice(-64)
    if (tail.includes('[DONE]')) sawDone = true
  }
  try {
    armIdle()
    for await (const chunk of response.body) {
      if (clientClosed || res.writableEnded) break
      armIdle()
      forward(chunk)
    }
    const residual = redact(decoder.decode(), [jwt, vk])
    if (residual !== '') {
      safeWrite(res, residual)
      tail = (tail + residual).slice(-64)
      if (tail.includes('[DONE]')) sawDone = true
    }
  } catch (error) {
    if (!clientClosed && !idleExpired) {
      // Headers are already out; the only sane signal left is an SSE error
      // frame followed by the terminator, so the client fails loudly instead of
      // treating a truncated answer as complete.
      const message = redact(String(error?.message ?? 'transport failed'), [jwt, vk])
      safeWrite(res, `\ndata: ${JSON.stringify({ error: { message, type: 'api_connection_error' } })}\n\n`)
    }
  } finally {
    clearTimeout(idleTimer)
    if (!res.writableEnded) {
      if (idleExpired) {
        safeWrite(
          res,
          `\ndata: ${JSON.stringify({ error: { message: `${PACKAGE}: the gateway stopped sending data`, type: 'timeout_error' } })}\n\n`,
        )
      }
      // A leading newline keeps the terminator a frame of its own even when the
      // upstream ended mid-frame (a gateway that closes before `[DONE]`).
      if (!sawDone) safeWrite(res, '\ndata: [DONE]\n\n')
      if (!res.writableEnded) res.end()
    }
  }
}

// ── request routing ──────────────────────────────────────────────────────────

/** Constant-time-ish comparison for the optional local client key. */
function sameKey(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * Enforce the optional local client key.
 *
 * Three spellings are accepted because the clients differ: OpenAI SDKs send
 * `Authorization: Bearer`, Azure-style clients send `api-key`, and an editor
 * whose provider cannot hold a secret (VS Code's `chatLanguageModels.json`)
 * can be given a custom header instead.
 */
function authorizeClient(req, options) {
  if (typeof options.apiKey !== 'string' || options.apiKey === '') return
  const header = req.headers.authorization
  const bearer = typeof header === 'string' && header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : ''
  const apiKeyHeader = typeof req.headers['api-key'] === 'string' ? req.headers['api-key'] : ''
  const customHeader = typeof req.headers['x-cannbot-key'] === 'string' ? req.headers['x-cannbot-key'] : ''
  if (sameKey(bearer, options.apiKey) || sameKey(apiKeyHeader, options.apiKey) || sameKey(customHeader, options.apiKey)) {
    return
  }
  throw new ProxyError(401, 'INVALID_API_KEY', `${PACKAGE}: a local API key is required`, {
    type: 'authentication_error',
  })
}

/** The model list in the OpenAI `GET /v1/models` shape. */
function modelsPayload(catalog) {
  return {
    object: 'list',
    data: catalog.map((model) => ({
      id: model.id,
      object: 'model',
      created: 0,
      owned_by: PROVIDER,
      name: model.name,
      context_window: model.contextWindow,
      max_tokens: model.maxTokens,
      input_modalities: ['text'],
    })),
  }
}

/** One HTTP request. */
async function handleRequest(req, res, state) {
  const method = req.method ?? 'GET'
  let pathname
  try {
    pathname = new URL(req.url ?? '/', 'http://localhost').pathname
  } catch {
    throw new ProxyError(400, 'INVALID_REQUEST', `${PACKAGE}: malformed request URL`)
  }

  if (method === 'OPTIONS') {
    // Not a CORS preflight answer: no `Access-Control-Allow-Origin` is sent, by
    // design (see the note above). `Allow` is for non-browser clients that probe
    // it.
    res.writeHead(204, { Allow: 'GET, POST, OPTIONS' })
    res.end()
    return
  }

  if (method === 'GET' && (pathname === '/' || pathname === '/health' || pathname === '/healthz')) {
    const catalog = await state.getCatalog()
    sendJson(res, 200, {
      name: PACKAGE,
      version: PACKAGE_VERSION,
      description: 'CANNBOT gateway exposed as a local OpenAI-compatible model service',
      models: catalog.map((model) => model.id),
      jwt: (state.options.credentials?.jwt ?? readJwt()) === undefined ? 'missing' : 'present',
      // A per-model row VK is enough to serve that model even when no
      // account-level VK is readable.
      vk:
        (state.options.credentials?.vk ?? readAccountVk()) !== undefined ||
        catalog.some((model) => model.vk !== undefined)
          ? 'present'
          : 'missing',
      endpoints: ['GET /v1/models', 'POST /v1/chat/completions'],
    })
    return
  }

  if (method === 'GET' && (pathname === '/v1/models' || pathname === '/models')) {
    authorizeClient(req, state.options)
    const catalog = await state.getCatalog()
    sendJson(res, 200, modelsPayload(catalog))
    return
  }

  if (method === 'POST' && (pathname === '/v1/chat/completions' || pathname === '/chat/completions')) {
    authorizeClient(req, state.options)
    const body = await readJsonBody(req)
    await proxyCompletion({ body, state, res })
    return
  }

  // A few tools probe `/v1` for a health signal before listing models.
  if (method === 'GET' && (pathname === '/v1' || pathname === '/v1/')) {
    sendJson(res, 200, { object: 'list', data: [] })
    return
  }

  throw new ProxyError(404, 'NOT_FOUND', `${PACKAGE}: no route for ${method} ${pathname}`)
}

// ── options ──────────────────────────────────────────────────────────────────

/** Normalise user options, tolerating both the CLI and the DSH config shape. */
function resolveOptions(options = {}) {
  const port = Number(options.port ?? process.env.CANNBOT_PORT ?? DEFAULT_PORT)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ProxyError(400, 'INVALID_REQUEST', `${PACKAGE}: invalid port ${String(options.port)}`)
  }
  const host = String(options.host ?? process.env.CANNBOT_HOST ?? DEFAULT_HOST)
  const allowNonLoopback = Boolean(options.allowNonLoopback ?? process.env.CANNBOT_ALLOW_NON_LOOPBACK === '1')
  const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost' || host === '0:0:0:0:0:0:0:1'
  if (!loopback && !allowNonLoopback) {
    throw new ProxyError(
      400,
      'INVALID_REQUEST',
      `${PACKAGE}: refusing to bind ${host} — this service injects credentials, so it is loopback-only by default (pass --allow-non-loopback to override)`,
    )
  }
  const baseURL = String(options.baseURL ?? options.baseUrl ?? process.env.CANNBOT_GATEWAY_URL ?? GATEWAY_BASE_URL)
  const modelsURL = String(options.modelsURL ?? options.modelsUrl ?? process.env.CANNBOT_MODELS_API_URL ?? MODELS_URL)
  assertSecureEndpoint(baseURL, 'baseURL')
  assertSecureEndpoint(modelsURL, 'modelsURL')
  const requestedIdle = Number(
    options.streamIdleTimeoutMs ?? process.env.CANNBOT_STREAM_IDLE_TIMEOUT_MS ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  )
  if (!Number.isFinite(requestedIdle) || requestedIdle <= 0) {
    throw new ProxyError(400, 'INVALID_REQUEST', `${PACKAGE}: streamIdleTimeoutMs must be a positive number`)
  }
  return {
    port,
    host,
    baseURL,
    modelsURL,
    apiKey: String(options.apiKey ?? process.env.CANNBOT_LOCAL_KEY ?? ''),
    streamIdleTimeoutMs: requestedIdle,
    // Test/CI escape hatch: supply credentials instead of reading CANNWork's
    // files. Never populated from configuration files, only from the caller.
    credentials:
      options.credentials ??
      (process.env.CANNBOT_ACCESS_TOKEN === undefined && process.env.CANNBOT_VK === undefined
        ? undefined
        : { jwt: process.env.CANNBOT_ACCESS_TOKEN, vk: process.env.CANNBOT_VK }),
    quiet: Boolean(options.quiet),
  }
}

// ── server lifecycle ─────────────────────────────────────────────────────────

/**
 * Start the local model service.
 *
 * @param {{
 *   port?: number, host?: string, baseURL?: string, modelsURL?: string,
 *   apiKey?: string, streamIdleTimeoutMs?: number,
 *   allowNonLoopback?: boolean, quiet?: boolean,
 *   credentials?: { jwt?: string, vk?: string },
 *   log?: (line: string) => void,
 * }} [options]
 * @returns {Promise<{ url: string, port: number, host: string, close: () => Promise<void> }>}
 */
export async function startLocalServer(options = {}) {
  const resolved = resolveOptions(options)
  const log = options.log ?? ((line) => console.error(line))
  let cached = { at: 0, value: null }

  const state = {
    options: resolved,
    async getCatalog() {
      const now = Date.now()
      if (cached.value !== null && now - cached.at < CATALOG_TTL_MS) return cached.value
      const result = await fetchCatalog({ modelsURL: resolved.modelsURL, jwt: resolved.credentials?.jwt })
      const catalog = result.ok ? result.catalog : FALLBACK_CATALOG
      cached = { at: now, value: catalog }
      if (!result.ok && !resolved.quiet) {
        const why = {
          auth: 'CANNBOT sign-in missing or expired — open CANNWork and sign in again',
          network: 'model endpoint unreachable',
          server: 'model endpoint rejected the request',
        }
        log(`${PACKAGE}: catalog unavailable (${why[result.reason] ?? result.reason}); serving the fallback model`)
      }
      return catalog
    },
  }

  const server = createServer((req, res) => {
    handleRequest(req, res, state).catch((error) => {
      const failure = error instanceof ProxyError ? error : new ProxyError(500, 'INTERNAL', `${PACKAGE}: ${error?.message ?? error}`)
      if (!(error instanceof ProxyError) && !resolved.quiet) log(`${PACKAGE}: internal error: ${error?.stack ?? error}`)
      sendError(res, failure)
    })
  })
  server.keepAliveTimeout = 72_000
  server.headersTimeout = 75_000

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening)
      reject(new ProxyError(409, 'EADDRINUSE', `${PACKAGE}: cannot listen on ${resolved.host}:${resolved.port}: ${error.message}`))
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(resolved.port, resolved.host)
  })

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : resolved.port
  const host = resolved.host === 'localhost' ? '127.0.0.1' : resolved.host
  const url = `http://${host.includes(':') ? `[${host}]` : host}:${port}`

  if (!resolved.quiet) {
    log(`${PACKAGE}: local model service listening on ${url}`)
    log(`${PACKAGE}: OpenAI base URL for clients: ${url}/v1`)
    if (resolved.apiKey === '') {
      log(`${PACKAGE}: no --key set — any local process may use this endpoint (loopback only)`)
    }
  }

  return {
    url,
    port,
    host,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      }),
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

/** Parse `--flag value` / `--flag=value` arguments. */
function parseArgs(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const eq = arg.indexOf('=')
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1)
      continue
    }
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      flags[key] = 'true'
      continue
    }
    flags[key] = next
    i += 1
  }
  return flags
}

const HELP = `CANNBOT local model service (OpenAI-compatible)

Usage: node lib/local-server.js [options]

Options:
  --port <n>                 loopback port to listen on (default ${DEFAULT_PORT})
  --host <addr>              bind address (default ${DEFAULT_HOST}; loopback only)
  --key <token>              require this bearer token from local clients
  --base-url <url>           CANNBOT gateway base URL (default ${GATEWAY_BASE_URL})
  --models-url <url>         model catalog endpoint (default ${MODELS_URL})
  --idle-timeout-ms <n>      abort a silent upstream read after this long (default ${DEFAULT_STREAM_IDLE_TIMEOUT_MS})
  --allow-non-loopback       allow binding a non-loopback address (not recommended)
  --quiet                    suppress non-error logging
  --help                     show this help

Environment: CANNBOT_PORT, CANNBOT_HOST, CANNBOT_LOCAL_KEY,
CANNBOT_GATEWAY_URL, CANNBOT_MODELS_API_URL, CANNBOT_STREAM_IDLE_TIMEOUT_MS.

Endpoints:
  GET  /v1/models            model list for this CANNBOT account
  POST /v1/chat/completions  chat completions (streaming and non-streaming)
  GET  /healthz              readiness + credential presence
`

/** Run the service from the command line. */
async function main() {
  const flags = parseArgs(process.argv.slice(2))
  if (flags.help !== undefined) {
    process.stdout.write(HELP)
    return
  }
  const handle = await startLocalServer({
    port: flags.port === undefined ? undefined : Number(flags.port),
    host: flags.host,
    apiKey: flags.key,
    baseURL: flags['base-url'],
    modelsURL: flags['models-url'],
    streamIdleTimeoutMs: flags['idle-timeout-ms'] === undefined ? undefined : Number(flags['idle-timeout-ms']),
    allowNonLoopback: flags['allow-non-loopback'] !== undefined,
    quiet: flags.quiet !== undefined,
    log: (line) => process.stderr.write(`${line}\n`),
  })
  const shutdown = () => {
    handle.close().finally(() => process.exit(0))
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error?.message ?? error}\n`)
    process.exit(1)
  })
}
