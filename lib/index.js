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
import { modelFacingChanged, readConfig, refreshRequested } from './config-runtime.js'
import { PACKAGE, PROVIDER, VERSION } from './constants.js'
import { authStatus, readAccountVk, readJwt } from './credentials.js'
import { assertSecureEndpoint } from './errors.js'
import { buildStatus } from './status.js'
import { registerStatusRoute } from './web.js'

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
  let current = readConfig(config)
  let configError
  let store
  let adapter
  let offVolatile
  const settingsNs = ctx.fiber?.entry?.options?.id ?? 'llm-cannbot'

  // Both endpoints receive credential material, so an insecure one is refused
  // where the configuration is written rather than on the first request.
  assertSecureEndpoint(current.baseURL, 'baseURL')
  assertSecureEndpoint(current.modelsURL, 'modelsURL')

  // Attachment access is resolved per request, not at mount time: a deployment
  // without the attachment service still mounts the route (and reports a clear
  // refusal only if an image actually arrives).
  store = new CatalogStore({
    modelsURL: current.modelsURL,
    refreshMs: current.catalogRefreshMs,
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
  adapter = new CannbotAdapter(current, {
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) =>
      resolveImageAttachmentAccess(attachments, (hostPath) => ctx.get('fs')?.processPathFromHostPath(hostPath), ref),
    // A sign-in refresh or an account switch can change the roster; one short
    // retry is cheaper than waiting for the next periodic tick.
    onAuthFailure: () => store.refreshSoon(),
  })
  const release = ctx.llm.registerAdapter([PROVIDER], adapter)

  /**
   * Apply the latest volatile config. A settings write updates the wrapper
   * refs in place and emits one `loader/volatile-update`; the request path and
   * the catalog timer both read the plain snapshot this produces.
   */
  const applyLive = () => {
    const next = readConfig(config)
    try {
      assertSecureEndpoint(next.baseURL, 'baseURL')
      assertSecureEndpoint(next.modelsURL, 'modelsURL')
    } catch (error) {
      configError = safeLiveError(error)
      ctx.logger.warn(`${PACKAGE}: live config rejected (${configError}); keeping the previous endpoints`)
      return
    }

    const previous = current
    current = next
    configError = undefined
    adapter.updateConfig(next)
    store.updateOptions({ modelsURL: next.modelsURL, refreshMs: next.catalogRefreshMs })
    if (refreshRequested(previous, next)) void store.refresh('manual')
    if (modelFacingChanged(previous, next)) {
      try {
        ctx.emit('llm/models-updated', PROVIDER)
      } catch (error) {
        ctx.logger.warn(`${PACKAGE}: a model-update listener failed`)
        ctx.logger.warn(error)
      }
    }
  }

  offVolatile = ctx.on?.('loader/volatile-update', () => {
    try {
      applyLive()
    } catch (error) {
      ctx.logger.error(`${PACKAGE}: live config update failed`)
      ctx.logger.error(error)
    }
  })

  /** The secret-free status document the Settings page reads. */
  const readStatus = () => buildStatus({
    version: VERSION,
    provider: PROVIDER,
    settingsNs,
    active: true,
    models: adapter.catalog,
    auth: authStatus(),
    catalog: store.status,
    config: current,
    configError,
  })

  ctx.inject?.(['webServer'], (webCtx) => {
    try {
      const dispose = registerStatusRoute(webCtx, readStatus)
      if (typeof webCtx.effect === 'function') webCtx.effect(() => dispose)
      else ctx.effect?.(() => dispose)
    } catch (error) {
      // A route collision must not take the provider down; the page falls back
      // to its settings-only posture.
      ctx.logger.warn(`${PACKAGE}: status route was not registered`)
      ctx.logger.warn(error)
    }
  })

  // The custom Settings page is the presentation; keep the automatic generic
  // form out of the way where the settings service exists.
  ctx.inject?.(['settings'], (child) => {
    if (child.settings?.configure === undefined || ctx.fiber === undefined) return
    try {
      child.effect?.(() => child.settings.configure({ auto: false }, ctx.fiber))
    } catch (error) {
      // The custom page still works if the host refuses the presentation
      // policy; only the generic form's auto-generation flag is affected.
      ctx.logger.warn(`${PACKAGE}: automatic settings form could not be disabled`)
      ctx.logger.warn(error)
    }
  })

  ctx.effect?.(() => () => {
    offVolatile?.()
    store.dispose()
  })

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

/** A stable, text-only diagnostic for a rejected live config. */
function safeLiveError(error) {
  return error instanceof Error && error.message !== '' ? error.message : 'invalid configuration'
}
