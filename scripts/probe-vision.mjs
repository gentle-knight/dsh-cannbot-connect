/**
 * Measure which catalog models actually accept image input through the gateway.
 *
 * The roster endpoint (`/cannbot/api/models/personal`) discloses no modality
 * field, and neither a 2xx nor a token-count delta proves the model really saw
 * the picture: on 2026-11-17 `glm-5.3` returned 200 with image tokens billed
 * while telling the user the base64 payload was truncated. So every model is
 * asked the same question about two solid-colour images and must name both
 * colours:
 *   - both colour words right  → vision
 *   - a clean image refusal    → text-only (400 about the content part)
 *   - 200 but colours wrong / "cannot decode" → text-only in practice
 *   - only one right           → unverified
 *   - no answer in time        → unclassified; the gateway hangs instead of
 *                                refusing, which is why such a model must not
 *                                be advertised as image-capable
 *
 * Run this after the gateway adds or retires a model, then copy the printed
 * array into the plugin configuration (or update the default in a release).
 *
 * Requires CANNWork to be signed in (same credentials as the plugin itself).
 * Usage: `node scripts/probe-vision.mjs [--timeout-ms 30000]`
 * Exit codes: 0 every model classified, 1 setup failure, 2 some model unverified.
 */
import { fetchCatalog, readAccountVk, readJwt } from '../lib/index.js'

/** 64x64 solid PNGs — small, deterministic, and well above the gateway's 10px floor. */
const BLUE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAn0lEQVRoge2SQQkAQRDDqqTCTnvErIh7hIFCBKSh6cdpoht0A9ArdhfiLtENugHoFbsLcZfoBt0A9IrdhbhLdINuAHrF7kLcJbpBNwC9Ynch7hLdoBuAXrG7EHeJbtANQK/YXYi7RDfoBqBX7C7EXaIbdAPQK3YX4i7RDboB6BW7C3GX6AbdAPSK3YW4S3SDbgB6xe5C3CW6QTcAveIfHlsmQTwiFSCUAAAAAElFTkSuQmCC'
const RED_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAnklEQVRoge2SUQkAQBSDlsT+oRbmQtyHPBgYwMlSOE10g24AesXuQtwlukE3AL1idyHuEt2gG4BesbsQd4lu0A1Ar9hdiLtEN+gGoFfsLsRdoht0A9ArdhfiLtENugHoFbsLcZfoBt0A9IrdhbhLdINuAHrF7kLcJbpBNwC9Ynch7hLdoBuAXrG7EHeJbtANQK/YXYi7RDfoBqBX/OEBzyyBALA4OlEAAAAASUVORK5CYII='

const DEFAULT_BASE_URL = 'https://cannbot.hicann.cn/gateway/compatible-mode/v1'
const DEFAULT_TIMEOUT_MS = 30_000

/** Colour words that count as reading a solid image on either language path. */
const COLOUR_PROBES = [
  { base64: BLUE_PNG_BASE64, expected: /blue|蓝/i, label: 'blue' },
  { base64: RED_PNG_BASE64, expected: /red|红/i, label: 'red' },
]

/** Parse `--timeout-ms N`, ignoring everything else. */
function parseArgs(argv) {
  let timeoutMs = DEFAULT_TIMEOUT_MS
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--timeout-ms') continue
    const value = Number(argv[index + 1])
    if (Number.isFinite(value) && value > 0) timeoutMs = value
    index += 1
  }
  return { timeoutMs }
}

/** Remove the credentials this script sends from any provider-supplied text. */
function redact(text, secrets) {
  let out = String(text)
  for (const secret of secrets) if (typeof secret === 'string' && secret.length > 0) out = out.split(secret).join('[redacted]')
  return out
}

/** The reply text a verdict is judged on (visible content and any reasoning prefix). */
function replyText(text) {
  try {
    const json = JSON.parse(text)
    const message = json?.choices?.[0]?.message
    return { content: String(message?.content ?? ''), reasoning: String(message?.reasoning_content ?? '') }
  } catch {
    return { content: String(text), reasoning: '' }
  }
}

/** One chat request carrying one probe image. */
async function probeImage({ baseURL, model, jwt, vk, imageURL, timeoutMs }) {
  const startedAt = Date.now()
  try {
    const response = await fetch(`${baseURL.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-vkey': vk,
        'api-key': vk,
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({
        model,
        stream: false,
        max_tokens: 256,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is the dominant colour of this image? Answer with one word.' },
              { type: 'image_url', image_url: { url: imageURL } },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
      // Both credentials ride this request: never let a redirect hand them to
      // another origin (the adapter refuses redirects for the same reason).
      redirect: 'error',
    })
    const elapsed = Math.round((Date.now() - startedAt) / 1000)
    const text = await response.text()
    if (response.ok) return { kind: 'answered', elapsed, reply: replyText(text) }
    let detail = redact(text, [jwt, vk])
    try {
      const json = JSON.parse(text)
      detail = redact(String(json?.error?.message ?? json?.message ?? detail), [jwt, vk])
    } catch {
      // Non-JSON provider error pages are kept as their raw prefix.
    }
    detail = detail.slice(0, 160)
    const imageProblem = /\bimages?(?:_url|\s+(?:input|content|format|length|width))\b/i.test(detail)
    return { kind: imageProblem ? 'text-only' : 'error', elapsed, detail, status: response.status }
  } catch (error) {
    const name = error?.name === 'TimeoutError' ? 'timeout' : 'transport'
    return {
      kind: name === 'timeout' ? 'unclassified' : 'error',
      elapsed: Math.round((Date.now() - startedAt) / 1000),
      detail: redact(name === 'timeout' ? `no answer within ${timeoutMs}ms` : String(error?.message ?? error), [jwt, vk]),
    }
  }
}

/** Probe one model with both colours and reduce the pair to one verdict. */
async function classifyModel({ baseURL, model, jwt, vk, timeoutMs }) {
  const answers = []
  for (const probe of COLOUR_PROBES) {
    const result = await probeImage({
      baseURL,
      model,
      jwt,
      vk,
      imageURL: `data:image/png;base64,${probe.base64}`,
      timeoutMs,
    })
    if (result.kind === 'text-only') return { kind: 'text-only', detail: result.detail, elapsed: result.elapsed }
    if (result.kind !== 'answered') return { kind: result.kind, detail: result.detail, elapsed: result.elapsed }
    const reply = `${result.reply.content} ${result.reply.reasoning}`
    answers.push({ probe, reply, correct: probe.expected.test(reply), elapsed: result.elapsed })
  }
  const excerpt = (reply) => JSON.stringify(String(reply).trim().slice(0, 80))
  const correct = answers.filter((answer) => answer.correct).length
  const elapsed = answers.reduce((total, answer) => total + answer.elapsed, 0)
  if (correct === answers.length) {
    return { kind: 'vision', elapsed, detail: answers.map((answer) => `${answer.probe.label}:${excerpt(answer.reply)}`).join(' ') }
  }
  if (correct === 0) {
    // A 200 whose answer names neither colour is a text-only path in practice:
    // the model repeats the prompt or reports that it cannot decode the payload.
    return { kind: 'text-only', elapsed, detail: `200 but no colour named: ${excerpt(answers[0].reply)}` }
  }
  return { kind: 'unverified', elapsed, detail: `only ${correct}/${answers.length} colours right` }
}

async function main() {
  const { timeoutMs } = parseArgs(process.argv.slice(2))
  const jwt = readJwt()
  const vk = readAccountVk()
  if (jwt === undefined || vk === undefined) {
    console.error(
      'CANNWork sign-in not found: need session.json (JWT) under ~/.local/share/opencode and auth.json (VK) under ~/.config/opencode.',
    )
    process.exit(1)
  }

  const result = await fetchCatalog({})
  if (!result.ok) {
    console.error(`catalog fetch failed: ${result.reason}`)
    process.exit(1)
  }
  console.log(`probing ${result.catalog.length} models with blue and red PNGs (timeout ${timeoutMs}ms)\n`)

  const verdicts = []
  for (const entry of result.catalog) {
    // Prefer the roster row's own VK, which is what the adapter actually sends;
    // a builtin row's key differs from the account-level one.
    const verdict = await classifyModel({
      baseURL: DEFAULT_BASE_URL,
      model: entry.id,
      jwt,
      vk: entry.vk ?? vk,
      timeoutMs,
    })
    verdicts.push({ id: entry.id, ...verdict })
    const label = verdict.kind.padEnd(12)
    const seconds = verdict.elapsed === undefined ? '' : `${String(verdict.elapsed).padStart(3)}s`
    console.log(`${label} ${entry.id.padEnd(22)} ${seconds.padEnd(5)}${verdict.detail}`)
  }

  const vision = verdicts.filter((verdict) => verdict.kind === 'vision').map((verdict) => verdict.id)
  const unresolved = verdicts.filter(
    (verdict) => verdict.kind === 'unclassified' || verdict.kind === 'error' || verdict.kind === 'unverified',
  )
  console.log('\nSuggested configuration:')
  console.log(`visionModels: ${JSON.stringify(vision)}`)
  if (unresolved.length > 0) {
    console.log(
      `\nNot advertised (inspect before trusting): ${unresolved
        .map((verdict) => `${verdict.id} (${verdict.kind})`)
        .join(', ')}`,
    )
  }
  console.log('\nText-only, failing, or unverified models stay out of `visionModels`; the harness then refuses image')
  console.log('attachments with a clear message instead of sending bytes the gateway cannot read.')
  process.exit(unresolved.length === 0 ? 0 : 2)
}

await main()
