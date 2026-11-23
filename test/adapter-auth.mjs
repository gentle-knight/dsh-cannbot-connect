/**
 * Offline regression for credential selection and gateway refusal mapping.
 *
 * The gateway answers "your token is stale" and "this model is not in your
 * roster" with the same 403, so the adapter cannot classify on status alone:
 * only a body that names a model is a model-selection failure, and everything
 * else must stay AUTH or a real credential problem would be reported as a
 * mistyped model id.
 *
 * The same roster rows also carry the VK each model expects, and a builtin
 * row's key is not the account-level one, so the request path must prefer the
 * row's key and only fall back to CANNWork's `auth.json` key.
 *
 * Everything here runs offline: a local HTTP server stands in for the gateway
 * and a throwaway `XDG_DATA_HOME` stands in for the CANNWork sign-in.
 *
 * Run with `npm test`. Exits 0 when every check passes, 1 otherwise.
 */
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CannbotAdapter, PROVIDER, fetchCatalog } from '../lib/index.js'

const JWT = 'test-jwt-0123456789abcdef'
const ACCOUNT_VK = 'vk-account-0123456789'
const PERSONAL_VK = 'vk-personal-0123456789'
const BUILTIN_VK = 'vk-builtin-0123456789'

const ROSTER = {
  success: true,
  data: {
    personalModels: [
      {
        model: 'model-personal',
        title: 'Model Personal',
        apiKey: PERSONAL_VK,
        contextLength: 1_000,
        completionOptions: { maxTokens: 100 },
      },
      { model: 'model-no-key', title: 'Model Without Key', contextLength: 2_000 },
    ],
    builtinModels: [
      {
        model: 'model-builtin-only',
        title: 'Model Builtin Only',
        apiKey: BUILTIN_VK,
        contextLength: 3_000,
        completionOptions: { maxTokens: 300 },
      },
    ],
  },
}

let failures = 0
const fail = (message) => {
  console.error(`FAIL: ${message}`)
  failures += 1
}
const ok = (message) => console.log(`ok   ${message}`)

/** Assert one value and label the check. */
const eq = (label, actual, expected) => {
  if (Object.is(actual, expected)) ok(`${label} = ${JSON.stringify(actual)}`)
  else fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

/**
 * Point the adapter's per-request credential reads at throwaway files.
 *
 * `readJwt()`/`readAccountVk()` resolve `$XDG_DATA_HOME/opencode` on every
 * call, so a process-local override never touches the real CANNWork state.
 */
function isolateCredentials() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-cannbot-auth-'))
  const dir = join(home, 'opencode')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.json'), JSON.stringify({ accessToken: JWT }))
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({ cannbot: { key: ACCOUNT_VK } }))
  process.env.XDG_DATA_HOME = home
  process.env.XDG_CONFIG_HOME = join(home, 'config-empty')
  return () => rmSync(home, { recursive: true, force: true })
}

/** One SSE frame carrying `payload`. */
const frame = (payload) => `data: ${JSON.stringify(payload)}\n\n`

/**
 * Start one mock gateway for the duration of `fn`.
 *
 * `handler` receives `(req, res, body)` where `body` is the drained request
 * text, so a test can answer a normal stream or a provider failure. The
 * callback also records every request for later assertions.
 */
async function withServer(handler, fn) {
  const requests = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push({ method: req.method, url: req.url, headers: req.headers, body })
    handler(req, res, body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    return await fn({
      baseURL: `http://127.0.0.1:${port}/v1`,
      modelsURL: `http://127.0.0.1:${port}/models`,
      requests,
    })
  } finally {
    await new Promise((resolve) => {
      server.closeAllConnections?.()
      server.close(resolve)
    })
  }
}

/** Answer the catalog endpoint; leave chat requests to `onChat`. */
function gateway({ onChat } = {}) {
  return (req, res, body) => {
    if (req.method === 'GET' && req.url === '/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(ROSTER))
      return
    }
    if (onChat !== undefined) {
      onChat(req, res, body)
      return
    }
    const base = { id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1_700_000_000, model: 'mock' }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(frame({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'pong' } }] }))
    res.write(frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))
    res.write('data: [DONE]\n\n')
    res.end()
  }
}

/** Answer one chat request with a provider failure. */
const refuseWith = (status, payload) => (req, res) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

const adapterFor = ({ baseURL, modelsURL }) =>
  new CannbotAdapter({
    baseURL,
    modelsURL,
    streamIdleTimeoutMs: 5_000,
    defaultContextWindow: 8_192,
    defaultMaxTokens: 1_024,
  })

/** Stream one turn, returning the chunks it produced. */
async function runTurn(adapter, model) {
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: PROVIDER,
    model,
    messages: [{ id: 'msg_test', role: 'user', content: [{ type: 'text', text: 'ping' }] }],
  })) {
    chunks.push(chunk)
  }
  return chunks
}

/** Run one turn expected to fail and return the thrown error. */
async function runTurnError(adapter, model) {
  try {
    await runTurn(adapter, model)
  } catch (error) {
    return error
  }
  throw new Error(`expected model ${model} to fail, but the turn succeeded`)
}

async function main() {
  const cleanup = isolateCredentials()
  try {
    // ── 1. The catalog keeps each row's VK ─────────────────────────────────
    const catalogChecks = await withServer(gateway(), async ({ modelsURL, requests }) => {
      const result = await fetchCatalog({ modelsURL })
      if (!result.ok) throw new Error(`catalog fetch failed: ${result.reason}`)
      eq('catalog: request carried the account JWT', requests[0]?.headers.authorization, `Bearer ${JWT}`)
      const byId = new Map(result.catalog.map((entry) => [entry.id, entry]))
      eq('catalog: personal row keeps its own VK', byId.get('model-personal')?.vk, PERSONAL_VK)
      eq('catalog: builtin-only row keeps its own VK', byId.get('model-builtin-only')?.vk, BUILTIN_VK)
      eq('catalog: row without apiKey has no VK', byId.get('model-no-key')?.vk, undefined)
      return result.catalog
    })

    // ── 2. The request path prefers the model row's VK ─────────────────────
    await withServer(gateway(), async ({ baseURL, requests }) => {
      const adapter = adapterFor({ baseURL, modelsURL: `${baseURL}/models` })
      adapter.adoptCatalog(catalogChecks)
      await runTurn(adapter, 'model-personal')
      const chat = requests.find((request) => request.url === '/v1/chat/completions')
      eq('personal model: x-api-vkey is the row VK', chat?.headers['x-api-vkey'], PERSONAL_VK)
      eq('personal model: api-key mirrors the row VK', chat?.headers['api-key'], PERSONAL_VK)
      eq('personal model: Authorization stays the account JWT', chat?.headers.authorization, `Bearer ${JWT}`)
      eq('personal model: request body names the model', JSON.parse(chat.body).model, 'model-personal')
    })

    await withServer(gateway(), async ({ baseURL, requests }) => {
      const adapter = adapterFor({ baseURL, modelsURL: `${baseURL}/models` })
      adapter.adoptCatalog(catalogChecks)
      await runTurn(adapter, 'model-builtin-only')
      const chat = requests.find((request) => request.url === '/v1/chat/completions')
      eq('builtin-only model: x-api-vkey is the row VK', chat?.headers['x-api-vkey'], BUILTIN_VK)
    })

    await withServer(gateway(), async ({ baseURL, requests }) => {
      const adapter = adapterFor({ baseURL, modelsURL: `${baseURL}/models` })
      adapter.adoptCatalog(catalogChecks)
      await runTurn(adapter, 'model-no-key')
      const chat = requests.find((request) => request.url === '/v1/chat/completions')
      eq('row without VK: falls back to the account VK', chat?.headers['x-api-vkey'], ACCOUNT_VK)
    })

    await withServer(gateway(), async ({ baseURL, requests }) => {
      const adapter = adapterFor({ baseURL, modelsURL: `${baseURL}/models` })
      // No catalog adopted: the fallback model must still use the account VK.
      await runTurn(adapter, 'deepseek-v4.1-flash')
      const chat = requests.find((request) => request.url === '/v1/chat/completions')
      eq('fallback catalog: uses the account VK', chat?.headers['x-api-vkey'], ACCOUNT_VK)
    })

    // ── 3. 403 naming a model is an entitlement failure, not AUTH ──────────
    await withServer(
      gateway({ onChat: refuseWith(403, { message: 'Model no-such-model not allowed' }) }),
      async ({ baseURL }) => {
        const adapter = adapterFor({ baseURL, modelsURL: `${baseURL}/models` })
        const error = await runTurnError(adapter, 'no-such-model')
        eq('403 model refusal: code', error.code, 'MODEL_UNSUPPORTED')
        eq('403 model refusal: does not tell the user to sign in', /sign in/i.test(error.message), false)
        eq('403 model refusal: keeps the provider status fact', error.failure?.status, 403)
        eq('403 model refusal: message names the model verdict', /does not allow this model/.test(error.message), true)
      },
    )

    // ── 4. A 403 that is not about a model stays a credential failure ──────
    await withServer(
      gateway({ onChat: refuseWith(403, { message: 'forbidden by gateway policy' }) }),
      async ({ baseURL }) => {
        const adapter = adapterFor({ baseURL, modelsURL: `${baseURL}/models` })
        const error = await runTurnError(adapter, 'model-personal')
        eq('403 without a model: code stays AUTH', error.code, 'AUTH')
        eq('403 without a model: asks for a new sign-in', /sign in with CANNWork/.test(error.message), true)
      },
    )

    // ── 5. 401 is always AUTH, even if the body mentions a model ───────────
    await withServer(
      gateway({ onChat: refuseWith(401, { message: 'Model x requires an Access Token' }) }),
      async ({ baseURL }) => {
        const adapter = adapterFor({ baseURL, modelsURL: `${baseURL}/models` })
        const error = await runTurnError(adapter, 'model-personal')
        eq('401: code stays AUTH', error.code, 'AUTH')
      },
    )

    // ── 6. A refusal body that echoes a credential is redacted ─────────────
    await withServer(
      gateway({ onChat: refuseWith(403, { message: `Model x not allowed for ${PERSONAL_VK}` }) }),
      async ({ baseURL }) => {
        const adapter = adapterFor({ baseURL, modelsURL: `${baseURL}/models` })
        // Adopt the roster so this request really sends the row VK; redaction is
        // by the exact values sent, so the echoed credential must be that one.
        adapter.adoptCatalog(catalogChecks)
        const error = await runTurnError(adapter, 'model-personal')
        eq('403 model refusal: code', error.code, 'MODEL_UNSUPPORTED')
        eq('403 model refusal: echoed VK is redacted', error.message.includes(PERSONAL_VK), false)
        eq('403 model refusal: redaction marker present', /\[redacted\]/.test(error.message), true)
      },
    )
    // ── 7. Missing and malformed credentials are classified apart ──────────
    //
    // DSH 0.2.3-alpha removed `assertUsableApiKey` from `dsh-llm`, and the 0.2.2
    // line does not have its replacement (`normalizeApiKey`) in
    // `dsh-credentials`. The plugin therefore owns these rules; this block pins
    // them so a future host change cannot silently turn a malformed credential
    // into a missing one (or leak an unusable value into a header).

    /** Re-point credential reads at one throwaway pair of files. */
    const withCredentials = async ({ jwt, vk }, fn) => {
      const home = mkdtempSync(join(tmpdir(), 'dsh-cannbot-auth-case-'))
      const dir = join(home, 'opencode')
      mkdirSync(dir, { recursive: true })
      if (jwt !== undefined) writeFileSync(join(dir, 'session.json'), JSON.stringify({ accessToken: jwt }))
      if (vk !== undefined) writeFileSync(join(dir, 'auth.json'), JSON.stringify({ cannbot: { key: vk } }))
      process.env.XDG_DATA_HOME = home
      process.env.XDG_CONFIG_HOME = join(home, 'config-empty')
      try {
        return await fn()
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    }

    const expectCredentialError = async ({ jwt, vk }, expectedCode, label) => {
      await withCredentials({ jwt, vk }, async () => {
        await withServer(gateway(), async ({ baseURL, requests }) => {
          const adapter = adapterFor({ baseURL, modelsURL: `${baseURL}/models` })
          const error = await runTurnError(adapter, 'model-personal')
          eq(`${label}: code`, error.code, expectedCode)
          eq(`${label}: no request was sent`, requests.length, 0)
        })
      })
    }

    await expectCredentialError({ vk: ACCOUNT_VK }, 'MISSING_CREDENTIAL', 'missing JWT')
    await expectCredentialError({ jwt: '   ', vk: ACCOUNT_VK }, 'MISSING_CREDENTIAL', 'blank JWT')
    await expectCredentialError(
      { jwt: `${JWT.slice(0, 5)}\n${JWT.slice(5)}`, vk: ACCOUNT_VK },
      'INVALID_CREDENTIAL',
      'JWT with an embedded newline',
    )
    await expectCredentialError({ jwt: `abc${'\t'}def`, vk: ACCOUNT_VK }, 'INVALID_CREDENTIAL', 'JWT with a tab')
    await expectCredentialError({ jwt: JWT }, 'MISSING_CREDENTIAL', 'missing VK')
    await expectCredentialError({ jwt: JWT, vk: '  ' }, 'MISSING_CREDENTIAL', 'blank VK')
    await expectCredentialError({ jwt: JWT, vk: 'vk has space' }, 'INVALID_CREDENTIAL', 'VK with space')
    await expectCredentialError({ jwt: JWT, vk: 'vk-非ascii' }, 'INVALID_CREDENTIAL', 'VK with non-ASCII')

    // A padded but otherwise legal JWT is trimmed and sent, not rejected.
    await withCredentials({ jwt: `  ${JWT}  `, vk: ACCOUNT_VK }, async () => {
      await withServer(gateway(), async ({ baseURL, requests }) => {
        const adapter = adapterFor({ baseURL, modelsURL: `${baseURL}/models` })
        await runTurn(adapter, 'model-personal')
        const chat = requests.find((request) => request.url === '/v1/chat/completions')
        eq('padded JWT: header carries the trimmed value', chat?.headers.authorization, `Bearer ${JWT}`)
      })
    })
  } finally {
    cleanup()
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed.`)
    process.exit(1)
  }
  console.log('\nPASS: credential selection and 403 classification hold.')
  process.exit(0)
}

await main()
