/**
 * Offline checks for the terminal stream mapping.
 *
 * A 200 SSE response can still end in a provider refusal, an empty completion,
 * or malformed tool arguments. Those cases must reach the host as failures with
 * stable codes; the old fallback turned every unknown `finish_reason` into a
 * clean stop, which hid content-filter refusals from the user and the loop.
 */
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CannbotAdapter, PROVIDER } from '../lib/index.js'

let failures = 0
const fail = (message) => {
  console.error(`FAIL: ${message}`)
  failures += 1
}
const ok = (message) => console.log(`ok   ${message}`)

const eq = (label, actual, expected) => {
  if (Object.is(actual, expected)) ok(`${label} = ${JSON.stringify(actual)}`)
  else fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

const JWT = 'test-jwt-0123456789abcdef'
const VK = 'vk-account-0123456789'

function isolateCredentials() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-cannbot-finish-'))
  const dir = join(home, 'opencode')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.json'), JSON.stringify({ accessToken: JWT }))
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({ cannbot: { key: VK } }))
  process.env.XDG_DATA_HOME = home
  process.env.XDG_CONFIG_HOME = join(home, 'config-empty')
  return () => rmSync(home, { recursive: true, force: true })
}

const frame = (payload) => `data: ${JSON.stringify(payload)}\n\n`

/** One mock gateway whose chat answer is supplied by the test. */
async function withGateway(answer, fn) {
  const server = createServer(async (req, res) => {
    for await (const _ of req) {
      // Drain the request body; the answer is fixed per test.
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    answer(res)
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    return await fn(`http://127.0.0.1:${port}/v1`)
  } finally {
    await new Promise((resolve) => {
      server.closeAllConnections?.()
      server.close(resolve)
    })
  }
}

const adapterFor = (baseURL) =>
  new CannbotAdapter({
    baseURL,
    modelsURL: `${baseURL}/models`,
    streamIdleTimeoutMs: 5_000,
    defaultContextWindow: 8_192,
    defaultMaxTokens: 1_024,
  })

async function run(adapter) {
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: PROVIDER,
    model: 'deepseek-v4.1-flash',
    messages: [{ id: 'msg_test', role: 'user', content: [{ type: 'text', text: 'ping' }] }],
  })) {
    chunks.push(chunk)
  }
  return chunks
}

async function runError(adapter) {
  try {
    await run(adapter)
    return undefined
  } catch (error) {
    return error
  }
}

const cleanup = isolateCredentials()
try {
  // ── a content-filter finish is a failure, not a stop ─────────────────────
  await withGateway(
    (res) => {
      res.write(frame({ choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: 'content_filter' }] }))
      res.write('data: [DONE]\n\n')
    },
    async (baseURL) => {
      const error = await runError(adapterFor(baseURL))
      eq('content_filter maps to INVALID_RESPONSE', error?.code, 'INVALID_RESPONSE')
      eq('the refusal names the reason', /content_filter|unsupported reason/.test(error?.message ?? ''), true)
    },
  )

  // ── an unknown finish reason is raised ───────────────────────────────────
  await withGateway(
    (res) => {
      res.write(frame({ choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: 'weird_reason' }] }))
      res.write('data: [DONE]\n\n')
    },
    async (baseURL) => {
      const error = await runError(adapterFor(baseURL))
      eq('an unknown finish maps to INVALID_RESPONSE', error?.code, 'INVALID_RESPONSE')
    },
  )

  // ── empty successful completion is EMPTY_RESPONSE ────────────────────────
  await withGateway(
    (res) => {
      res.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))
      res.write('data: [DONE]\n\n')
    },
    async (baseURL) => {
      const error = await runError(adapterFor(baseURL))
      eq('an empty completion maps to EMPTY_RESPONSE', error?.code, 'EMPTY_RESPONSE')
    },
  )

  // ── malformed tool arguments are MALFORMED_RESPONSE ──────────────────────
  await withGateway(
    (res) => {
      res.write(
        frame({
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'probe', arguments: '{"a":' } }] },
            },
          ],
        }),
      )
      res.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }))
      res.write('data: [DONE]\n\n')
    },
    async (baseURL) => {
      const error = await runError(adapterFor(baseURL))
      eq('invalid tool JSON maps to MALFORMED_RESPONSE', error?.code, 'MALFORMED_RESPONSE')
    },
  )

  // ── a mid-stream error keeps its status ──────────────────────────────────
  await withGateway(
    (res) => {
      res.write(frame({ error: { message: 'slow down', status: 429 } }))
      res.write('data: [DONE]\n\n')
    },
    async (baseURL) => {
      const error = await runError(adapterFor(baseURL))
      eq('a streamed 429 maps to RATE_LIMIT', error?.code, 'RATE_LIMIT')
      eq('the streamed status is preserved', error?.failure?.status, 429)
    },
  )

  // ── a clean stop still completes ─────────────────────────────────────────
  await withGateway(
    (res) => {
      res.write(frame({ choices: [{ index: 0, delta: { content: 'pong' } }] }))
      res.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))
      res.write('data: [DONE]\n\n')
    },
    async (baseURL) => {
      const chunks = await run(adapterFor(baseURL))
      const text = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')
      eq('a clean stop assembles text', text, 'pong')
      eq('a clean stop finishes with stop', chunks.at(-1)?.reason?.kind, 'stop')
    },
  )
} finally {
  cleanup()
}

if (failures > 0) {
  console.error(`\nFAIL: ${failures} finish-mapping check(s) failed.`)
  process.exit(1)
}
console.log('\nPASS: terminal stream outcomes map onto the harness taxonomy.')
