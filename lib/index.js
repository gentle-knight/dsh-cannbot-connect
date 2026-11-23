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
import { fetchCatalog } from './catalog.js'
import { Config } from './config.js'
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_REQUEST_IMAGE_BYTES,
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
import { readAccountVk, readJwt } from './credentials.js'
import { assertSecureEndpoint } from './errors.js'

export { CannbotAdapter, Config, PROVIDER, fetchCatalog, readAccountVk, readJwt }

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
