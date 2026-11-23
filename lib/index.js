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
  IMAGE_OFFLOAD_REQUIRED_CODE,
  LlmAdapter,
  LlmError,
  attributionHeaders,
  contentHasImage,
  isContextWindowExceededError,
  isQuotaExceededError,
  offloadedImageText,
  projectOffloadedImages,
  requestImageHandleText,
  requiredImageOffload,
  resolveImageAttachmentAccess,
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
 * Catalog models measured to accept image input through the gateway.
 *
 * The roster endpoint discloses no modality field, so capability has to be
 * established empirically (`scripts/probe-vision.mjs`, 2026-11-17): each id here
 * answered the same question about two solid-colour images with the right
 * colour. The failures are informative too, so they are recorded rather than
 * guessed at:
 *   - `glm-5.3` answers that the image data is truncated/incomplete (the gateway
 *     hands it a damaged payload), so its image path is not usable;
 *   - `deepseek-v4-pro` refuses with 400 `Invalid content type. image_url is only
 *     supported by certain models` or never answers;
 *   - `deepseek-v4-flash` answers correctly once and then stops answering image
 *     requests at all (its text requests stay fast), which would turn a pasted
 *     screenshot into a multi-minute hang.
 * Over-claiming would let the harness admit an image and then fail or hang the
 * turn, so unverified ids stay text-only; `visionModels` overrides this list
 * without a release.
 */
const DEFAULT_VISION_MODELS = Object.freeze([
  'deepseek-v4.1-flash',
  'qwen3.8-max',
  'qwen3.8-flash',
  'glm-5.3-flash',
])

/** Per-image request projection: pixels and encoded bytes handed to the gateway. */
const DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET = 4_194_304
const DEFAULT_REQUEST_IMAGE_MAX_BYTES = 1_048_576

/**
 * Accumulated base64 image bytes one request may carry.
 *
 * The gateway answered 12MB request bodies and returned 413 for 16MB, so the
 * default stays well below that while leaving room for text and tool schemas.
 */
const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 8_388_608

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

/**
 * Characters an HTTP header value can carry: printable ASCII, no spaces.
 *
 * This is the same rule the host's former `assertUsableApiKey` applied. The
 * check lives here because DSH 0.2.3-alpha removed that helper from
 * `@deepseek-ai/dsh-llm`, and the replacement (`normalizeApiKey` from
 * `@deepseek-ai/dsh-credentials`) is not exported by the 0.2.2 line this
 * plugin also supports. Implementing the few lines locally keeps one import
 * surface valid on both host lines; `test/import-surface.mjs` pins it.
 */
const LEGAL_HEADER_CREDENTIAL = /^[\x21-\x7E]+$/

/**
 * Reject a credential no HTTP header can carry, and trim a padded one.
 *
 * The two failures mean different things to the user, so they get different
 * failure codes: nothing was supplied (blank after trimming) is a missing
 * credential, while characters that cannot travel in a header are a malformed
 * one the user has to correct.
 *
 * @param raw - the credential exactly as read from its source file.
 * @param label - human-readable origin used in the diagnostic (never the value).
 * @returns the trimmed credential.
 * @throws {LlmError} `MISSING_CREDENTIAL` when blank, `INVALID_CREDENTIAL` when malformed.
 */
function normalizeCredential(raw, label) {
  const value = raw.trim()
  if (value === '') {
    throw new LlmError(
      `${PACKAGE}: ${label} is blank — sign in with CANNWork again so it rewrites the value`,
      'MISSING_CREDENTIAL',
    )
  }
  if (!LEGAL_HEADER_CREDENTIAL.test(value)) {
    throw new LlmError(
      `${PACKAGE}: ${label} contains characters no HTTP header can carry (only printable ASCII without spaces is allowed)`,
      'INVALID_CREDENTIAL',
    )
  }
  return value
}

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
  /**
   * Catalog models that accept image input; every other id is advertised as
   * text only. The roster discloses no modality, so this list is measured (see
   * {@link DEFAULT_VISION_MODELS}) and stays overridable per deployment.
   */
  visionModels: z.array(z.string()).default([...DEFAULT_VISION_MODELS]),
  /** Pixel budget one request image is scaled into, preserving its aspect ratio. */
  requestImagePixelBudget: z.number().default(DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET),
  /** Encoded-byte target for one request image; the attachment service re-encodes to fit. */
  requestImageMaxBytes: z.number().default(DEFAULT_REQUEST_IMAGE_MAX_BYTES),
  /** Accumulated base64 image bytes one request may carry before old images are offloaded. */
  maxRequestImageBytes: z.number().default(DEFAULT_MAX_REQUEST_IMAGE_BYTES),
})

// ── credentials (read per request, never cached) ─────────────────────────────

/**
 * The opencode directories that can hold CANNWork's sign-in, in lookup order.
 *
 * CANNWork writes the JWT to opencode's XDG data dir and the VK to its config
 * dir; older layouts kept both in the data dir. Which pair exists therefore
 * depends on the CANNWork/opencode version on the machine, so every reader below
 * consults both roots instead of hard-coding one of them.
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
      // This request carries the access token: never let a redirect hand it to
      // another origin.
      redirect: 'error',
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
        // Each roster row carries the VK the gateway expects for that model,
        // and a builtin row's key is not the account-level one. Keep it so the
        // request path can prefer the row's own credential; rows without a key
        // (and the fallback catalog) keep using CANNWork's account VK.
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

// ── request translation ──────────────────────────────────────────────────────

/** The models this configuration lets the route advertise as image-capable. */
function visionModelsOf(config) {
  return config.visionModels ?? DEFAULT_VISION_MODELS
}

/**
 * Request projection for one image: aspect-preserving dimensions inside the
 * pixel budget, plus the encoded-byte target the attachment service must hit.
 *
 * Small images are never enlarged, matching the base adapter contract; the
 * harness uses this same projection for coordinate mapping, so it must describe
 * exactly the bytes the request carries.
 * @param image - durable normalized image reference.
 * @param config - resolved plugin configuration.
 * @returns dimensions and encoded-byte target for one request image.
 */
function requestImageTarget(image, config) {
  const maxPixels = config.requestImagePixelBudget ?? DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET
  const maxBytes = config.requestImageMaxBytes ?? DEFAULT_REQUEST_IMAGE_MAX_BYTES
  let { width, height } = image
  if (width * height > maxPixels) {
    const scale = Math.sqrt(maxPixels / (width * height))
    width = Math.max(1, Math.floor(width * scale))
    height = Math.max(1, Math.floor(height * scale))
  }
  return { width, height, maxBytes }
}

/** Refuse a payload this request path never carries (the harness projects files to text first). */
function assertNoFileBlocks(content) {
  for (const block of content) {
    if (block.type === 'file') {
      throw new LlmError(
        `${PACKAGE}: file attachments are projected to text by the harness and must not reach the adapter`,
        'UNSUPPORTED_CONTENT',
      )
    }
  }
}

/** Every retained image reference this request sends bytes for, deduplicated by attachment. */
function imageRefsOf(messages) {
  const refs = new Map()
  for (const message of messages) {
    // Preparation refuses any retained image outside these input roles, so the
    // filter is what keeps the read set equal to the transmitted set.
    if (message.role !== 'user' && message.role !== 'tool') continue
    for (const block of message.content ?? []) {
      if (block.type !== 'image' || block.offloaded === true) continue
      if (!refs.has(block.attachment.attachmentId)) refs.set(block.attachment.attachmentId, block.attachment)
    }
  }
  return [...refs.values()]
}

/**
 * Resolve every retained image into its request version before the body is
 * built, and refuse a request the route cannot carry.
 *
 * The order matters and mirrors the reference adapters: the surface's durable
 * offload decisions are projected first, so a request whose images were all
 * offloaded needs neither the attachment service nor any image bytes. Only then
 * are the vision-model and attachment-service requirements checked, and a
 * retained image in a role the wire cannot carry (anything but user content or a
 * tool result) is refused instead of silently dropped.
 *
 * The gateway accepts OpenAI vision content parts but has a request-body ceiling
 * (measured between 12MB and 16MB), so accumulated image bytes are bounded here
 * instead of being discovered as a 413: a request over the budget fails with
 * `IMAGE_OFFLOAD_REQUIRED`, which `dsh-compaction-image-offload` turns into a
 * durable offload of the oldest occurrences and one retry. The budget counts
 * exactly the occurrences this route transmits, so the recovery step can always
 * satisfy it.
 *
 * @param options - the assembled request.
 * @param config - resolved plugin configuration.
 * @param dependencies - lazily resolved attachment-service access.
 * @param signal - request cancellation, also covering attachment reads.
 * @returns prepared versions and projected history.
 */
async function prepareImages(options, config, dependencies, signal) {
  const services = dependencies ?? {}
  const attachments = services.resolveAttachments?.()
  // Access resolves to undefined without the service, which only shortens the
  // placeholder text; projection itself never needs image bytes.
  const accessOf = (ref) => (attachments === undefined ? undefined : services.resolveImageAccess?.(attachments, ref))
  const messages = projectOffloadedImages(options.messages ?? [], (ref) => offloadedImageText(ref, accessOf(ref)))
  if (!messages.some((message) => contentHasImage(message.content ?? []))) {
    return { versions: new Map(), accessOf, messages }
  }

  if (!visionModelsOf(config).includes(options.model)) {
    throw new LlmError(
      `${PACKAGE}: model ${options.model} is not declared image-capable; add it to visionModels or select a model that accepts images`,
      'UNSUPPORTED_CONTENT',
    )
  }
  const unsupported = messages.find(
    (message) => message.role !== 'user' && message.role !== 'tool' && contentHasImage(message.content ?? []),
  )
  if (unsupported !== undefined) {
    throw new LlmError(
      `${PACKAGE}: this route carries images only in user content and tool results; refusing a ${unsupported.role} image`,
      'UNSUPPORTED_CONTENT',
    )
  }
  if (attachments === undefined) {
    throw new LlmError(
      `${PACKAGE}: image input requires the durable attachment service, which is not mounted`,
      'UNSUPPORTED_CONTENT',
    )
  }

  const versions = new Map()
  await Promise.all(
    imageRefsOf(messages).map(async (ref) => {
      const version = await attachments.readImageRequest(ref, requestImageTarget(ref, config), signal)
      versions.set(ref.attachmentId, version)
    }),
  )

  const maxBytes = config.maxRequestImageBytes ?? DEFAULT_MAX_REQUEST_IMAGE_BYTES
  const offloadImages = requiredImageOffload(
    messages,
    { representation: 'base64', maxBytes },
    (block) => versions.get(block.attachment.attachmentId).bytes,
  )
  if (offloadImages > 0) {
    throw new LlmError(
      `${PACKAGE}: the request carries more image bytes than the route allows; ${offloadImages} oldest image(s) must be offloaded`,
      IMAGE_OFFLOAD_REQUIRED_CODE,
      { offloadImages },
    )
  }

  return { versions, accessOf, messages }
}

/**
 * Build one message's OpenAI `content` value.
 *
 * A message without a retained image stays a plain string, so text-only wire
 * bodies are unchanged. A retained image becomes the two parts the gateway
 * reads: deterministic handle text (name, dimensions, read-only path) and the
 * bytes as a `data:` URL. Preparation refuses every occurrence it cannot
 * transmit, so a missing prepared version is an internal invariant violation,
 * not a case to paper over with placeholder text.
 *
 * @param content - typed content blocks of one message.
 * @param images - prepared image state.
 * @returns a string when no image part is present, otherwise the content parts.
 */
function toContent(content, images) {
  const parts = []
  let imagesSent = 0
  for (const block of content) {
    if (block.type === 'text') {
      if (block.text !== '') parts.push({ type: 'text', text: block.text })
      continue
    }
    if (block.type !== 'image') continue
    const ref = block.attachment
    const version = images?.versions.get(ref.attachmentId)
    if (version === undefined) {
      throw new LlmError(
        `${PACKAGE}: image ${ref.name ?? ref.attachmentId} reached serialization without a prepared request version`,
        'UNSUPPORTED_CONTENT',
      )
    }
    parts.push({ type: 'text', text: requestImageHandleText(ref, version, images.accessOf(ref)) })
    parts.push({
      type: 'image_url',
      image_url: { url: `data:${version.mediaType};base64,${Buffer.from(version.data).toString('base64')}` },
    })
    imagesSent += 1
  }
  return imagesSent === 0 ? parts.map((part) => part.text).join('') : parts
}

/** Concatenate the text blocks of one message. */
function textOf(content) {
  let text = ''
  for (const block of content) if (block.type === 'text') text += block.text
  return text
}

/** Translate harness messages into the OpenAI chat-completions array. */
function toMessages(options, images) {
  const out = []
  if (options.system !== undefined && options.system !== '') {
    out.push({ role: 'system', content: options.system })
  }
  for (const message of images?.messages ?? options.messages ?? []) {
    const content = message.content ?? []
    switch (message.role) {
      case 'system':
      case 'developer':
        assertNoFileBlocks(content)
        out.push({ role: 'system', content: textOf(content) })
        break
      case 'user':
        assertNoFileBlocks(content)
        out.push({ role: 'user', content: toContent(content, images) })
        break
      case 'assistant': {
        assertNoFileBlocks(content)
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
        assertNoFileBlocks(content)
        // Tool content stays a string unless it carries images; the gateway
        // reads the array form (verified), which keeps a screenshot result in
        // the turn that produced it instead of inventing a user message.
        out.push({
          role: 'tool',
          tool_call_id: message.toolCallId,
          content: toContent(content, images),
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
function toRequestBody(options, images) {
  const body = {
    model: options.model,
    messages: toMessages(options, images),
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
    throw new LlmError(`${PACKAGE}: ${field} is not a valid URL`, 'INVALID_REQUEST')
  }
  if (url.protocol === 'https:') return
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol === 'http:' && loopback) return
  throw new LlmError(
    `${PACKAGE}: ${field} must be https (plain http is allowed only for loopback) — it carries the CANNBOT access token`,
    'INVALID_REQUEST',
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
  const retryAfterMs = Number(retryAfterHeader) > 0 ? Number(retryAfterHeader) * 1000 : undefined
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
  #dependencies
  #catalog = FALLBACK_CATALOG
  #retryPolicy

  /**
   * @param config - resolved plugin configuration.
   * @param dependencies - lazily resolved services used only by image requests.
   *   Both are read on the request path, so mounting never depends on the
   *   attachment service being present, and a text-only deployment keeps working
   *   without it.
   */
  constructor(config, dependencies = {}) {
    super()
    this.#config = config
    this.#dependencies = dependencies
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

  /** Modalities this route advertises for one exact model. */
  #inputModalities(model) {
    return visionModelsOf(this.#config).includes(model) ? ['text', 'image'] : ['text']
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
        inputModalities: this.#inputModalities(model.id),
      })),
    )
  }

  resolveModel(provider, model) {
    const row = this.#catalog.find((entry) => entry.id === model)
    return Promise.resolve({
      provider,
      id: model,
      name: row?.name ?? model,
      inputModalities: this.#inputModalities(model),
      context: { contextWindow: row?.contextWindow ?? this.#config.defaultContextWindow },
      reasoning: {
        efforts: REASONING_EFFORTS.map((id) => ({
          id,
          name: id.charAt(0).toUpperCase() + id.slice(1),
        })),
      },
    })
  }

  /**
   * The dimensions and byte target this route sends for one image.
   *
   * The harness applies the base projection unless overridden, and the same
   * target is what serialization reads, so an oversized screenshot is scaled
   * once instead of being sent at full resolution (which the gateway counts as
   * visual tokens and the body limit counts as payload).
   */
  imageRequestTarget(_provider, _model, image) {
    return requestImageTarget(image, this.#config)
  }

  stream(options) {
    return this.#generate(options)
  }

  /** One cancellable request lifecycle. */
  async *#generate(options) {
    const config = this.#config

    const jwt = readJwt()
    // Prefer the VK the catalog advertises for this exact model: the gateway
    // issues a distinct key per roster row (a builtin row's key differs from
    // the account-level one), so the row is the more specific credential.
    // Models with no row key — and the fallback catalog before the roster
    // lands — keep using CANNWork's account VK from auth.json.
    const row = this.#catalog.find((entry) => entry.id === options.model)
    const vk = row?.vk ?? readAccountVk()
    if (jwt === undefined) {
      throw new LlmError(
        `${PACKAGE}: no CANNBOT access token — open CANNWork and sign in so it writes session.json`,
        'MISSING_CREDENTIAL',
      )
    }
    if (vk === undefined) {
      throw new LlmError(
        `${PACKAGE}: no CANNBOT virtual key for ${options.model} — open CANNWork and sign in so it writes auth.json`,
        'MISSING_CREDENTIAL',
      )
    }
    // A value no HTTP header can carry is a malformed credential rather than a
    // missing one, and an empty/whitespace-only value is the missing case.
    const bearer = normalizeCredential(jwt, 'the CANNBOT access token (session.json accessToken)')
    const virtualKey = normalizeCredential(vk, 'the CANNBOT virtual key')

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
      // Attachment reads run under the same idle ceiling and abort signal as the
      // provider read: a wedged attachment backend must not outlive the watchdog.
      armIdle()
      const images = await prepareImages(options, config, this.#dependencies, signal)
      // The body is built outside the transport try, so a serialization failure
      // (for example an attachment-resolver error) keeps its own code instead of
      // being reported as a transport failure.
      const body = JSON.stringify(toRequestBody(options, images))
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
          body,
          signal,
          // This request carries both credentials: never let a redirect hand
          // them to another origin.
          redirect: 'error',
        })
      } catch (error) {
        if (idleExpired) throw new LlmError(`${PACKAGE}: provider read timed out`, 'TIMEOUT', { cause: error })
        if (options.signal?.aborted) throw new LlmError(`${PACKAGE}: request aborted`, 'ABORTED', { cause: error })
        throw new LlmError(`${PACKAGE}: transport failed`, 'TRANSPORT', { cause: error })
      }

      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw providerFailure(response.status, errorTextOf(text), response.headers.get('retry-after'), [
          bearer,
          virtualKey,
        ])
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
          throw providerFailure(400, errorTextOf(JSON.stringify(event)), undefined, [bearer, virtualKey])
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
      const promptTokens = safeCount(usage.prompt_tokens) ?? 0
      const outputTokens = safeCount(usage.completion_tokens) ?? 0
      // The gateway follows OpenAI semantics: `prompt_tokens` INCLUDES the
      // cached prefix, while the harness reports prompt-side counts as
      // DISJOINT buckets (`inputTokens` is uncached input only). Subtracting
      // the hit is required here: the session's displayed cache-hit share is
      // `cacheReadTokens / (input + cacheRead + cacheWrite)`, so leaving the
      // hit inside `inputTokens` counts it twice and caps the display at 50%.
      // `prompt_cache_hit_tokens` is DeepSeek's other spelling, seen on
      // gateways that omit `prompt_tokens_details`; `??` alone would forward a
      // null/string/negative value from that spelling, which the harness treats
      // as a contradiction and drops the entire sample over.
      const reportedHit = safeCount(promptDetails.cached_tokens) ?? safeCount(usage.prompt_cache_hit_tokens)
      // Clamp the hit itself, not just the subtraction: the harness reconciles
      // `inputTokens + cacheReadTokens + outputTokens` against `totalTokens`, so
      // a hit larger than the prompt would leave the buckets unreconcilable and
      // void the whole disclosure.
      const cacheRead = reportedHit === undefined ? undefined : Math.min(reportedHit, promptTokens)
      const reasoning = safeCount(completionDetails.reasoning_tokens)
      // The harness rejects a total that is smaller than the known buckets, so
      // the gateway's own total is kept only when it agrees with the derived
      // one; the contract explicitly allows deriving it from the authoritative
      // prompt/output counters instead.
      const providerTotal = safeCount(usage.total_tokens)
      const totalTokens = providerTotal === promptTokens + outputTokens ? providerTotal : promptTokens + outputTokens
      yield {
        type: 'usage',
        usage: {
          inputTokens: promptTokens - (cacheRead ?? 0),
          outputTokens,
          totalTokens,
          ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
          // Committed reasoning tokens are a subset of output tokens; a gateway
          // that reports more would otherwise void the sample, so clamp the
          // count rather than overstating the reasoning share.
          ...(reasoning === undefined ? {} : { reasoningTokens: Math.min(reasoning, outputTokens) }),
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
    visionModels: config.visionModels ?? [...DEFAULT_VISION_MODELS],
    requestImagePixelBudget: config.requestImagePixelBudget ?? DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
    requestImageMaxBytes: config.requestImageMaxBytes ?? DEFAULT_REQUEST_IMAGE_MAX_BYTES,
    maxRequestImageBytes: config.maxRequestImageBytes ?? DEFAULT_MAX_REQUEST_IMAGE_BYTES,
  }

  // Both endpoints receive credential material, so an insecure one is refused
  // where the configuration is written rather than on the first request.
  assertSecureEndpoint(resolved.baseURL, 'baseURL')
  assertSecureEndpoint(resolved.modelsURL, 'modelsURL')

  // Attachment access is resolved per request, not at mount time: a deployment
  // without the attachment service still mounts the route (and reports a clear
  // refusal only if an image actually arrives).
  const adapter = new CannbotAdapter(resolved, {
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) =>
      resolveImageAttachmentAccess(attachments, (hostPath) => ctx.get('fs')?.processPathFromHostPath(hostPath), ref),
  })
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
