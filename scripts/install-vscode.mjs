#!/usr/bin/env node
/**
 * Register the CANNBOT local model service as a **Custom Endpoint** group in
 * VS Code's `chatLanguageModels.json`, so the models appear in the chat sidebar.
 *
 * The file is the user-level list VS Code's chat reads for BYOK providers
 * (`vscode` → `chatLanguageModels.json`; the "Manage Models…" UI writes it too).
 * This script merges — it never deletes or rewrites other groups — and keeps a
 * timestamped backup before touching the file.
 *
 *     node scripts/install-vscode.mjs                    # write it
 *     node scripts/install-vscode.mjs --dry-run          # print the result only
 *     node scripts/install-vscode.mjs --base-url http://127.0.0.1:9000
 *
 * @module dsh-cannbot-connect/install-vscode
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fetchCatalog } from '../lib/local-server.js'

/** Group name written to `chatLanguageModels.json`. */
const GROUP_NAME = 'CANNBOT'

/** Providers VS Code understands for a user-supplied HTTP endpoint. */
const VENDOR = 'customendpoint'

/** Default loopback port of the local service. */
const DEFAULT_BASE_URL = 'http://127.0.0.1:8788'

/**
 * Candidate `User` directories, in precedence order.
 *
 * VS Code, Insiders and Cursor share the file format; the first directory that
 * already holds a `chatLanguageModels.json` wins, otherwise the stable VS Code
 * one is created.
 */
function userDirs() {
  const home = homedir()
  const candidates = []
  if (process.platform === 'darwin') {
    candidates.push(join(home, 'Library', 'Application Support', 'Code', 'User'))
    candidates.push(join(home, 'Library', 'Application Support', 'Code - Insiders', 'User'))
    candidates.push(join(home, 'Library', 'Application Support', 'Cursor', 'User'))
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming')
    candidates.push(join(appData, 'Code', 'User'))
    candidates.push(join(appData, 'Code - Insiders', 'User'))
    candidates.push(join(appData, 'Cursor', 'User'))
  } else {
    const config = process.env.XDG_CONFIG_HOME ?? join(home, '.config')
    candidates.push(join(config, 'Code', 'User'))
    candidates.push(join(config, 'Code - Insiders', 'User'))
    candidates.push(join(config, 'Cursor', 'User'))
  }
  return candidates
}

/** Pick the config file to merge into. */
function resolveConfigPath(explicit) {
  if (typeof explicit === 'string' && explicit !== '') {
    return explicit.endsWith('.json') ? explicit : join(explicit, 'chatLanguageModels.json')
  }
  const dirs = userDirs()
  for (const dir of dirs) {
    const file = join(dir, 'chatLanguageModels.json')
    if (existsSync(file)) return file
  }
  return join(dirs[0], 'chatLanguageModels.json')
}

/** Parse `--flag value` / `--flag=value` arguments. */
function parseArgs(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const eq = arg.indexOf('=')
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1)
      continue
    }
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      flags[key] = 'true'
      continue
    }
    flags[key] = next
    i += 1
  }
  return flags
}

/** Read the existing provider list, refusing to clobber a file we cannot parse. */
function readExisting(file) {
  if (!existsSync(file)) return []
  const text = readFileSync(file, 'utf-8')
  if (text.trim() === '') return []
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(
      `refusing to touch ${file}: it is not valid JSON (${error.message}). Fix or remove it first; nothing was written.`,
    )
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`refusing to touch ${file}: expected a JSON array of provider groups. Nothing was written.`)
  }
  return parsed
}

/**
 * Ask the service (or the gateway) which models this account may use.
 *
 * The service is the authority on what a client will actually see, so it is
 * preferred; a direct catalog fetch keeps the script useful when the service is
 * not running yet.
 */
async function loadModels(baseURL) {
  try {
    const response = await fetch(`${endpointBase(baseURL)}/v1/models`, { signal: AbortSignal.timeout(10_000) })
    if (response.ok) {
      const json = await response.json()
      const models = (json?.data ?? [])
        .filter((model) => typeof model?.id === 'string' && model.id !== '')
        .map((model) => ({
          id: model.id,
          name: typeof model?.name === 'string' && model.name !== '' ? model.name : model.id,
          contextWindow: Number.isFinite(model?.context_window) ? model.context_window : undefined,
          maxTokens: Number.isFinite(model?.max_tokens) ? model.max_tokens : undefined,
        }))
      if (models.length > 0) return { models, source: `${baseURL}/v1/models` }
    }
  } catch {
    // fall through to the gateway
  }
  const result = await fetchCatalog()
  if (result.ok && result.catalog.length > 0) return { models: result.catalog, source: 'the CANNBOT gateway' }
  return { models: [], source: 'none' }
}

/**
 * Build the provider group VS Code reads.
 *
 * No `apiKey` is written on purpose. VS Code stores BYOK secrets in its own
 * secret storage and only a `${input:chat.lm.secret.<id>}` reference in this
 * file resolves to one; a literal value is decoded as such a reference and ends
 * up undefined anyway. The local service does not check a key by default, and
 * `--key` is instead passed through a model header VS Code is allowed to set.
 */
function buildGroup(models, { baseURL, keyHeader }) {
  const endpoint = `${endpointBase(baseURL)}/v1`
  return {
    name: GROUP_NAME,
    vendor: VENDOR,
    apiType: 'chat-completions',
    models: models.map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      url: endpoint,
      toolCalling: true,
      // The CANNBOT gateway validates text input only; claiming vision would
      // make VS Code attach images the gateway refuses.
      vision: false,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxTokens,
      // The gateway accepts these levels (and rejects `off`), so VS Code can
      // show its effort picker and forward the choice as `reasoning_effort`.
      supportsReasoningEffort: ['minimal', 'low', 'medium', 'high', 'max', 'xhigh'],
      reasoningEffortFormat: 'chat-completions',
      ...(keyHeader === undefined ? {} : { requestHeaders: { 'x-cannbot-key': keyHeader } }),
    })),
  }
}

/** Replace our group in place (keeping its position) or append it. */
function mergeGroup(groups, group) {
  const index = groups.findIndex(
    (entry) => entry !== null && typeof entry === 'object' && entry.name === GROUP_NAME && entry.vendor === VENDOR,
  )
  if (index === -1) return [...groups, group]
  const next = [...groups]
  next[index] = group
  return next
}

async function main() {
  const flags = parseArgs(process.argv.slice(2))
  const baseURL = String(flags['base-url'] ?? process.env.CANNBOT_LOCAL_URL ?? DEFAULT_BASE_URL)
  // A key is optional: the service only enforces one when started with `--key`,
  // and when it is, VS Code cannot hold it as an `apiKey` (see buildGroup), so it
  // rides a custom request header instead.
  const key = flags.key === undefined ? undefined : String(flags.key)
  const dryRun = flags['dry-run'] !== undefined
  const file = resolveConfigPath(flags['user-dir'])

  if (flags.help !== undefined) {
    process.stdout.write(`Usage: node scripts/install-vscode.mjs [options]

  --base-url <url>   local CANNBOT service base URL (default ${DEFAULT_BASE_URL})
  --key <token>      local service key; written as a model request header (only
                     needed when the service is started with the same --key)
  --user-dir <dir>   VS Code (or Cursor) "User" directory to write into
  --dry-run          print the merged file instead of writing it
  --help             show this help
`)
    return
  }

  const { models, source } = await loadModels(baseURL)
  if (models.length === 0) {
    throw new Error(
      'no models available: start the local service (node lib/local-server.js) or sign in to CANNWork so the account roster can be read',
    )
  }
  process.stdout.write(`models: ${models.length} (from ${source})\n`)

  const existing = readExisting(file)
  const merged = mergeGroup(existing, buildGroup(models, { baseURL, keyHeader: key }))
  const text = `${JSON.stringify(merged, null, '\t')}\n`

  if (dryRun) {
    process.stdout.write(`${file}\n${text}`)
    return
  }

  mkdirSync(dirname(file), { recursive: true })
  if (existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backup = `${file}.bak-${stamp}`
    copyFileSync(file, backup)
    process.stdout.write(`backup: ${backup}\n`)
  }
  writeFileSync(file, text, { mode: 0o600 })
  // The mode argument only applies when the file is created; an existing config
  // keeps VSCode's 0644 unless it is tightened here (it may carry a local key).
  chmodSync(file, 0o600)

  // Never leave a file the editor cannot read: parse what was actually written.
  try {
    JSON.parse(readFileSync(file, 'utf-8'))
  } catch (error) {
    throw new Error(`the written file is not valid JSON (${error.message}) — restore the backup above`)
  }

  process.stdout.write(`wrote: ${file}\n`)
  process.stdout.write(`group: ${GROUP_NAME} (${VENDOR}) → ${endpointBase(baseURL)}/v1\n`)
  process.stdout.write('next: reload the VS Code window, then open Chat → model picker → CANNBOT\n')
}

main().catch((error) => {
  process.stderr.write(`${error?.message ?? error}\n`)
  process.exit(1)
})
