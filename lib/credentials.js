import { LlmError } from '@deepseek-ai/dsh-llm'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { PACKAGE } from './constants.js'

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

// ── credential files (read per request, never cached) ────────────────────────

/**
 * Candidate opencode directories that can hold CANNWork's sign-in.
 *
 * Current opencode documents the same home-relative layout on every platform
 * (`~/.local/share/opencode` for data, `~/.config/opencode` for config), and
 * CANNWork's own auth plugin hardcodes those two paths. Newer opencode builds
 * are moving to platform directories (an `env-paths` migration), so the
 * platform candidates are appended as fallbacks after the current layout:
 *
 *   - Linux: `$XDG_DATA_HOME` / `$XDG_CONFIG_HOME`, then the home defaults.
 *   - macOS: the home defaults, then `~/Library/Application Support` and
 *     `~/Library/Preferences`.
 *   - Windows: the home defaults, then `%LOCALAPPDATA%\opencode\Data` and
 *     `%APPDATA%\opencode\Config` (plus the directory without the `Data` /
 *     `Config` suffix that some builds write).
 *
 * The home defaults stay FIRST because that is what the installed CANNWork
 * version writes; a fallback is only consulted when the preferred location has
 * no readable file. `process.platform` and `process.env` are injectable so the
 * platform matrix can be tested on Linux without changing the runtime.
 *
 * @param options - platform/env/home overrides for tests.
 * @returns candidate roots with their kind and a diagnostic label.
 */
function credentialRootEntries({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  const data = []
  const config = []
  const seen = new Set()
  const add = (kind, dir, label) => {
    if (typeof dir !== 'string' || dir === '') return
    const key = `${kind}\u0000${dir}`
    if (seen.has(key)) return
    seen.add(key)
    ;(kind === 'data' ? data : config).push({ kind, dir, label })
  }

  const xdgData = env.XDG_DATA_HOME?.trim()
  const xdgConfig = env.XDG_CONFIG_HOME?.trim()
  if (xdgData) add('data', join(xdgData, 'opencode'), 'xdg-data')
  if (xdgConfig) add('config', join(xdgConfig, 'opencode'), 'xdg-config')

  // The layout current opencode/CANNWork uses on every platform.
  add('data', join(home, '.local', 'share', 'opencode'), 'home-data')
  add('config', join(home, '.config', 'opencode'), 'home-config')

  if (platform === 'darwin') {
    add('data', join(home, 'Library', 'Application Support', 'opencode'), 'mac-app-support')
    add('config', join(home, 'Library', 'Preferences', 'opencode'), 'mac-preferences')
  } else if (platform === 'win32') {
    const local = env.LOCALAPPDATA?.trim()
    const roaming = env.APPDATA?.trim()
    if (local) {
      add('data', join(local, 'opencode', 'Data'), 'win-local-data')
      add('data', join(local, 'opencode'), 'win-local')
    }
    if (roaming) {
      add('config', join(roaming, 'opencode', 'Config'), 'win-roaming-config')
      add('config', join(roaming, 'opencode'), 'win-roaming')
    }
  }

  return [...data, ...config]
}

/**
 * Read one JSON file and remember where it came from.
 *
 * A missing or unparseable file is a normal state: both live in opencode's own
 * secret store, which a deployment may not have. The source path and mtime are
 * kept for diagnostics (never the value). A UTF-8 BOM is stripped before
 * parsing, because a Windows editor or a copy step can add one and `JSON.parse`
 * would reject the otherwise valid document.
 *
 * @param path - absolute file path.
 * @param kind - which opencode root the path belongs to.
 * @param label - platform/location label for diagnostics.
 * @returns the parsed document plus its provenance, or undefined.
 */
function readJsonEntry(path, kind, label) {
  try {
    if (!existsSync(path)) return undefined
    const stat = statSync(path)
    const text = readFileSync(path, 'utf-8').replace(/^\uFEFF/, '')
    return { value: JSON.parse(text), path, kind, label, mtimeMs: stat.mtimeMs }
  } catch {
    return undefined
  }
}

/**
 * Every readable JSON document of that name across the candidate roots.
 *
 * The order is data then config by default; callers that need the opposite
 * (the VK's current location is the config dir) pass `configFirst`. Candidate
 * order inside each kind is the resolver's order, so an explicit `XDG_*`
 * setting wins over the home default and the home default wins over a
 * platform-migration fallback.
 *
 * @param name - file name such as `session.json`.
 * @param options - `configFirst` plus platform/env/home overrides.
 * @returns readable documents with provenance, in lookup order.
 */
function readJsonCopies(name, { configFirst = false, ...options } = {}) {
  const roots = credentialRootEntries(options)
  const ordered = configFirst
    ? [...roots.filter((root) => root.kind === 'config'), ...roots.filter((root) => root.kind === 'data')]
    : roots
  const copies = []
  for (const root of ordered) {
    const entry = readJsonEntry(join(root.dir, name), root.kind, root.label)
    if (entry !== undefined) copies.push(entry)
  }
  return copies
}

/** The first entry whose `accessToken` is a non-empty string. */
function readJwtEntry(options) {
  for (const session of readJsonCopies('session.json', options)) {
    const token = session.value?.accessToken
    if (typeof token === 'string' && token !== '') return { ...session, token }
  }
  return undefined
}

/** The first entry whose `cannbot.key` is a non-empty string. */
function readVkEntry(options) {
  for (const auth of readJsonCopies('auth.json', { ...options, configFirst: true })) {
    const key = auth.value?.cannbot?.key
    if (typeof key === 'string' && key !== '') return { ...auth, key }
  }
  // Older opencode builds kept the same `vk-…` value as the refresh field of
  // the `cannbot-cli` OAuth entry. Only that exact shape is accepted, so an
  // unrelated refresh token is never sent as the VK.
  for (const auth of readJsonCopies('auth.json', options)) {
    const key = auth.value?.['cannbot-cli']?.refresh
    if (typeof key === 'string' && key.startsWith('vk-')) return { ...auth, key }
  }
  return undefined
}

/**
 * CANNWork's JWT — the `Bearer` the gateway calls the "Access Token".
 *
 * @param options - platform/env/home overrides for tests.
 * @returns the token, or undefined when no candidate file holds one.
 */
export function readJwt(options) {
  return readJwtEntry(options)?.token
}

/**
 * The account-level VK from opencode's auth.json.
 *
 * The config-dir copy wins over the data-dir copy: current CANNWork writes
 * `cannbot.key` under the config dir, and a stale data-dir copy left behind by
 * an older install must not shadow a rotated one. The legacy `cannbot-cli.refresh`
 * shape is the last resort.
 *
 * @param options - platform/env/home overrides for tests.
 * @returns the account VK, or undefined when none is stored.
 */
export function readAccountVk(options) {
  return readVkEntry(options)?.key
}

/**
 * Expiry instant encoded in a JWT, when the token carries a readable `exp`.
 *
 * The signature is deliberately not verified: this is a diagnostic and a
 * refresh trigger, never an authorization decision. An opaque token (not
 * dot-separated) or a malformed payload reads as "unknown", not as expired.
 *
 * @param token - the access token.
 * @returns expiry in epoch milliseconds, or undefined.
 */
export function jwtExpiresAt(token) {
  if (typeof token !== 'string') return undefined
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    const exp = payload?.exp
    return typeof exp === 'number' && Number.isFinite(exp) && exp > 0 ? exp * 1000 : undefined
  } catch {
    return undefined
  }
}

/**
 * Read-only summary of the sign-in files, for logs and tests.
 *
 * Never contains a credential value: only presence, which opencode root it was
 * read from, that file's mtime, and the JWT expiry when it can be decoded.
 *
 * @returns the two credentials' presence and provenance.
 */
export function authStatus(options) {
  const jwt = readJwtEntry(options)
  const vk = readVkEntry(options)
  return {
    jwt: {
      present: jwt !== undefined,
      source: jwt?.path,
      root: jwt?.kind,
      label: jwt?.label,
      mtimeMs: jwt?.mtimeMs,
      expiresAtMs: jwt === undefined ? undefined : jwtExpiresAt(jwt.token),
    },
    vk: {
      present: vk !== undefined,
      source: vk?.path,
      root: vk?.kind,
      label: vk?.label,
      mtimeMs: vk?.mtimeMs,
    },
  }
}

export { LEGAL_HEADER_CREDENTIAL, credentialRootEntries, normalizeCredential }
