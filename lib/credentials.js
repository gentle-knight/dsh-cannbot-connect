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
 * The opencode directories that can hold CANNWork's sign-in.
 *
 * CANNWork writes the JWT to opencode's XDG data dir and the VK to its config
 * dir; older layouts kept both in the data dir. Which pair exists therefore
 * depends on the CANNWork/opencode version on the machine, so every reader below
 * consults both roots instead of hard-coding one of them.
 *
 * @returns the two roots with their kind, in data-then-config order.
 */
function opencodeRootEntries() {
  const home = homedir()
  return [
    { kind: 'data', dir: join(process.env.XDG_DATA_HOME || join(home, '.local', 'share'), 'opencode') },
    { kind: 'config', dir: join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode') },
  ]
}

/**
 * Read one JSON file and remember where it came from.
 *
 * A missing or unparseable file is a normal state: both live in opencode's own
 * secret store, which a deployment may not have. The source path and mtime are
 * kept for diagnostics (never the value).
 *
 * @param path - absolute file path.
 * @param kind - which opencode root the path belongs to.
 * @returns the parsed document plus its provenance, or undefined.
 */
function readJsonEntry(path, kind) {
  try {
    if (!existsSync(path)) return undefined
    const stat = statSync(path)
    return { value: JSON.parse(readFileSync(path, 'utf-8')), path, kind, mtimeMs: stat.mtimeMs }
  } catch {
    return undefined
  }
}

/**
 * Every readable JSON document of that name across the opencode roots.
 *
 * The order is data then config by default; callers that need the opposite
 * (the VK's current location is the config dir) pass `configFirst`.
 *
 * @param name - file name such as `session.json`.
 * @param options - `configFirst` flips the root order.
 * @returns readable documents with provenance, in lookup order.
 */
function readJsonCopies(name, { configFirst = false } = {}) {
  const roots = opencodeRootEntries()
  const ordered = configFirst ? [...roots].reverse() : roots
  const copies = []
  for (const root of ordered) {
    const entry = readJsonEntry(join(root.dir, name), root.kind)
    if (entry !== undefined) copies.push(entry)
  }
  return copies
}

/** The first entry whose `accessToken` is a non-empty string. */
function readJwtEntry() {
  for (const session of readJsonCopies('session.json')) {
    const token = session.value?.accessToken
    if (typeof token === 'string' && token !== '') return { ...session, token }
  }
  return undefined
}

/** The first entry whose `cannbot.key` is a non-empty string. */
function readVkEntry() {
  for (const auth of readJsonCopies('auth.json', { configFirst: true })) {
    const key = auth.value?.cannbot?.key
    if (typeof key === 'string' && key !== '') return { ...auth, key }
  }
  // Older opencode builds kept the same `vk-…` value as the refresh field of
  // the `cannbot-cli` OAuth entry. Only that exact shape is accepted, so an
  // unrelated refresh token is never sent as the VK.
  for (const auth of readJsonCopies('auth.json')) {
    const key = auth.value?.['cannbot-cli']?.refresh
    if (typeof key === 'string' && key.startsWith('vk-')) return { ...auth, key }
  }
  return undefined
}

/** CANNWork's JWT — the `Bearer` the gateway calls the "Access Token". */
export function readJwt() {
  return readJwtEntry()?.token
}

/**
 * The account-level VK from opencode's auth.json.
 *
 * The config-dir copy wins over the data-dir copy: current CANNWork writes
 * `cannbot.key` under the config dir, and a stale data-dir copy left behind by
 * an older install must not shadow a rotated one. The legacy `cannbot-cli.refresh`
 * shape is the last resort.
 */
export function readAccountVk() {
  return readVkEntry()?.key
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
export function authStatus() {
  const jwt = readJwtEntry()
  const vk = readVkEntry()
  return {
    jwt: {
      present: jwt !== undefined,
      source: jwt?.path,
      root: jwt?.kind,
      mtimeMs: jwt?.mtimeMs,
      expiresAtMs: jwt === undefined ? undefined : jwtExpiresAt(jwt.token),
    },
    vk: {
      present: vk !== undefined,
      source: vk?.path,
      root: vk?.kind,
      mtimeMs: vk?.mtimeMs,
    },
  }
}

export { LEGAL_HEADER_CREDENTIAL, normalizeCredential, opencodeRootEntries }
