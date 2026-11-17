/**
 * Offline checks for the CANNBOT **local model service** (`lib/local-server.js`).
 *
 * These run without the live gateway and without touching CANNWork: a mock
 * upstream stands in for the gateway, and credentials are injected through the
 * test-only `credentials` option. They assert the properties that make the
 * service usable from an editor sidebar:
 *
 *   1. the OpenAI surface a client sees (model list, streaming and buffered chat
 *      completions, tool calls, usage) is what the gateway actually said;
 *   2. the VK and JWT are attached to every upstream call and to none of the
 *      replies, and provider failure text is redacted;
 *   3. the service refuses a non-loopback plaintext gateway and a non-loopback
 *      bind (both are server configuration, not client input), and enforces the
 *      optional local key;
 *   4. a truncated or mis-framed upstream is reported instead of being passed
 *      off as a complete answer, and no browser origin is given CORS access.
 *
 * Run with `npm test`. Exits 0 when every check passes, 1 otherwise.
 */
import { createServer } from 'node:http'
import { startLocalServer } from '../lib/local-server.js'

const JWT = 'test-jwt-0123456789abcdef'
const VK = 'test-vk-0123456789abcdef'
// The catalog row's own VK; builtin models issue a different key from the
// account-level one, so the service must prefer it for that model.
const ROW_VK = 'test-vk-row-0123456789abcdef'

let failures = 0
const fail = (message) => {
  console.error(`FAIL: ${message}`)
  failures += 1
}
const ok = (message) => console.log(`ok   ${message}`)

/** Every body a client received, so a credential leak is caught wherever it happens. */
const clientBodies = []

/** Collect one response body as text. */
async function text(response) {
  try {
    const body = await response.text()
    clientBodies.push(body)
    return body
  } catch (error) {
    throw new Error(`${response.url} body failed: ${error.message} | cause=${error.cause?.message ?? error.cause}`)
  }
}

/** POST JSON and parse the JSON reply. */
async function postJson(url, payload, headers = {}) {
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(payload),
    })
  } catch (error) {
    throw new Error(`POST ${url} failed: ${error.message} | cause=${error.cause?.message ?? error.cause}`)
  }
  const body = await text(response)
  return { status: response.status, headers: response.headers, json: JSON.parse(body) }
}

// ── mock upstream gateway ────────────────────────────────────────────────────

/**
 * A minimal stand-in for the CANNBOT gateway: one catalog endpoint and one
 * chat-completions endpoint that speaks the same SSE dialect the real gateway
 * does (reasoning deltas, text deltas, tool-call deltas, usage, `[DONE]`).
 */
async function startMockGateway() {
  const state = { fail: undefined, mode: undefined, finish: undefined, chatCalls: [] }
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/mock/api/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          success: true,
          data: {
            personalModels: [
              {
                model: 'mock-model',
                title: 'Mock Model',
                contextLength: 4096,
                completionOptions: { maxTokens: 512 },
              },
            ],
            // Overlaps `mock-model` on purpose: the service de-duplicates.
            builtinModels: [
              { model: 'mock-model', title: 'Mock Model (builtin)', contextLength: 4096 },
              { model: 'builtin-only', title: 'Builtin Only', contextLength: 2048, apiKey: ROW_VK },
            ],
          },
        }),
      )
      return
    }

    if (req.method === 'POST' && req.url === '/mock/v1/chat/completions') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
      state.chatCalls.push({ headers: req.headers, body })

      if (state.fail !== undefined) {
        res.writeHead(state.fail.status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: state.fail.body, code: state.fail.code } }))
        return
      }

      const frame = (payload) => `data: ${JSON.stringify(payload)}\n\n`
      const base = { id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1_700_000_000, model: 'mock-model' }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })

      // Deliberately broken streams: a half answer with no finish_reason and no
      // terminator, a final frame with no trailing blank line, and an error the
      // gateway chose to frame as data.
      if (state.mode === 'truncate') {
        res.write(frame({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'half an ans' } }] }))
        res.end()
        return
      }
      if (state.mode === 'unterminated') {
        res.write(
          `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: 'Hel' }, finish_reason: 'stop' }] })}`,
        )
        res.end()
        return
      }
      if (state.mode === 'instream-error') {
        res.write(`data: ${JSON.stringify({ error: { message: `bad token ${JWT} and vk ${VK}` } })}\n\n`)
        res.end()
        return
      }

      res.write(frame({ ...base, choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'thinking' } }] }))
      res.write(frame({ ...base, choices: [{ index: 0, delta: { content: 'Hel' } }] }))
      res.write(frame({ ...base, choices: [{ index: 0, delta: { content: 'lo' } }] }))
      res.write(
        frame({
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":' } },
                ],
              },
            },
          ],
        }),
      )
      res.write(
        frame({
          ...base,
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Beijing"}' } }] } }],
        }),
      )
      res.write(
        frame({
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: state.finish ?? 'tool_calls' }],
          usage: {
            prompt_tokens: 5,
            completion_tokens: 7,
            total_tokens: 12,
            prompt_tokens_details: { cached_tokens: 3 },
          },
        }),
      )
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }

    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    state,
    baseURL: `http://127.0.0.1:${port}/mock/v1`,
    modelsURL: `http://127.0.0.1:${port}/mock/api/models`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      }),
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Start the service against the mock, quiet, on an ephemeral port. */
function serve(mock, options = {}) {
  return startLocalServer({
    baseURL: mock.baseURL,
    modelsURL: mock.modelsURL,
    credentials: { jwt: JWT, vk: VK },
    quiet: true,
    log: () => {},
    port: 0,
    ...options,
  })
}

async function expectThrowAsync(label, fn) {
  try {
    await fn()
    fail(`${label}: expected a refusal, got none`)
  } catch {
    ok(label)
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const mock = await startMockGateway()

  // ── 1. model list ─────────────────────────────────────────────────────────
  const service = await serve(mock)
  try {
    const response = await fetch(`${service.url}/v1/models`)
    const body = JSON.parse(await text(response))
    const ids = (body.data ?? []).map((model) => model.id)
    if (response.status !== 200) fail(`GET /v1/models answered ${response.status}`)
    else if (body.object !== 'list') fail('GET /v1/models did not return an OpenAI list')
    else if (JSON.stringify(ids) !== JSON.stringify(['mock-model', 'builtin-only'])) {
      fail(`model list was ${JSON.stringify(ids)}, expected the de-duplicated personal-first roster`)
    } else ok('model list is served in the OpenAI shape, personal rows first and de-duplicated')

    // ── 2. streaming turn ───────────────────────────────────────────────────
    const streamed = await fetch(`${service.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mock-model',
        stream: true,
        // Fields a real sidebar sends that the gateway must not see.
        store: false,
        metadata: { channel: 'vscode' },
        max_completion_tokens: 256,
        reasoning_effort: 'off',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      }),
    })
    const streamText = await text(streamed)
    if (streamed.status !== 200) fail(`streaming turn answered ${streamed.status}`)
    else if (!String(streamed.headers.get('content-type')).startsWith('text/event-stream')) {
      fail(`streaming turn content-type was ${streamed.headers.get('content-type')}`)
    } else if (!streamText.includes('"reasoning_content":"thinking"') || !streamText.includes('"content":"Hel"')) {
      fail('streaming turn did not pass the upstream deltas through')
    } else if (!streamText.includes('data: [DONE]')) {
      fail('streaming turn did not terminate with [DONE]')
    } else if (!streamText.includes('"prompt_tokens_details":{"cached_tokens":3}')) {
      fail('streaming turn dropped the provider cache detail (it must stay OpenAI-shaped, not be remapped)')
    } else ok('streaming turn passes the gateway SSE through byte for byte')

    const call = mock.state.chatCalls.at(-1)
    const sent = call.body
    if (sent.model !== 'mock-model') fail(`upstream model was ${JSON.stringify(sent.model)}`)
    else if (sent.stream !== true) fail('upstream was not asked to stream')
    else if (sent.stream_options?.include_usage !== true) fail('upstream did not ask for usage')
    else if ('store' in sent || 'metadata' in sent) fail('client-only fields were forwarded to the gateway')
    else if (sent.max_tokens !== 256 || 'max_completion_tokens' in sent) {
      fail(`max_completion_tokens was not renamed (max_tokens=${JSON.stringify(sent.max_tokens)})`)
    } else if ('reasoning_effort' in sent) fail('an unsupported reasoning effort reached the gateway')
    else if (sent.messages?.[0]?.content !== 'hi') fail('content parts were not flattened to text')
    else ok('request is sanitised: whitelisted fields only, max_completion_tokens renamed, invalid effort dropped')

    const headers = call.headers
    if (headers.authorization !== `Bearer ${JWT}`) fail('the JWT was not attached as a Bearer token')
    else if (headers['x-api-vkey'] !== VK || headers['api-key'] !== VK) fail('the VK was not attached')
    else ok('both credentials are attached to the upstream request')

    // ── 2b. a catalog row's own VK is preferred for that model ─────────────
    const rowTurn = await postJson(`${service.url}/v1/chat/completions`, {
      model: 'builtin-only',
      messages: [{ role: 'user', content: 'hi' }],
    })
    const rowCall = mock.state.chatCalls.at(-1)
    if (rowTurn.status !== 200) fail(`a row-VK model answered ${rowTurn.status}`)
    else if (rowCall?.headers['x-api-vkey'] !== ROW_VK || rowCall?.headers['api-key'] !== ROW_VK) {
      fail('the catalog row VK was not preferred over the account VK')
    } else if (rowCall?.headers.authorization !== `Bearer ${JWT}`) {
      fail('the row-VK request lost the JWT')
    } else if (rowCall?.body?.model !== 'builtin-only') {
      fail(`the row-VK request resolved to ${JSON.stringify(rowCall?.body?.model)}`)
    } else ok('the catalog row VK is preferred for that model')

    // ── 3. buffered (non-streaming) turn ────────────────────────────────────
    const buffered = await postJson(`${service.url}/v1/chat/completions`, {
      model: 'mock-model',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    })
    const choice = buffered.json?.choices?.[0]
    if (buffered.status !== 200) fail(`buffered turn answered ${buffered.status}`)
    else if (buffered.json?.object !== 'chat.completion') fail('buffered turn was not a chat.completion object')
    else if (choice?.message?.content !== 'Hello') fail(`buffered content was ${JSON.stringify(choice?.message?.content)}`)
    else if (choice?.message?.reasoning_content !== 'thinking') fail('buffered reasoning was dropped')
    else if (choice?.finish_reason !== 'tool_calls') fail(`buffered finish_reason was ${choice?.finish_reason}`)
    else if (choice?.message?.tool_calls?.[0]?.function?.arguments !== '{"city":"Beijing"}') {
      fail('buffered tool call was not reassembled')
    } else if (buffered.json?.usage?.total_tokens !== 12) fail('buffered usage was dropped')
    else if (buffered.json?.usage?.prompt_tokens_details?.cached_tokens !== 3) {
      fail('buffered usage dropped the provider cache detail')
    } else ok('buffered turn aggregates the same stream into one chat.completion with tools and usage')

    // ── 4. model aliases ────────────────────────────────────────────────────
    const callsBeforeAlias = mock.state.chatCalls.length
    const aliasByName = await postJson(`${service.url}/v1/chat/completions`, {
      model: 'Mock Model',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    })
    const byName = mock.state.chatCalls.at(-1)?.body.model
    const aliasByPrefix = await postJson(`${service.url}/v1/chat/completions`, {
      model: 'cannbot/mock-model',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    })
    const byPrefix = mock.state.chatCalls.at(-1)?.body.model
    if (mock.state.chatCalls.length !== callsBeforeAlias + 2) fail('an alias request never reached the gateway')
    else if (aliasByName.status !== 200 || aliasByPrefix.status !== 200) {
      fail(`an alias request failed (${aliasByName.status}/${aliasByPrefix.status})`)
    } else if (byName !== 'mock-model') fail(`display-name alias resolved to ${JSON.stringify(byName)}`)
    else if (byPrefix !== 'mock-model') fail(`provider-prefixed id resolved to ${JSON.stringify(byPrefix)}`)
    else ok('display names and provider-prefixed ids resolve to the gateway model id')

    // ── 5. upstream failure mapping + redaction ─────────────────────────────
    mock.state.fail = { status: 401, body: `token ${JWT} and key ${VK} rejected` }
    const unauthorized = await postJson(`${service.url}/v1/chat/completions`, {
      model: 'mock-model',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    })
    mock.state.fail = undefined
    if (unauthorized.status !== 401) fail(`upstream 401 was mapped to ${unauthorized.status}`)
    else if (unauthorized.json?.error?.type !== 'authentication_error') fail('upstream 401 lost its error type')
    else if (String(unauthorized.json?.error?.message).includes(JWT) || String(unauthorized.json?.error?.message).includes(VK)) {
      fail('provider failure text still carried a credential')
    } else ok('upstream failures become OpenAI error envelopes with the credentials redacted')

    // ── 5b. an unknown model id is a request error, not an auth error ───────
    mock.state.fail = { status: 403, body: '{"message":"Model deepseek-old not allowed"}' }
    const unknownModel = await postJson(`${service.url}/v1/chat/completions`, {
      model: 'deepseek-old',
      messages: [{ role: 'user', content: 'hi' }],
    })
    mock.state.fail = undefined
    if (unknownModel.status !== 400) fail(`an unknown model answered ${unknownModel.status}, expected 400`)
    else if (unknownModel.json?.error?.type !== 'invalid_request_error') fail('an unknown model lost its request-error type')
    else if (unknownModel.json?.error?.code !== 'MODEL_UNSUPPORTED') {
      fail(`an unknown model was classified as ${JSON.stringify(unknownModel.json?.error?.code)}`)
    } else if (!String(unknownModel.json?.error?.message).includes('does not allow this model')) {
      fail('an unknown model did not explain the refusal')
    } else ok('an unknown model id maps to MODEL_UNSUPPORTED instead of a sign-in error')

    // ── 6. missing credentials ──────────────────────────────────────────────
    // Both roots must be neutralised: the VK normally lives in the config dir,
    // so hiding only the data dir could still find the real sign-in.
    const savedXdg = { data: process.env.XDG_DATA_HOME, config: process.env.XDG_CONFIG_HOME }
    process.env.XDG_DATA_HOME = '/nonexistent-dsh-cannbot-test/data'
    process.env.XDG_CONFIG_HOME = '/nonexistent-dsh-cannbot-test/config'
    const anonymous = await startLocalServer({
      baseURL: mock.baseURL,
      modelsURL: mock.modelsURL,
      quiet: true,
      log: () => {},
      port: 0,
    })
    try {
      const denied = await postJson(`${anonymous.url}/v1/chat/completions`, {
        model: 'mock-model',
        messages: [{ role: 'user', content: 'hi' }],
      })
      if (denied.status !== 401) fail(`a missing credential answered ${denied.status}`)
      else if (!String(denied.json?.error?.message).includes('CANNWork')) fail('the missing-credential hint is not actionable')
      else ok('a missing CANNWork sign-in is refused with an actionable 401')
    } finally {
      await anonymous.close()
      if (savedXdg.data === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = savedXdg.data
      if (savedXdg.config === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = savedXdg.config
    }

    // ── 7. local client key ─────────────────────────────────────────────────
    const keyed = await serve(mock, { apiKey: 'local-key-123' })
    try {
      const noKey = await postJson(`${keyed.url}/v1/chat/completions`, {
        model: 'mock-model',
        messages: [{ role: 'user', content: 'hi' }],
      })
      const withKey = await postJson(
        `${keyed.url}/v1/chat/completions`,
        { model: 'mock-model', messages: [{ role: 'user', content: 'hi' }] },
        { Authorization: 'Bearer local-key-123' },
      )
      // VS Code's chat config cannot hold a plaintext secret, so the installer
      // passes the key as a model request header instead.
      const withHeaderKey = await postJson(
        `${keyed.url}/v1/chat/completions`,
        { model: 'mock-model', messages: [{ role: 'user', content: 'hi' }] },
        { 'x-cannbot-key': 'local-key-123' },
      )
      if (noKey.status !== 401) fail(`an unkeyed client was allowed (${noKey.status})`)
      else if (withKey.status !== 200) fail(`a keyed client was refused (${withKey.status})`)
      else if (withHeaderKey.status !== 200) fail(`the x-cannbot-key header was not honoured (${withHeaderKey.status})`)
      else ok('an optional local key is enforced on every proxied request (Bearer and x-cannbot-key)')
    } finally {
      await keyed.close()
    }

    // ── 8. routing + banner + credential exposure ───────────────────────────
    const missing = await fetch(`${service.url}/v1/nope`)
    await text(missing)
    const banner = await fetch(`${service.url}/healthz`)
    const bannerJson = JSON.parse(await text(banner))
    if (missing.status !== 404) fail(`an unknown route answered ${missing.status}`)
    else if (bannerJson.jwt !== 'present' || bannerJson.vk !== 'present') fail('the banner does not report credential presence')
    else if (!Array.isArray(bannerJson.models) || !bannerJson.models.includes('mock-model')) {
      fail('the banner does not list the catalog')
    } else ok('unknown routes 404 and the banner reports credential presence without printing values')

    // ── 9b. regressions: stream truncation, tail frames, redaction, CORS ─────
  // A cut-off upstream must not look like a finished answer.
  mock.state.mode = 'truncate'
  const truncated = await postJson(`${service.url}/v1/chat/completions`, {
    model: 'mock-model',
    stream: false,
    messages: [{ role: 'user', content: 'hi' }],
  })
  if (truncated.status !== 502) fail(`a truncated upstream answered ${truncated.status}, expected 502`)
  else ok('a stream that dies without finish_reason/[DONE] is reported, not passed off as complete')

  // A final frame with no trailing blank line must still be consumed.
  mock.state.mode = 'unterminated'
  const unterminated = await postJson(`${service.url}/v1/chat/completions`, {
    model: 'mock-model',
    stream: false,
    messages: [{ role: 'user', content: 'hi' }],
  })
  mock.state.mode = undefined
  if (unterminated.json?.choices?.[0]?.message?.content !== 'Hel') {
    fail(`the unterminated tail frame was dropped (content ${JSON.stringify(unterminated.json?.choices?.[0]?.message?.content)})`)
  } else ok('a final frame without a trailing blank line is still consumed')

  // An upstream error framed as SSE data must be redacted like any other.
  mock.state.mode = 'instream-error'
  const inStreamError = await postJson(`${service.url}/v1/chat/completions`, {
    model: 'mock-model',
    stream: false,
    messages: [{ role: 'user', content: 'hi' }],
  })
  mock.state.mode = undefined
  const inStreamMessage = String(inStreamError.json?.error?.message ?? '')
  if (inStreamError.status !== 400) fail(`an in-stream error answered ${inStreamError.status}`)
  else if (inStreamMessage.includes(JWT) || inStreamMessage.includes(VK)) {
    fail('an in-stream error leaked credential material into the client body')
  } else if (!inStreamMessage.includes('[redacted]')) fail('an in-stream error was not redacted')
  else ok('an in-stream gateway error is redacted before it reaches the client')

  // The provider's own finish_reason must survive.
  mock.state.finish = 'content_filter'
  const filtered = await postJson(`${service.url}/v1/chat/completions`, {
    model: 'mock-model',
    stream: false,
    messages: [{ role: 'user', content: 'hi' }],
  })
  mock.state.finish = undefined
  if (filtered.json?.choices?.[0]?.finish_reason !== 'content_filter') {
    fail(`finish_reason was rewritten to ${filtered.json?.choices?.[0]?.finish_reason}`)
  } else ok("the provider's finish_reason is passed through instead of being normalised")

  // Fields a JSON-mode client relies on must reach the gateway.
  const forwarded = await postJson(`${service.url}/v1/chat/completions`, {
    model: 'mock-model',
    stream: false,
    response_format: { type: 'json_object' },
    parallel_tool_calls: false,
    stop: ['\n\n'],
    messages: [{ role: 'user', content: 'hi' }],
  })
  const forwardedBody = mock.state.chatCalls.at(-1)?.body ?? {}
  if (forwarded.status !== 200) fail(`a JSON-mode request answered ${forwarded.status}`)
  else if (forwardedBody.response_format?.type !== 'json_object') fail('response_format was dropped')
  else if (forwardedBody.parallel_tool_calls !== false) fail('parallel_tool_calls was dropped')
  else if (!Array.isArray(forwardedBody.stop)) fail('stop was dropped')
  else ok('response_format / parallel_tool_calls / stop reach the gateway')

  // n > 1 is refused up front instead of silently returning one choice.
  const callsBeforeN = mock.state.chatCalls.length
  const multiChoice = await postJson(`${service.url}/v1/chat/completions`, {
    model: 'mock-model',
    n: 2,
    messages: [{ role: 'user', content: 'hi' }],
  })
  if (multiChoice.status !== 400) fail(`n=2 answered ${multiChoice.status}`)
  else if (mock.state.chatCalls.length !== callsBeforeN) fail('n=2 was forwarded to the gateway')
  else ok('n > 1 is refused with a clear 400 instead of being silently ignored')

  // A single content object must not become "[object Object]".
  await postJson(`${service.url}/v1/chat/completions`, {
    model: 'mock-model',
    stream: false,
    messages: [{ role: 'user', content: { type: 'text', text: 'object form' } }],
  })
  if (mock.state.chatCalls.at(-1)?.body.messages?.[0]?.content !== 'object form') {
    fail(`a single content object became ${JSON.stringify(mock.state.chatCalls.at(-1)?.body.messages?.[0]?.content)}`)
  } else ok('a single content object is flattened to its text')

  // A tool result without its id cannot be replayed; say so clearly.
  const orphanTool = await postJson(`${service.url}/v1/chat/completions`, {
    model: 'mock-model',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'tool', content: 'no id here' },
    ],
  })
  if (orphanTool.status !== 400) fail(`a tool message without tool_call_id answered ${orphanTool.status}`)
  else ok('a tool message without tool_call_id is refused with a clear 400')

  // No CORS: a browser must not be able to drive this endpoint.
  const corsProbe = await fetch(`${service.url}/v1/models`)
  await text(corsProbe)
  const preflight = await fetch(`${service.url}/v1/chat/completions`, { method: 'OPTIONS' })
  await text(preflight)
  if (corsProbe.headers.get('access-control-allow-origin') !== null) {
    fail('GET /v1/models answered with Access-Control-Allow-Origin')
  } else if (preflight.headers.get('access-control-allow-origin') !== null) {
    fail('the OPTIONS preflight answered with Access-Control-Allow-Origin')
  } else if (preflight.status !== 204) fail(`the OPTIONS preflight answered ${preflight.status}`)
  else ok('no CORS allowance is advertised, so a web page cannot drive the endpoint')

  // ── 9. endpoint and bind hardening ──────────────────────────────────────
    await expectThrowAsync('a plain-http non-loopback gateway is refused', () =>
      // A bad endpoint must fail at start-up, before any request is served.
      startLocalServer({ baseURL: 'http://gateway.example.com/v1', quiet: true, log: () => {} }),
    )
    await expectThrowAsync('a non-loopback bind is refused unless explicitly allowed', () =>
      startLocalServer({ host: '0.0.0.0', quiet: true, log: () => {} }),
    )
  } finally {
    await service.close()
  }

  // ── 10. the DSH plugin can start the service in-process ──────────────────
  // The adapter path is unchanged, but `apply({ localServer: { enabled } })`
  // must bring the loopback listener up with the plugin and tear it down with
  // it — otherwise "VS Code can use it" would depend on a second process.
  let pluginModule
  try {
    pluginModule = await import('../lib/index.js')
  } catch {
    console.log('skip plugin wiring: @deepseek-ai/dsh-llm is not installed (run `npm install`)')
  }
  if (pluginModule !== undefined) {
    const lines = []
    let dispose
    const pluginCtx = {
      logger: { info: (line) => lines.push(String(line)), warn: (line) => lines.push(String(line)), error: () => {} },
      llm: { registerAdapter: () => () => {} },
      effect: (fn) => {
        dispose = fn()
      },
      emit: () => {},
    }
    pluginModule.apply(pluginCtx, {
      baseURL: mock.baseURL,
      modelsURL: mock.modelsURL,
      localServer: { enabled: true, host: '127.0.0.1', port: 0 },
    })

    const deadline = Date.now() + 10_000
    let url
    while (url === undefined && Date.now() < deadline) {
      const line = lines.find((entry) => entry.includes('local model service on '))
      if (line !== undefined) url = line.slice(line.indexOf('local model service on ') + 'local model service on '.length).split('/v1')[0]
      else await new Promise((resolve) => setTimeout(resolve, 50))
    }
    if (url === undefined) {
      fail(`the plugin did not report a local service URL (log: ${lines.join(' | ')})`)
    } else {
      const probe = await fetch(`${url}/v1/models`)
      const probeBody = await text(probe)
      if (probe.status !== 200 || !JSON.parse(probeBody).data) {
        fail(`the plugin-started service did not answer GET /v1/models (${probe.status})`)
      } else if (typeof dispose !== 'function') {
        fail('the plugin did not register a disposer for the local service')
      } else {
        dispose()
        await new Promise((resolve) => setTimeout(resolve, 200))
        let closed = false
        try {
          await fetch(`${url}/v1/models`, { signal: AbortSignal.timeout(2_000) })
        } catch {
          closed = true
        }
        if (!closed) fail('the plugin-started service kept listening after dispose')
        else ok('the plugin starts the local service with the plugin and closes it on dispose')
      }
    }
  }

  // ── 11. no credential material ever reaches a client ─────────────────────
  const leaked = clientBodies.filter((body) => body.includes(JWT) || body.includes(VK))
  if (leaked.length > 0) fail(`${leaked.length} client response(s) contained credential material`)
  else ok(`no credential material appeared in ${clientBodies.length} client responses`)

  await mock.close()

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed.`)
    process.exit(1)
  }
  console.log('\nPASS: the local model service speaks the editor-facing OpenAI surface.')
  process.exit(0)
}

main().catch((error) => {
  console.error(`FAIL: ${error?.stack ?? error}`)
  process.exit(1)
})
