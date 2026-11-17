/**
 * Offline regression for the adapter's wire-usage → harness `TokenUsage` map.
 *
 * The gateway follows OpenAI semantics: `prompt_tokens` INCLUDES the cached
 * prefix, and `prompt_tokens_details.cached_tokens` (or DeepSeek's
 * `prompt_cache_hit_tokens`) is the part that hit. The harness contract is the
 * opposite — `inputTokens` is uncached input only and cached input is reported
 * separately — so the adapter must subtract the hit out of `inputTokens`.
 *
 * Direction alone is not enough: the harness *drops the whole sample* when the
 * buckets contradict each other. A negative or null count, a reasoning count
 * above output, or `input + cacheRead + output` that does not reconcile with
 * `totalTokens` all make the session show no usage at all instead of slightly
 * wrong numbers. Every case below therefore runs the emitted sample through a
 * copy of the host's own acceptance gate (`normalizeUsage` from
 * `@deepseek-ai/dsh-client-ui-chat/lib/client.js`) before asserting the values.
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

/** A non-negative safe integer, exactly like the host's `isCount`. */
const isCount = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/** Safe sum, exactly like the host's `safeSum`. */
function safeSum(values) {
  let total = 0
  for (const value of values) {
    total += value
    if (!Number.isSafeInteger(total)) return undefined
  }
  return total
}

/**
 * The host's usage acceptance gate, copied from
 * `@deepseek-ai/dsh-client-ui-chat/lib/client.js` (`normalizeUsage`).
 *
 * This is the function that decides whether the session displays the sample.
 * It returns undefined for any contradiction: an unsafe count, reasoning above
 * output, or an exact total smaller than the known prompt buckets.
 */
function hostAcceptance(usage) {
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalTokens } = usage
  if (!isCount(inputTokens) || !isCount(outputTokens)) return undefined
  if (cacheReadTokens !== undefined && !isCount(cacheReadTokens)) return undefined
  if (cacheWriteTokens !== undefined && !isCount(cacheWriteTokens)) return undefined
  if (reasoningTokens !== undefined && (!isCount(reasoningTokens) || reasoningTokens > outputTokens)) return undefined
  const knownPrompt = safeSum([
    inputTokens,
    ...(cacheReadTokens === undefined ? [] : [cacheReadTokens]),
    ...(cacheWriteTokens === undefined ? [] : [cacheWriteTokens]),
  ])
  if (knownPrompt === undefined) return undefined
  let exactTotal
  if (totalTokens !== undefined) {
    if (!isCount(totalTokens)) return undefined
    const exactPrompt = totalTokens - outputTokens
    if (!isCount(exactPrompt) || exactPrompt < knownPrompt) return undefined
    if (cacheReadTokens !== undefined && cacheWriteTokens !== undefined && exactPrompt !== knownPrompt) {
      return undefined
    }
    exactTotal = totalTokens
  } else {
    if (cacheReadTokens === undefined || cacheWriteTokens === undefined) return undefined
    const derivedTotal = safeSum([knownPrompt, outputTokens])
    if (derivedTotal === undefined) return undefined
    exactTotal = derivedTotal
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens: exactTotal,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  }
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

/**
 * Assert one emitted sample survives the host gate and stays internally
 * consistent: the prompt-side buckets plus output must equal the exact total.
 */
function assertAccepted(label, usage) {
  const accepted = hostAcceptance(usage)
  if (accepted === undefined) {
    fail(`${label}: the host gate rejects the sample (${JSON.stringify(usage)})`)
    return undefined
  }
  const disjointSum =
    accepted.inputTokens + (accepted.cacheReadTokens ?? 0) + (accepted.cacheWriteTokens ?? 0) + accepted.outputTokens
  if (disjointSum !== accepted.totalTokens) {
    fail(`${label}: accepted buckets ${disjointSum} disagree with total ${accepted.totalTokens}`)
    return accepted
  }
  ok(`${label}: the host gate accepts the sample (total=${accepted.totalTokens})`)
  return accepted
}

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
    assertAccepted('standard', standard)
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
    assertAccepted('prompt_cache_hit_tokens', deepseekSpelling)

    // ── 3. A gateway that reports no cache at all keeps the prompt intact ──
    const uncached = await collectUsage({ prompt_tokens: 1_000, completion_tokens: 50, total_tokens: 1_050 })
    eq('no cache: inputTokens', uncached.inputTokens, 1_000)
    eq('no cache: cacheReadTokens is absent', 'cacheReadTokens' in uncached, false)
    assertAccepted('no cache', uncached)

    // ── 4. A reported zero is a hit count, not a missing field ─────────────
    const zeroHit = await collectUsage({
      prompt_tokens: 1_000,
      completion_tokens: 50,
      total_tokens: 1_050,
      prompt_tokens_details: { cached_tokens: 0 },
    })
    eq('zero hit: inputTokens', zeroHit.inputTokens, 1_000)
    eq('zero hit: cacheReadTokens', zeroHit.cacheReadTokens, 0)
    assertAccepted('zero hit', zeroHit)

    // ── 5. A fully cached prompt displays 100%, not the old 50% ceiling ───
    const fullHit = await collectUsage({
      prompt_tokens: 1_000,
      completion_tokens: 50,
      total_tokens: 1_050,
      prompt_tokens_details: { cached_tokens: 1_000 },
    })
    eq('full hit: inputTokens', fullHit.inputTokens, 0)
    eq('full hit: cacheReadTokens', fullHit.cacheReadTokens, 1_000)
    eq('full hit: displayed cache-hit share', displayedHitPercent(fullHit), 100)
    assertAccepted('full hit', fullHit)

    // ── 6. A gateway reporting more hits than prompt tokens stays usable ──
    const overReported = await collectUsage({
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
      prompt_tokens_details: { cached_tokens: 200 },
    })
    eq('cached > prompt: inputTokens clamps at zero', overReported.inputTokens, 0)
    eq('cached > prompt: cacheReadTokens clamps to the prompt total', overReported.cacheReadTokens, 100)
    eq('cached > prompt: total is derived from the buckets', overReported.totalTokens, 110)
    eq('cached > prompt: displayed share stays 100%', displayedHitPercent(overReported), 100)
    assertAccepted('cached > prompt', overReported)

    // ── 7. Null and non-numeric counts are not counts ──────────────────────
    const nullSpelling = await collectUsage({
      prompt_tokens: 1_000,
      completion_tokens: 50,
      total_tokens: 1_050,
      prompt_cache_hit_tokens: null,
    })
    eq('null prompt_cache_hit_tokens: no cache bucket', 'cacheReadTokens' in nullSpelling, false)
    assertAccepted('null prompt_cache_hit_tokens', nullSpelling)

    const nullDetails = await collectUsage({
      prompt_tokens: 1_000,
      completion_tokens: 50,
      total_tokens: 1_050,
      prompt_tokens_details: { cached_tokens: null },
    })
    eq('null cached_tokens: no cache bucket', 'cacheReadTokens' in nullDetails, false)
    assertAccepted('null cached_tokens', nullDetails)

    const stringHit = await collectUsage({
      prompt_tokens: 1_000,
      completion_tokens: 50,
      total_tokens: 1_050,
      prompt_cache_hit_tokens: '900',
    })
    eq('string hit count is ignored', 'cacheReadTokens' in stringHit, false)
    assertAccepted('string hit count', stringHit)

    const negativeHit = await collectUsage({
      prompt_tokens: 1_000,
      completion_tokens: 50,
      total_tokens: 1_050,
      prompt_tokens_details: { cached_tokens: -5 },
    })
    eq('negative hit count is ignored', 'cacheReadTokens' in negativeHit, false)
    assertAccepted('negative hit count', negativeHit)

    // ── 8. Reasoning above output must not void the whole sample ───────────
    const heavyReasoning = await collectUsage({
      prompt_tokens: 1_000,
      completion_tokens: 10,
      total_tokens: 1_010,
      prompt_tokens_details: { cached_tokens: 900 },
      completion_tokens_details: { reasoning_tokens: 50 },
    })
    eq('reasoning > output: reasoningTokens clamps to output', heavyReasoning.reasoningTokens, 10)
    assertAccepted('reasoning > output', heavyReasoning)

    // ── 9. Missing prompt tokens with a hit still produce a usable sample ──
    const missingPrompt = await collectUsage({
      completion_tokens: 10,
      prompt_cache_hit_tokens: 500,
    })
    eq('missing prompt: inputTokens', missingPrompt.inputTokens, 0)
    eq('missing prompt: cacheReadTokens cannot exceed the prompt', missingPrompt.cacheReadTokens, 0)
    eq('missing prompt: total is derived', missingPrompt.totalTokens, 10)
    assertAccepted('missing prompt', missingPrompt)

    // ── 10. A contradictory provider total is replaced by the derived one ──
    const badTotal = await collectUsage({
      prompt_tokens: 1_000,
      completion_tokens: 50,
      total_tokens: 999,
      prompt_tokens_details: { cached_tokens: 900 },
    })
    eq('contradictory total: totalTokens is derived', badTotal.totalTokens, 1_050)
    assertAccepted('contradictory total', badTotal)

    const nullTotal = await collectUsage({
      prompt_tokens: 1_000,
      completion_tokens: 50,
      total_tokens: null,
    })
    eq('null total: totalTokens is derived', nullTotal.totalTokens, 1_050)
    assertAccepted('null total', nullTotal)

    // ── 11. Negative prompt tokens cannot poison the buckets ───────────────
    const negativePrompt = await collectUsage({ prompt_tokens: -5, completion_tokens: 10 })
    eq('negative prompt: inputTokens', negativePrompt.inputTokens, 0)
    eq('negative prompt: total is derived', negativePrompt.totalTokens, 10)
    assertAccepted('negative prompt', negativePrompt)

    // ── 12. The live sample that motivated the clamp stays displayable ─────
    const liveSample = await collectUsage({
      prompt_tokens: 5_436,
      completion_tokens: 54,
      total_tokens: 5_490,
      prompt_tokens_details: { cached_tokens: 5_376 },
    })
    eq('live sample: inputTokens', liveSample.inputTokens, 60)
    eq('live sample: cacheReadTokens', liveSample.cacheReadTokens, 5_376)
    eq('live sample: displayed cache-hit share', displayedHitPercent(liveSample), 99)
    assertAccepted('live sample', liveSample)
  } finally {
    cleanup()
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed.`)
    process.exit(1)
  }
  console.log('\nPASS: wire usage is mapped to disjoint harness counts the host accepts.')
  process.exit(0)
}

await main()
