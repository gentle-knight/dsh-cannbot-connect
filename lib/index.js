/**
 * CANNBOT provider for DeepSeek Harness.
 *
 * A **first-class `LlmAdapter`** speaking the gateway's OpenAI-compatible
 * chat-completions wire format directly over `fetch` + SSE, so the plugin
 * carries no third-party runtime dependency at all. The distinctive part is
 * authentication: instead of running its own OAuth flow it reuses the sign-in
 * CANNWork already established for opencode.
 *
 *   - **JWT** — `$XDG_DATA_HOME/opencode/session.json` → `{ accessToken }`,
 *     written and refreshed by that extension (24h lifetime).
 *   - **VK**  — `$XDG_DATA_HOME/opencode/auth.json` → `{ cannbot: { key } }`.
 *
 * Both are read from disk on every request (never cached), so a login, a token
 * refresh, or a VK rotation reaches the very next DSH request with no restart.
 *
 * The gateway validates BOTH credentials on every request:
 *   - VK alone  → 401 `{"message":"Access Token required."}`
 *   - JWT alone → 401 `{"message":"Virtual Key is required."}`
 * so both headers are attached to every call.
 *
 * @module dsh-cannbot-connect
 */

import {
  EMPTY_RESPONSE_CODE,
  LlmAdapter,
  LlmError,
  attributionHeaders,
  assertUsableApiKey,
  isContextWindowExceededError,
  isQuotaExceededError,
  resolveRetryPolicy,
} from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The provider route this plugin owns. */
export const PROVIDER = 'cannbot'

/** Package name used in diagnostics. */
const PACKAGE = 'dsh-cannbot-connect'

/** Gateway base URL (OpenAI-compatible mode). */
const GATEWAY_BASE_URL = 'https://cannbot.hicann.cn/gateway/compatible-mode/v1'

/** Model-list endpoint; returns `builtinModels` + `personalModels`. */
const MODELS_URL = 'https://cannbot.hicann.cn/cannbot/api/models/personal'

/** Bounds one outstanding provider read, not consumer think time. */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

/** Sizing fallbacks for a model the catalog did not describe. */
const DEFAULT_CONTEXT_WINDOW = 1_048_576
const DEFAULT_MAX_TOKENS = 131_072

/**
 * Thinking levels this gateway validates and honours.
 *
 * Measured against `deepseek-v4.1-flash`: `minimal`, `low`, `medium`, `high`,
 * `max` and `xhigh` are accepted and change the reasoning-token budget, while
 * `off` is refused with HTTP 400 `InvalidParameter`. `off` is therefore not
 * offered — a request naming no effort keeps the provider's own default, which
 * is what the seam would send for `off` anyway.
 */
const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'max', 'xhigh']

/** Sentinel marking the end of an SSE stream. */
const STREAM_DONE = Symbol('cannbot.streamDone')

/** Conservative fallback so a failed catalog fetch never hides the route. */
const FALLBACK_CATALOG = [
  {
    id: 'deepseek-v4.1-flash',
    name: 'DeepSeek-V4.1-Flash (CANNBOT)',
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  },
]

// ── plugin configuration ─────────────────────────────────────────────────────

/**
 * Entry configuration. Every field has a working default, so the plugin mounts
 * with no `config` block at all.
 */
export const Config = z.object({
  /** Gateway endpoint serving the OpenAI-compatible surface. */
  baseURL: z.string().default(GATEWAY_BASE_URL),
  /** Endpoint listing the models this account may use. */
  modelsURL: z.string().default(MODELS_URL),
  /** Idle ceiling for one outstanding provider read. */
  streamIdleTimeoutMs: z.number().default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  /** Context window assumed for a model the catalog did not size. */
  defaultContextWindow: z.number().default(DEFAULT_CONTEXT_WINDOW),
  /** Output cap assumed for a model the catalog did not size. */
  defaultMaxTokens: z.number().default(DEFAULT_MAX_TOKENS),
})

// ── credentials (read per request, never cached) ─────────────────────────────

/** opencode's data dir — where CANNWork writes the JWT and VK. */
function opencodeDataDir() {
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'opencode')
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

/** CANNWork's JWT — the `Bearer` the gateway calls the "Access Token". */
export function readJwt() {
  const token = readJson(join(opencodeDataDir(), 'session.json'))?.accessToken
  return typeof token === 'string' && token !== '' ? token : undefined
}

/**
 * The account-level VK from opencode's auth.json.
 *
 * That file is opencode's own secret store, so a missing or unreadable value is
 * a normal state to degrade from, not an error to throw.
 */
export function readAccountVk() {
  const key = readJson(join(opencodeDataDir(), 'auth.json'))?.cannbot?.key
  return typeof key === 'string' && key !== '' ? key : undefined
}

// ── catalog ──────────────────────────────────────────────────────────────────

/**
 * Fetch the models this account may use.
 *
 * The gateway splits them into `builtinModels` (shared) and `personalModels`
 * (this account's roster), and the two lists overlap — a personal model is also
 * listed as builtin. DSH rejects duplicate catalog ids outright, and the
 * personal row is the more specific one, so it wins and builtin rows only fill
 * in what the account does not own.
 */
export async function fetchCatalog({ modelsURL = MODELS_URL, signal } = {}) {
  const jwt = readJwt()
  if (jwt === undefined) return { ok: false, reason: 'auth', catalog: [] }

  const timeout = AbortSignal.timeout(15_000)
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  try {
    const res = await fetch(modelsURL, {
      headers: { Authorization: `Bearer ${jwt}` },
      signal: combined,
    })
    if (!res.ok) {
      const reason = res.status === 401 || res.status === 403 ? 'auth' : 'server'
      return { ok: false, reason, catalog: [] }
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
      })
    }
    return catalog.length === 0
      ? { ok: false, reason: 'server', catalog: [] }
      : { ok: true, catalog }
  } catch {
    return { ok: false, reason: 'network', catalog: [] }
  }
}

// ── request translation ──────────────────────────────────────────────────────

/** Concatenate the text blocks of one message. */
function textOf(content) {
  let text = ''
  for (const block of content) if (block.type === 'text') text += block.text
  return text
}

/**
 * Refuse a payload this route cannot carry.
 *
 * The route advertises text-only input, so the harness normally refuses an
 * attachment before it is ever attached; this is the request-path backstop, and
 * under-claiming costs a clear refusal where over-claiming would send a body the
 * gateway cannot read.
 */
function assertTextOnly(content) {
  for (const block of content) {
    if (block.type === 'image' || block.type === 'file') {
      throw new LlmError(
        `${PACKAGE}: this route is configured for text input only; refusing a ${block.type} block`,
        'UNSUPPORTED_CONTENT',
      )
    }
  }
}

/** Translate harness messages into the OpenAI chat-completions array. */
function toMessages(options) {
  const out = []
  if (options.system !== undefined && options.system !== '') {
    out.push({ role: 'system', content: options.system })
  }
  for (const message of options.messages ?? []) {
    const content = message.content ?? []
    switch (message.role) {
      case 'system':
      case 'developer':
        out.push({ role: 'system', content: textOf(content) })
        break
      case 'user':
        assertTextOnly(content)
        out.push({ role: 'user', content: textOf(content) })
        break
      case 'assistant': {
        assertTextOnly(content)
        const text = textOf(content)
        let reasoning = ''
        const toolCalls = []
        for (const block of content) {
          if (block.type === 'reasoning') reasoning += block.text
          else if (block.type === 'tool-call') {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: { name: block.name, arguments: block.arguments },
            })
          }
        }
        const entry = { role: 'assistant', content: text }
        // The gateway accepts `reasoning_content` back on an assistant turn, so
        // a replayed reasoning prefix survives instead of being silently dropped
        // from the request.
        if (reasoning !== '') entry.reasoning_content = reasoning
        if (toolCalls.length > 0) entry.tool_calls = toolCalls
        out.push(entry)
        break
      }
      case 'tool':
        out.push({
          role: 'tool',
          tool_call_id: message.toolCallId,
          content: textOf(content),
        })
        break
      default:
        break
    }
  }
  return out
}

/** Translate harness tool schemas into OpenAI function definitions. */
function toTools(tools) {
  if (tools === undefined || tools.length === 0) return undefined
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
}

/** Build the streaming request body for one call. */
function toRequestBody(options) {
  const body = {
    model: options.model,
    messages: toMessages(options),
    stream: true,
    stream_options: { include_usage: true },
  }
  const tools = toTools(options.tools)
  if (tools !== undefined) body.tools = tools
  if (options.temperature !== undefined) body.temperature = options.temperature
  if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens
  if (options.stop !== undefined) body.stop = options.stop
  if (options.reasoningEffort !== undefined) body.reasoning_effort = String(options.reasoningEffort)
  return body
}

// ── SSE framing ──────────────────────────────────────────────────────────────

/** Extract the `data:` payload of one SSE frame, or undefined for a comment. */
function frameData(frame) {
  const parts = []
  for (const line of frame.split('\n')) {
    if (!line.startsWith('data:')) continue
    parts.push(line.slice(5).replace(/^ /, ''))
  }
  if (parts.length === 0) return undefined
  const data = parts.join('\n')
  return data === '[DONE]' ? STREAM_DONE : data
}

/**
 * Yield the payload of every SSE frame in one response body.
 *
 * Frames are separated by a blank line and both LF and CRLF are tolerated,
 * since the transport is whatever `fetch` handed back.
 */
async function* sseFrames(body, onRead) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      onRead()
      buffer += decoder.decode(value, { stream: true })
      for (;;) {
        const match = /\r?\n\r?\n/.exec(buffer)
        if (match === null) break
        const frame = buffer.slice(0, match.index)
        buffer = buffer.slice(match.index + match[0].length)
        const data = frameData(frame)
        if (data !== undefined) yield data
      }
    }
    buffer += decoder.decode()
    const data = frameData(buffer)
    if (data !== undefined) yield data
  } finally {
    reader.cancel().catch(() => {})
  }
}

// ── error classification ─────────────────────────────────────────────────────

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

/** Map a non-2xx provider response onto the harness failure taxonomy. */
function providerFailure(status, detailText, retryAfterHeader) {
  const detail = detailText.slice(0, 2000)
  const retryAfterMs = Number(retryAfterHeader) > 0 ? Number(retryAfterHeader) * 1000 : undefined
  const extra = { status, ...(retryAfterMs === undefined ? {} : { providerRetryAfterMs: retryAfterMs }) }

  if (isContextWindowExceededError(detail)) {
    return new LlmError(`${PACKAGE}: the request exceeds the model context window`, 'CONTEXT_WINDOW_EXCEEDED', extra)
  }
  if (isQuotaExceededError(detail)) {
    return new LlmError(`${PACKAGE}: the account quota is exhausted`, 'QUOTA', extra)
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

// ── adapter ──────────────────────────────────────────────────────────────────

/**
 * The CANNBOT route's adapter: one OpenAI-compatible SSE request per call.
 *
 * The catalog is a mutable binding rather than constructor state, because
 * registration must not block on the network — the route mounts immediately
 * with a fallback and swaps to the live roster once a fetch lands.
 */
export class CannbotAdapter extends LlmAdapter {
  #config
  #catalog = FALLBACK_CATALOG
  #retryPolicy

  constructor(config) {
    super()
    this.#config = config
    this.#retryPolicy = resolveRetryPolicy(undefined, `${PACKAGE} retryPolicy`)
  }

  /** Adopt a freshly fetched roster; the next catalog read serves it. */
  adoptCatalog(catalog) {
    this.#catalog = catalog
  }

  /** The roster currently being served. */
  get catalog() {
    return this.#catalog
  }

  providerInfo(provider) {
    return { id: provider, name: 'CANNBOT' }
  }

  providerRetryPolicy() {
    return this.#retryPolicy
  }

  listModels() {
    return Promise.resolve(
      this.#catalog.map((model) => ({
        provider: PROVIDER,
        id: model.id,
        name: model.name,
        inputModalities: ['text'],
      })),
    )
  }

  resolveModel(provider, model) {
    const row = this.#catalog.find((entry) => entry.id === model)
    return Promise.resolve({
      provider,
      id: model,
      name: row?.name ?? model,
      inputModalities: ['text'],
      context: { contextWindow: row?.contextWindow ?? this.#config.defaultContextWindow },
      reasoning: {
        efforts: REASONING_EFFORTS.map((id) => ({
          id,
          name: id.charAt(0).toUpperCase() + id.slice(1),
        })),
      },
    })
  }

  stream(options) {
    return this.#generate(options)
  }

  /** One cancellable request lifecycle. */
  async *#generate(options) {
    const config = this.#config

    const jwt = readJwt()
    const vk = readAccountVk()
    if (jwt === undefined) {
      throw new LlmError(
        `${PACKAGE}: no CANNBOT access token — open CANNWork and sign in so it writes session.json`,
        'AUTH',
      )
    }
    if (vk === undefined) {
      throw new LlmError(
        `${PACKAGE}: no CANNBOT virtual key — open CANNWork and sign in so it writes auth.json`,
        'AUTH',
      )
    }
    // A value no HTTP header can carry is a malformed credential rather than a
    // missing one, and every shipping adapter reports it the same way.
    const bearer = assertUsableApiKey(jwt, PACKAGE, 'session.json accessToken')
    const virtualKey = assertUsableApiKey(vk, PACKAGE, 'auth.json cannbot.key')

    const consumer = new AbortController()
    const signal =
      options.signal === undefined ? consumer.signal : AbortSignal.any([options.signal, consumer.signal])

    let idleTimer
    let idleExpired = false
    const armIdle = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        idleExpired = true
        consumer.abort()
      }, config.streamIdleTimeoutMs)
      idleTimer.unref?.()
    }

    let sawDone = false
    let usage
    let providerFinish
    const blocks = new Map()
    let nextIndex = 0
    let textIndex
    let reasoningIndex
    const toolIndexes = new Map()

    try {
      armIdle()
      let response
      try {
        response = await fetch(`${config.baseURL.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            ...attributionHeaders(),
            'x-api-vkey': virtualKey,
            'api-key': virtualKey,
            Authorization: `Bearer ${bearer}`,
          },
          body: JSON.stringify(toRequestBody(options)),
          signal,
        })
      } catch (error) {
        if (idleExpired) throw new LlmError(`${PACKAGE}: provider read timed out`, 'TIMEOUT', { cause: error })
        if (options.signal?.aborted) throw new LlmError(`${PACKAGE}: request aborted`, 'ABORTED', { cause: error })
        throw new LlmError(`${PACKAGE}: transport failed`, 'TRANSPORT', { cause: error })
      }

      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw providerFailure(response.status, errorTextOf(text), response.headers.get('retry-after'))
      }
      if (response.body === null) {
        throw new LlmError(`${PACKAGE}: the gateway returned no response body`, 'TRANSPORT')
      }

      for await (const frame of sseFrames(response.body, armIdle)) {
        if (frame === STREAM_DONE) {
          sawDone = true
          break
        }
        let event
        try {
          event = JSON.parse(frame)
        } catch {
          continue // a keep-alive or comment the gateway chose to frame as data
        }
        if (event.error !== undefined) {
          throw providerFailure(400, errorTextOf(JSON.stringify(event)), undefined)
        }
        if (event.usage !== undefined && event.usage !== null) usage = event.usage

        const choice = event.choices?.[0]
        if (choice === undefined) continue
        if (typeof choice.finish_reason === 'string') providerFinish = choice.finish_reason

        const delta = choice.delta
        if (delta === undefined) continue

        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
          if (reasoningIndex === undefined) {
            reasoningIndex = nextIndex++
            blocks.set(reasoningIndex, { type: 'reasoning', text: '' })
            yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' }
          }
          blocks.get(reasoningIndex).text += delta.reasoning_content
          yield { type: 'reasoning-delta', index: reasoningIndex, text: delta.reasoning_content }
        }

        if (typeof delta.content === 'string' && delta.content !== '') {
          if (textIndex === undefined) {
            textIndex = nextIndex++
            blocks.set(textIndex, { type: 'text', text: '' })
            yield { type: 'block-start', index: textIndex, blockType: 'text' }
          }
          blocks.get(textIndex).text += delta.content
          yield { type: 'text-delta', index: textIndex, text: delta.content }
        }

        for (const call of delta.tool_calls ?? []) {
          const providerIndex = Number.isInteger(call.index) ? call.index : 0
          let index = toolIndexes.get(providerIndex)
          if (index === undefined) {
            index = nextIndex++
            toolIndexes.set(providerIndex, index)
            blocks.set(index, {
              type: 'tool-call',
              id: call.id ?? `call_${providerIndex}`,
              name: '',
              arguments: '',
            })
            yield { type: 'block-start', index, blockType: 'tool-call' }
          }
          const block = blocks.get(index)
          if (typeof call.id === 'string' && call.id !== '') block.id = call.id
          if (typeof call.function?.name === 'string' && call.function.name !== '') {
            block.name = call.function.name
          }
          const argumentsDelta = typeof call.function?.arguments === 'string' ? call.function.arguments : ''
          block.arguments += argumentsDelta
          yield {
            type: 'tool-call-delta',
            index,
            id: block.id,
            ...(call.function?.name === undefined ? {} : { name: call.function.name }),
            argumentsDelta,
          }
        }
      }
    } catch (error) {
      if (idleExpired) throw new LlmError(`${PACKAGE}: provider read timed out`, 'TIMEOUT', { cause: error })
      if (options.signal?.aborted) throw new LlmError(`${PACKAGE}: request aborted`, 'ABORTED', { cause: error })
      throw error
    } finally {
      clearTimeout(idleTimer)
      consumer.abort()
    }

    if (!sawDone && providerFinish === undefined) {
      throw new LlmError(`${PACKAGE}: the stream ended before the gateway finished the message`, 'STREAM_CLOSED')
    }

    const hasToolCall = [...blocks.values()].some((block) => block.type === 'tool-call')
    const reason =
      providerFinish === 'length'
        ? { kind: 'max-tokens' }
        : providerFinish === 'tool_calls' || providerFinish === 'function_call'
          ? { kind: 'tool-calls' }
          : providerFinish === undefined && hasToolCall
            ? { kind: 'tool-calls' }
            : { kind: 'stop' }

    if (blocks.size === 0 && reason.kind === 'stop') {
      throw new LlmError(`${PACKAGE}: the gateway returned no content`, EMPTY_RESPONSE_CODE)
    }

    for (const [index, block] of [...blocks.entries()].sort((a, b) => a[0] - b[0])) {
      if (block.type === 'tool-call') {
        // A truncated (max-tokens) tool call is expected to be invalid JSON, so
        // only a completion that claimed to finish is held to the contract.
        if (reason.kind !== 'max-tokens') {
          try {
            JSON.parse(block.arguments === '' ? '{}' : block.arguments)
          } catch (error) {
            throw new LlmError(
              `${PACKAGE}: the gateway returned tool arguments that are not valid JSON`,
              'INVALID_TOOL_ARGUMENTS',
              { cause: error },
            )
          }
        }
        yield {
          type: 'block-end',
          index,
          block: { type: 'tool-call', id: block.id, name: block.name, arguments: block.arguments },
        }
      } else {
        yield { type: 'block-end', index, block: { type: block.type, text: block.text } }
      }
    }

    if (usage !== undefined) {
      const promptDetails = usage.prompt_tokens_details ?? {}
      const completionDetails = usage.completion_tokens_details ?? {}
      yield {
        type: 'usage',
        usage: {
          inputTokens: usage.prompt_tokens ?? 0,
          outputTokens: usage.completion_tokens ?? 0,
          totalTokens: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
          ...(promptDetails.cached_tokens === undefined
            ? {}
            : { cacheReadTokens: promptDetails.cached_tokens }),
          ...(completionDetails.reasoning_tokens === undefined
            ? {}
            : { reasoningTokens: completionDetails.reasoning_tokens }),
        },
      }
    }

    yield { type: 'finish', reason }
  }
}

// ── plugin contract ──────────────────────────────────────────────────────────

/** Cordis plugin name, following the `llm-<provider>` convention. */
export const name = 'llm-cannbot'

/** Services this plugin needs before it can register a route. */
export const inject = ['llm']

/**
 * Register the CANNBOT provider route.
 *
 * Registration must not block on the network, so the route mounts immediately
 * with a fallback model and swaps to the live roster once the fetch lands.
 */
export function apply(ctx, config = {}) {
  const resolved = {
    baseURL: config.baseURL ?? GATEWAY_BASE_URL,
    modelsURL: config.modelsURL ?? MODELS_URL,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    defaultMaxTokens: config.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
  }

  const adapter = new CannbotAdapter(resolved)
  const release = ctx.llm.registerAdapter([PROVIDER], adapter)

  let disposed = false
  ctx.effect?.(() => () => {
    disposed = true
  })

  ctx.logger.info(
    `${PACKAGE}: jwt=${readJwt() === undefined ? 'missing' : 'present'} vk=${readAccountVk() === undefined ? 'missing' : 'present'}`,
  )

  fetchCatalog({ modelsURL: resolved.modelsURL })
    .then((result) => {
      if (disposed) return
      if (!result.ok) {
        const why = {
          auth: 'CANNBOT sign-in expired — open CANNWork and sign in again',
          network: 'model endpoint unreachable',
          server: 'model endpoint rejected the request',
        }
        ctx.logger.warn(`${PACKAGE}: catalog unavailable (${why[result.reason] ?? result.reason})`)
        return
      }
      adapter.adoptCatalog(result.catalog)
      ctx.logger.info(`${PACKAGE}: ${result.catalog.length} models available`)
      ctx.emit('llm/adapters-updated')
    })
    .catch((error) => {
      if (!disposed) ctx.logger.warn(`${PACKAGE}: catalog fetch failed`, error)
    })

  return release
}
