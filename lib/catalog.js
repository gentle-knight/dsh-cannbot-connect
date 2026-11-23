import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, MODELS_URL } from './constants.js'
import { readJwt } from './credentials.js'


/** Conservative fallback so a failed catalog fetch never hides the route. */
const FALLBACK_CATALOG = [
  {
    id: 'deepseek-v4.1-flash',
    name: 'DeepSeek-V4.1-Flash (CANNBOT)',
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  },
]

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

export { FALLBACK_CATALOG }

// ── roster lifecycle ─────────────────────────────────────────────────────────

/**
 * Keep one provider's advertised roster fresh without ever blocking mount.
 *
 * The store owns a single in-flight fetch and a single timer: a slow endpoint
 * cannot stack requests, and a disposed plugin cannot schedule another one.
 * A failed refresh keeps the previous catalog, because replacing a working
 * roster with nothing is worse than serving a stale one; the failure is
 * reported to the caller so it can log the reason without credential material.
 *
 * `refreshSoon()` is the request-path hook: when a model request fails with
 * AUTH or MODEL_UNSUPPORTED, the roster may have changed (a sign-in refresh or
 * an account switch), so one retry is scheduled after a short cooldown instead
 * of waiting for the next timer tick.
 */
class CatalogStore {
  #modelsURL
  #refreshMs
  #loader
  #onCatalog
  #onFailure
  #timer
  #retryTimer
  #inflight
  #disposed = false
  #lastReason
  #lastRefreshAt
  #lastFailure
  #isRefreshing = false
  #refreshAfterInflight = false

  /**
   * @param options - roster endpoint, refresh interval, loader, and observers.
   */
  constructor({ modelsURL, refreshMs, loader = fetchCatalog, onCatalog = () => {}, onFailure = () => {} }) {
    this.#modelsURL = modelsURL
    this.#refreshMs = refreshMs
    this.#loader = loader
    this.#onCatalog = onCatalog
    this.#onFailure = onFailure
  }

  /** Read the public catalog status (no credentials, no raw errors). */
  get status() {
    return {
      lastRefreshAt: this.#lastRefreshAt,
      lastFailure: this.#lastFailure,
      lastReason: this.#lastReason,
      isRefreshing: this.#isRefreshing,
    }
  }

  /**
   * Adopt new live options. An endpoint change asks for an immediate refresh;
   * an interval-only change only re-arms the timer. The current roster stays
   * until the new endpoint answers, so a typo never empties a working roster.
   * @param options - endpoint and interval from the live config.
   */
  updateOptions({ modelsURL, refreshMs }) {
    if (this.#disposed) return
    const endpointChanged = modelsURL !== this.#modelsURL
    const intervalChanged = refreshMs !== this.#refreshMs
    this.#modelsURL = modelsURL
    this.#refreshMs = refreshMs
    if (endpointChanged) {
      this.#lastFailure = undefined
      if (this.#inflight !== undefined) this.#refreshAfterInflight = true
      else void this.refresh('config')
      return
    }
    if (intervalChanged) {
      if (this.#timer !== undefined) {
        clearTimeout(this.#timer)
        this.#timer = undefined
      }
      this.#schedule()
    }
  }

  /** Fetch once immediately and start the timer; safe to call once at mount. */
  start() {
    if (this.#disposed) return
    void this.refresh('mount')
  }

  /**
   * Fetch the roster once. Concurrent callers share the in-flight request.
   *
   * @param reason - why this fetch ran; passed to the observers.
   * @returns the loader's result, or undefined when disposed.
   */
  async refresh(reason = 'manual') {
    if (this.#disposed) return undefined
    if (this.#inflight !== undefined) return this.#inflight
    this.#lastReason = reason
    this.#isRefreshing = true
    this.#inflight = (async () => {
      try {
        const result = await this.#loader({ modelsURL: this.#modelsURL })
        if (this.#disposed) return result
        if (result.ok) {
          this.#lastRefreshAt = Date.now()
          this.#lastFailure = undefined
          this.#onCatalog(result.catalog, { reason })
        } else {
          this.#lastFailure = result.reason
          this.#onFailure(result.reason, { reason })
        }
        return result
      } catch (error) {
        if (!this.#disposed) {
          this.#lastFailure = 'unknown'
          this.#onFailure('unknown', { reason, error })
        }
        return { ok: false, reason: 'unknown', catalog: [] }
      } finally {
        this.#isRefreshing = false
        this.#inflight = undefined
        if (this.#refreshAfterInflight) {
          this.#refreshAfterInflight = false
          void this.refresh('config')
        } else {
          this.#schedule()
        }
      }
    })()
    return this.#inflight
  }

  /**
   * Schedule one short-delay refresh after a request-side failure.
   *
   * A second call while a retry is already pending is ignored: a burst of
   * failures in one turn must not turn into a burst of roster requests.
   *
   * @param delayMs - cooldown before the retry.
   */
  refreshSoon(delayMs = 30_000) {
    if (this.#disposed || this.#retryTimer !== undefined) return
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined
      void this.refresh('retry')
    }, Math.max(0, delayMs))
    this.#retryTimer.unref?.()
  }

  /** Stop the timer and ignore a fetch that is still in flight. */
  dispose() {
    this.#disposed = true
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
    if (this.#retryTimer !== undefined) {
      clearTimeout(this.#retryTimer)
      this.#retryTimer = undefined
    }
  }

  /** Arm the next periodic refresh, unless one is already armed. */
  #schedule() {
    if (this.#disposed || this.#refreshMs <= 0 || this.#timer !== undefined) return
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      void this.refresh('timer')
    }, this.#refreshMs)
    this.#timer.unref?.()
  }
}

export { CatalogStore }
