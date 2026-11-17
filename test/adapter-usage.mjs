/**
 * Offline regression for the adapter's wire-usage → harness `TokenUsage` map.
 *
 * The gateway follows OpenAI semantics: `prompt_tokens` INCLUDES the cached
 * prefix, and `prompt_tokens_details.cached_tokens` (or DeepSeek's
 * `prompt_cache_hit_tokens`) is the part that hit. The harness contract is the
 * opposite — `inputTokens` is uncached input only and cached input is reported
 * separately — so the adapter must subtract the hit out of `inputTokens`.
 *
 * Treating `prompt_tokens` as uncached input makes the session's cache-hit
 * share (`cacheReadTokens ÷ billed input`) count the hit twice, which caps the
 * displayed percentage at 50% no matter how warm the cache is.
 *
 * These checks run without the live gateway and without touching CANNWork:
 * a mock SSE upstream stands in for the gateway, and temporary credential
 * files under a private `XDG_DATA_HOME` stand in for the CANNWork sign-in.
 *
 * Run with `npm test`. Exits 0 when every check passes, 1 otherwise.
 */
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CannbotAdapter, PROVIDER } from '../lib/index.js'

const JWT = 'test-jwt-0123456789abcdef'
const VK = 'test-vk-not-a-real-credential'

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
  const home = mkdtempSync(join(tmpdir(), 'dsh-cannbot-usage-'))
  const dir = join(home, 'opencode')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.json'), JSON.stringify({ accessToken: JWT }))
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({ cannbot: { key: VK } }))
  process.env.XDG_DATA_HOME = home
  return () => rmSync(home, { recursive: true, force: true })
}

/** One SSE frame carrying `payload`. */
const frame = (payload) => `data: ${JSON.stringify(payload)}\n\n`

/**
 * Run one mock turn and return the usage chunk the adapter emitted.
 *
 * The mock answers the adapter's single POST with a complete text turn and the
 * supplied `usage` object, one wire shape per call.
 */
async function collectUsage(usage) {
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {
      // drain
    }
    const base = { id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1_700_000_000, model: 'mock-model' }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    res.write(frame({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'pong' } }] }))
    res.write(frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))
    res.write(frame({ ...base, choices: [], usage }))
    res.write('data: [DONE]\n\n')
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  try {
    const adapter = new CannbotAdapter({
      baseURL: `http://127.0.0.1:${port}/v1`,
      modelsURL: `http://127.0.0.1:${port}/models`,
      streamIdleTimeoutMs: 5_000,
      defaultContextWindow: 8_192,
      defaultMaxTokens: 1_024,
    })
    const chunks = []
    for await (const chunk of adapter.stream({
      provider: PROVIDER,
      model: 'mock-model',
      messages: [{ id: 'msg_test', role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    })) {
      chunks.push(chunk)
    }
    const usageChunk = chunks.find((chunk) => chunk.type === 'usage')
    if (usageChunk === undefined) throw new Error('the adapter emitted no usage chunk')
    return usageChunk.usage
  } finally {
    await new Promise((resolve) => {
      server.closeAllConnections?.()
      server.close(resolve)
    })
  }
}

/** The share DSH displays: cache reads over billed prompt-side input. */
const displayedHitPercent = (usage) =>
  Math.round(
    ((usage.cacheReadTokens ?? 0) / (usage.inputTokens + (usage.cacheReadTokens ?? 0))) * 100,
  )

async function main() {
  const cleanup = isolateCredentials()
  try {
    // ── 1. OpenAI semantics: prompt_tokens includes the cached prefix ──────
    const standard = await collectUsage({
      prompt_tokens: 1_000,
      completion_tokens: 50,
      total_tokens: 1_050,
      prompt_tokens_details: { cached_tokens: 900 },
      completion_tokens_details: { reasoning_tokens: 10 },
    })
    eq('standard: inputTokens', standard.inputTokens, 100)
    eq('standard: cacheReadTokens', standard.cacheReadTokens, 900)
    eq('standard: outputTokens', standard.outputTokens, 50)
    eq('standard: totalTokens', standard.totalTokens, 1_050)
    eq('standard: reasoningTokens', standard.reasoningTokens, 10)
    eq(
      'standard: disjoint sum equals the provider total',
      standard.inputTokens + standard.cacheReadTokens + standard.outputTokens,
      standard.totalTokens,
    )
    eq('standard: displayed cache-hit share', displayedHitPercent(standard), 90)

    // ── 2. DeepSeek's other spelling, used when details are absent ─────────
    const deepseekSpelling = await collectUsage({
      prompt_tokens: 1_000,
      completion_tokens: 50,
      total_tokens: 1_050,
      prompt_cache_hit_tokens: 900,
    })
    eq('prompt_cache_hit_tokens: inputTokens', deepseekSpelling.inputTokens, 100)
    eq('prompt_cache_hit_tokens: cacheReadTokens', deepseekSpelling.cacheReadTokens, 900)

    // ── 3. A gateway that reports no cache at all keeps the prompt intact ──
    const uncached = await collectUsage({ prompt_tokens: 1_000, completion_tokens: 50, total_tokens: 1_050 })
    eq('no cache: inputTokens', uncached.inputTokens, 1_000)
    eq('no cache: cacheReadTokens is absent', 'cacheReadTokens' in uncached, false)

    // ── 4. A reported zero is a hit count, not a missing field ─────────────
    const zeroHit = await collectUsage({
      prompt_tokens: 1_000,
      completion_tokens: 50,
      total_tokens: 1_050,
      prompt_tokens_details: { cached_tokens: 0 },
    })
    eq('zero hit: inputTokens', zeroHit.inputTokens, 1_000)
    eq('zero hit: cacheReadTokens', zeroHit.cacheReadTokens, 0)

    // ── 5. An inconsistent gateway cannot make inputTokens negative ────────
    const overReported = await collectUsage({
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
      prompt_tokens_details: { cached_tokens: 200 },
    })
    eq('cached > prompt: inputTokens clamps at zero', overReported.inputTokens, 0)
  } finally {
    cleanup()
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed.`)
    process.exit(1)
  }
  console.log('\nPASS: wire usage is mapped to disjoint harness counts.')
  process.exit(0)
}

await main()
