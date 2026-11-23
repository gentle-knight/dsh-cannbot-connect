/**
 * CANNBOT provider for DeepSeek Harness.
 *
 * A **first-class `LlmAdapter`** speaking the gateway's OpenAI-compatible
 * chat-completions wire format directly over `fetch` + SSE, so the plugin
 * carries no third-party runtime dependency at all. The distinctive part is
 * authentication: instead of running its own OAuth flow it reuses the sign-in
 * CANNWork already established for opencode.
 *
 *   - **JWT** — opencode's `session.json` → `{ accessToken }`, written and
 *     refreshed by that extension (24h lifetime).
 *   - **VK**  — opencode's `auth.json` → `{ cannbot: { key } }` (older builds
 *     kept the same `vk-…` value under `cannbot-cli.refresh`).
 *
 * CANNWork writes those files under opencode's XDG data directory, its config
 * directory, or both depending on the version, so every reader consults both
 * roots in a documented order instead of hard-coding one.
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

import { resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'

import { CannbotAdapter } from './adapter.js'
import { CatalogStore, fetchCatalog } from './catalog.js'
import { Config } from './config.js'
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
  GATEWAY_BASE_URL,
  MODELS_URL,
  PACKAGE,
  PROVIDER,
} from './constants.js'
import { authStatus, readAccountVk, readJwt } from './credentials.js'
import { assertSecureEndpoint } from './errors.js'

export { CannbotAdapter, Config, PROVIDER, authStatus, fetchCatalog, readAccountVk, readJwt }

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
    catalogRefreshMs: config.catalogRefreshMs ?? DEFAULT_CATALOG_REFRESH_MS,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    defaultMaxTokens: config.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
    visionModels: config.visionModels ?? [...DEFAULT_VISION_MODELS],
    requestImagePixelBudget: config.requestImagePixelBudget ?? DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
    requestImageMaxBytes: config.requestImageMaxBytes ?? DEFAULT_REQUEST_IMAGE_MAX_BYTES,
    maxRequestImageBytes: config.maxRequestImageBytes ?? DEFAULT_MAX_REQUEST_IMAGE_BYTES,
    maxRequestImages: config.maxRequestImages ?? DEFAULT_MAX_REQUEST_IMAGES,
    imageOffloadCountQuantum: config.imageOffloadCountQuantum ?? DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM,
  }

  // Both endpoints receive credential material, so an insecure one is refused
  // where the configuration is written rather than on the first request.
  assertSecureEndpoint(resolved.baseURL, 'baseURL')
  assertSecureEndpoint(resolved.modelsURL, 'modelsURL')

  // Attachment access is resolved per request, not at mount time: a deployment
  // without the attachment service still mounts the route (and reports a clear
  // refusal only if an image actually arrives).
  const store = new CatalogStore({
    modelsURL: resolved.modelsURL,
    refreshMs: resolved.catalogRefreshMs,
    onCatalog: (catalog) => {
      adapter.adoptCatalog(catalog)
      ctx.logger.info(`${PACKAGE}: ${catalog.length} models available`)
      // `adapters-updated` is the topology signal older consumers listen for;
      // `models-updated` is the catalog signal the 0.2.2+ GUI reloads on. Both
      // are safe to emit on a host that only declares one of them.
      ctx.emit('llm/adapters-updated')
      ctx.emit('llm/models-updated', PROVIDER)
    },
    onFailure: (reason) => {
      const why = {
        auth: 'CANNBOT sign-in expired — open CANNWork and sign in again',
        network: 'model endpoint unreachable',
        server: 'model endpoint rejected the request',
      }
      ctx.logger.warn(`${PACKAGE}: catalog unavailable (${why[reason] ?? reason})`)
    },
  })
  const adapter = new CannbotAdapter(resolved, {
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) =>
      resolveImageAttachmentAccess(attachments, (hostPath) => ctx.get('fs')?.processPathFromHostPath(hostPath), ref),
    // A sign-in refresh or an account switch can change the roster; one short
    // retry is cheaper than waiting for the next periodic tick.
    onAuthFailure: () => store.refreshSoon(),
  })
  const release = ctx.llm.registerAdapter([PROVIDER], adapter)

  ctx.effect?.(() => () => store.dispose())

  const auth = authStatus()
  const jwtVia = auth.jwt.label ?? auth.jwt.root
  const vkVia = auth.vk.label ?? auth.vk.root
  ctx.logger.info(
    `${PACKAGE}: jwt=${auth.jwt.present ? 'present' : 'missing'}${jwtVia === undefined ? '' : ` (${jwtVia})`} vk=${auth.vk.present ? 'present' : 'missing'}${vkVia === undefined ? '' : ` (${vkVia})`}`,
  )
  if (auth.jwt.expiresAtMs !== undefined && auth.jwt.expiresAtMs <= Date.now()) {
    ctx.logger.warn(`${PACKAGE}: the CANNBOT access token is expired; reopen CANNWork so it refreshes session.json`)
  }

  store.start()

  return release
}
