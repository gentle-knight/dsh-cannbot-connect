/**
 * Offline checks for the adapter's non-streaming contract surface and the
 * stream branches that the live e2e cannot force.
 *
 * `providerInfo`/`providerRetryPolicy`/`catalog` are what the host reads at
 * registration; an absent response body, a stream that ends without a finish,
 * an in-band error without a status, and a truncated or empty tool call are all
 * provider behaviours the happy path never reaches. They are cheap to simulate
 * locally and expensive to discover in production.
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

const check = (label, predicate, detail) => {
  if (predicate) ok(label)
  else fail(`${label}${detail === undefined ? '' : `: ${detail}`}`)
}

const JWT = 'test-jwt-contract-0123456789abcdef'
const VK = 'vk-contract-0123456789abcdef'

const home = mkdtempSync(join(tmpdir(), 'dsh-cannbot-contract-'))
mkdirSync(join(home, 'data', 'opencode'), { recursive: true })
mkdirSync(join(home, 'config', 'opencode'), { recursive: true })
writeFileSync(join(home, 'data', 'opencode', 'session.json'), JSON.stringify({ accessToken: JWT }))
writeFileSync(join(home, 'config', 'opencode', 'auth.json'), JSON.stringify({ cannbot: { key: VK } }))
const previous = {
  home: process.env.HOME,
  userProfile: process.env.USERPROFILE,
  data: process.env.XDG_DATA_HOME,
  config: process.env.XDG_CONFIG_HOME,
}
process.env.HOME = home
process.env.USERPROFILE = home
process.env.XDG_DATA_HOME = join(home, 'data')
process.env.XDG_CONFIG_HOME = join(home, 'config')

const frame = (payload) => `data: ${JSON.stringify(payload)}\n\n`

/** One mock gateway whose chat answer is supplied by the test. */
async function withGateway(answer, fn) {
  const server = createServer(async (req, res) => {
    for await (const _ of req) {
      // drain
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

const adapterFor = (baseURL, dependencies = {}) =>
  new CannbotAdapter(
    {
      baseURL,
      modelsURL: `${baseURL}/models`,
      streamIdleTimeoutMs: 5_000,
      defaultContextWindow: 8_192,
      defaultMaxTokens: 1_024,
    },
    dependencies,
  )

const turn = (adapter) =>
  adapter.stream({
    provider: PROVIDER,
    model: 'deepseek-v4.1-flash',
    messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })

async function collect(adapter) {
  const chunks = []
  for await (const chunk of turn(adapter)) chunks.push(chunk)
  return chunks
}

async function errorOf(adapter) {
  try {
    await collect(adapter)
    return undefined
  } catch (error) {
    return error
  }
}

try {
  // ── registration surface ─────────────────────────────────────────────────
  const bare = adapterFor('http://127.0.0.1:9/v1')
  eq('providerInfo id follows the route', bare.providerInfo('cannbot').id, 'cannbot')
  eq('providerInfo display name', bare.providerInfo('cannbot').name, 'CANNBOT')
  check('providerRetryPolicy returns a resolved policy', typeof bare.providerRetryPolicy() === 'object')
  eq('a fresh adapter serves the fallback catalog', bare.catalog.length, 1)
  bare.adoptCatalog([{ id: 'm1', name: 'M1' }])
  eq('adoptCatalog replaces the served catalog', bare.catalog[0].id, 'm1')
  eq('imageRequestPricing stays undefined (measured variance)', bare.imageRequestPricing('cannbot', 'm1'), undefined)

  // ── a body-less 200 is a transport failure ───────────────────────────────
  {
    const original = globalThis.fetch
    globalThis.fetch = async () => new Response(null, { status: 200 })
    try {
      const error = await errorOf(adapterFor('http://127.0.0.1:9/v1'))
      eq('a 200 with no body maps to TRANSPORT', error?.code, 'TRANSPORT')
    } finally {
      globalThis.fetch = original
    }
  }

  // ── a stream that ends without a finish ──────────────────────────────────
  await withGateway(
    (res) => {
      res.write(frame({ choices: [{ index: 0, delta: { content: 'partial' } }] }))
    },
    async (baseURL) => {
      const error = await errorOf(adapterFor(baseURL))
      eq('an unterminated stream maps to STREAM_CLOSED', error?.code, 'STREAM_CLOSED')
    },
  )

  // ── an in-band error without a status ────────────────────────────────────
  await withGateway(
    (res) => {
      res.write(frame({ error: { message: 'bad stream' } }))
    },
    async (baseURL) => {
      const error = await errorOf(adapterFor(baseURL))
      eq('a status-less streamed error maps to INVALID_REQUEST', error?.code, 'INVALID_REQUEST')
    },
  )

  // ── usage-only and delta-less frames are ignored, then finish ───────────
  await withGateway(
    (res) => {
      res.write(frame({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }))
      res.write(frame({ choices: [{ index: 0 }] }))
      res.write(frame({ choices: [{ index: 0, delta: { content: 'pong' } }] }))
      res.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))
      res.write('data: [DONE]\n\n')
    },
    async (baseURL) => {
      const chunks = await collect(adapterFor(baseURL))
      eq('a usage-only frame still yields usage', chunks.find((chunk) => chunk.type === 'usage')?.usage?.inputTokens, 3)
      eq('a delta-less choice is skipped', chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join(''), 'pong')
    },
  )

  // ── malformed frames are ignored and reasoning deltas assemble ──────────
  await withGateway(
    (res) => {
      res.write('data: not-json\n\n')
      res.write(frame({ choices: [{ index: 0, delta: { reasoning_content: 'think' } }] }))
      res.write(frame({ choices: [{ index: 0, delta: { content: 'pong' } }] }))
      res.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))
      res.write('data: [DONE]\n\n')
    },
    async (baseURL) => {
      const chunks = await collect(adapterFor(baseURL))
      eq('a malformed frame is skipped', chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join(''), 'pong')
      eq('a reasoning delta opens a reasoning block', chunks.find((chunk) => chunk.type === 'block-start')?.blockType, 'reasoning')
      eq('reasoning deltas are streamed', chunks.filter((chunk) => chunk.type === 'reasoning-delta').map((chunk) => chunk.text).join(''), 'think')
      eq('the reasoning block is emitted at the end', chunks.find((chunk) => chunk.type === 'block-end')?.block?.text, 'think')
    },
  )

  // ── empty tool arguments are valid ───────────────────────────────────────
  await withGateway(
    (res) => {
      res.write(frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'probe', arguments: '' } }] } }] }))
      res.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }))
      res.write('data: [DONE]\n\n')
    },
    async (baseURL) => {
      const chunks = await collect(adapterFor(baseURL))
      const block = chunks.find((chunk) => chunk.type === 'block-end')?.block
      eq('an empty tool argument string is accepted', block?.arguments, '')
    },
  )

  // ── a truncated tool call is allowed only with max-tokens ────────────────
  await withGateway(
    (res) => {
      res.write(frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'probe', arguments: '{"a":' } }] } }] }))
      res.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }))
      res.write('data: [DONE]\n\n')
    },
    async (baseURL) => {
      const chunks = await collect(adapterFor(baseURL))
      eq('a truncated tool call finishes with max-tokens', chunks.at(-1)?.reason?.kind, 'max-tokens')
    },
  )

  // ── a model refusal asks the catalog store for a retry ───────────────────
  {
    let retries = 0
    const server = createServer(async (req, res) => {
      for await (const _ of req) {
        // drain
      }
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ message: 'Model deepseek-v4.1-flash not allowed' }))
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    try {
      const error = await errorOf(adapterFor(`http://127.0.0.1:${port}/v1`, { onAuthFailure: () => (retries += 1) }))
      eq('a model 403 still maps to MODEL_UNSUPPORTED', error?.code, 'MODEL_UNSUPPORTED')
      eq('a model 403 triggers one catalog retry', retries, 1)
    } finally {
      await new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(resolve)
      })
    }
  }
} finally {
  if (previous.home === undefined) delete process.env.HOME
  else process.env.HOME = previous.home
  if (previous.userProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = previous.userProfile
  if (previous.data === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = previous.data
  if (previous.config === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = previous.config
  rmSync(home, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\nFAIL: ${failures} adapter-contract check(s) failed.`)
  process.exit(1)
}
console.log('\nPASS: adapter registration surface and forced stream branches hold.')
