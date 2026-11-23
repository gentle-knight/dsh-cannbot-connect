import { LlmError } from '@deepseek-ai/dsh-llm'
import { existsSync, readFileSync } from 'node:fs'
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

export { LEGAL_HEADER_CREDENTIAL, normalizeCredential, opencodeRoots }
