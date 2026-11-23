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
