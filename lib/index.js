/**
 * CANNBOT provider for DeepSeek Harness.
 *
 * Reuses the sign-in CANNWork (the `cannbot-toolkit` VS Code extension) already
 * establishes for opencode, rather than starting a second OAuth flow:
 *
 *   - **JWT** — `$XDG_DATA_HOME/opencode/session.json` → `{ accessToken }`,
 *     written and refreshed by that extension.
 *   - **VK**  — `$XDG_DATA_HOME/opencode/auth.json` → `{ cannbot: { key } }`,
 *     plus the per-model `apiKey` the models endpoint returns.
 *
 * Both are read from disk on every operation (never cached), so a login, a
 * token refresh, or a VK rotation reaches the very next DSH request with no
 * restart — the same posture as opencode's own `cannwork-auth.js`.
 *
 * The gateway validates BOTH credentials on every request:
 *   - VK alone  → 401 `{"message":"Access Token required."}`
 *   - JWT alone → 401 `{"message":"Virtual Key is required."}`
 * so both headers are attached to every call.
 *
 * @module dsh-cannbot-connect
 */

import { createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, readFileSync } from 'node:fs'

/** The provider route this plugin owns. */
export const CANNBOT_PROVIDER = 'cannbot'

/** Gateway base URL (OpenAI-compatible mode). */
const GATEWAY_BASE_URL = 'https://cannbot.hicann.cn/gateway/compatible-mode/v1'

/** Model-list endpoint; returns `builtinModels` + `personalModels`. */
const MODELS_URL = 'https://cannbot.hicann.cn/cannbot/api/models/personal'

/** Idle ceiling for one outstanding provider read. */
const STREAM_IDLE_TIMEOUT_MS = 300_000

/** Image budgets at the dsh-llm-pi-ai defaults. */
const IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
}

const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/** Conservative fallback so a failed catalog fetch never hides the route. */
const FALLBACK_CATALOG = [
  {
    id: 'deepseek-v4.1-flash',
    name: 'DeepSeek-V4.1-Flash (CANNBOT)',
    contextWindow: 1_048_576,
    maxTokens: 393_216,
  },
]

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

// ── credentials (read per operation, never cached) ───────────────────────────

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
 * (this account's roster); both are served by this one route, so both are
 * registered. A row may carry its own `apiKey` (a per-model VK), which the
 * request path prefers over the account VK.
 */
export async function fetchCatalog({ signal } = {}) {
  const jwt = readJwt()
  if (jwt === undefined) return { ok: false, reason: 'auth', catalog: [] }

  const timeout = AbortSignal.timeout(15_000)
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  try {
    const res = await fetch(MODELS_URL, {
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

    // The two lists overlap: a model the account also has personally appears in
    // both. DSH rejects duplicate ids outright (`INVALID_CATALOG`), and the
    // personal row is the more specific one (it may carry its own VK), so it
    // wins and builtin rows only fill in what the account does not own.
    const seen = new Set()
    const rows = []
    for (const row of [...(data.personalModels ?? []), ...(data.builtinModels ?? [])]) {
      if (typeof row?.model !== 'string' || row.model === '' || seen.has(row.model)) continue
      seen.add(row.model)
      rows.push(row)
    }

    const catalog = rows
      .map((row) => ({
        id: row.model,
        name: row.title ?? row.model,
        contextWindow: Number.isFinite(row.contextLength) ? row.contextLength : 1_048_576,
        maxTokens: Number.isFinite(row?.completionOptions?.maxTokens)
          ? row.completionOptions.maxTokens
          : 131_072,
        apiKey: typeof row.apiKey === 'string' && row.apiKey !== '' ? row.apiKey : undefined,
      }))
    return catalog.length === 0
      ? { ok: false, reason: 'server', catalog: [] }
      : { ok: true, catalog }
  } catch {
    return { ok: false, reason: 'network', catalog: [] }
  }
}

// ── pi-ai model descriptors ──────────────────────────────────────────────────

/**
 * Build one pi-ai model descriptor pointing at the gateway directly.
 *
 * The credentials ride `headers` rather than a loopback proxy: pi-ai merges
 * `model.headers` into every request's default headers, which is all the
 * gateway's dual-header check needs. `row.apiKey` (a per-model VK) wins over
 * the account VK when the catalog supplied one.
 */
function toPiModel(row, accountVk) {
  const vk = row.apiKey ?? accountVk
  const jwt = readJwt()
  const headers = {}
  if (vk !== undefined) {
    headers['x-api-vkey'] = vk
    headers['api-key'] = vk
  }
  if (jwt !== undefined) headers.Authorization = `Bearer ${jwt}`

  return {
    id: row.id,
    name: row.name,
    api: 'openai-completions',
    provider: CANNBOT_PROVIDER,
    baseUrl: GATEWAY_BASE_URL,
    reasoning: true,
    input: ['text', 'image'],
    cost: NO_COST,
    contextWindow: row.contextWindow,
    maxTokens: row.maxTokens,
    headers,
    compat: { maxTokensField: 'max_tokens' },
  }
}

// ── adapter ──────────────────────────────────────────────────────────────────

/**
 * The CANNBOT route's adapter.
 *
 * `PiAiAdapter` owns streaming, retries, and model resolution. Its
 * `provider.getModels()` runs on every resolution, so a refreshed roster and a
 * rotated JWT both apply without re-registering the route — which is why one
 * long-lived provider is enough and no profile rebuilding is needed.
 *
 * The catalog is held in a mutable binding rather than baked into the provider:
 * registration must not block on the network, so the route mounts immediately
 * with {@link FALLBACK_CATALOG} and swaps to the live roster once the fetch
 * lands. `profiles()` returns the same Map identity every call so
 * `PiAiAdapter`'s snapshot memoization keeps working across operations.
 */
class CannbotAdapter extends PiAiAdapter {
  /** Live catalog rows; replaced in place when a fetch succeeds. */
  #catalog = FALLBACK_CATALOG

  constructor() {
    const provider = {
      ...createProvider({
        id: CANNBOT_PROVIDER,
        name: 'CANNBOT',
        auth: {
          apiKey: {
            name: 'CANNBOT VK + JWT',
            // pi-ai's `Models` refuses to stream for a provider whose auth
            // resolves to nothing. The real credentials travel in each model's
            // `headers` (merged last, so this value never becomes the wire
            // Authorization), so this only has to report "configured".
            async resolve() {
              return { auth: { apiKey: 'cannbot-gateway' }, source: 'CANNWork sign-in' }
            },
          },
        },
        models: FALLBACK_CATALOG.map((row) => toPiModel(row, readAccountVk())),
        api: openAICompletionsApi(),
      }),
      getModels: () => this.#catalog.map((row) => toPiModel(row, readAccountVk())),
    }

    const profile = {
      provider: CANNBOT_PROVIDER,
      displayName: 'CANNBOT',
      streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
      retryPolicy: resolveRetryPolicy(undefined, 'dsh-cannbot-connect retryPolicy'),
      configuredMaxTokens: new Map(),
      modelErrors: new Map(),
      ...IMAGE_BUDGETS,
      piProvider: provider,
    }

    // One stable Map: `PiAiAdapter` memoizes the snapshot by Map identity, so a
    // fresh Map per call would rebuild it on every request for no benefit.
    const profiles = new Map([[CANNBOT_PROVIDER, profile]])

    super({
      profiles: () => profiles,
      // Credentials ride in headers; this keeps pi-ai from demanding a key.
      resolveApiKey: async () => 'cannbot-gateway',
    })
  }

  /** Adopt a freshly fetched roster; the next model read serves it. */
  adoptCatalog(catalog) {
    this.#catalog = catalog
  }
}

// ── plugin contract ──────────────────────────────────────────────────────────

/** Cordis plugin name. */
export const name = 'cannbot-connect'

/** Services this plugin needs before it can register a route. */
export const inject = ['llm']

/**
 * Register the CANNBOT provider route.
 *
 * The route is unregistered automatically when this plugin's fiber disposes.
 * The catalog fetch is fire-and-forget: registration must not block on the
 * network, and the route already serves a usable fallback model.
 */
export function apply(ctx) {
  const jwt = readJwt()
  const vk = readAccountVk()
  ctx.logger.info(
    `dsh-cannbot-connect: jwt=${jwt === undefined ? 'missing' : 'present'} vk=${vk === undefined ? 'missing' : 'present'}`,
  )

  const adapter = new CannbotAdapter()
  const release = ctx.llm.registerAdapter([CANNBOT_PROVIDER], adapter)

  fetchCatalog()
    .then((result) => {
      if (!result.ok) {
        const why = {
          auth: 'CANNBOT sign-in expired — open CANNWork and sign in again',
          network: 'models endpoint unreachable',
          server: 'models endpoint rejected the request',
        }
        ctx.logger.warn(`dsh-cannbot-connect: catalog unavailable (${why[result.reason] ?? result.reason})`)
        return
      }
      adapter.adoptCatalog(result.catalog)
      ctx.logger.info(`dsh-cannbot-connect: ${result.catalog.length} models available`)
      ctx.emit?.('llm/adapters-updated')
    })
    .catch((error) => {
      ctx.logger.warn('dsh-cannbot-connect: catalog fetch failed', error)
    })

  return release
}
