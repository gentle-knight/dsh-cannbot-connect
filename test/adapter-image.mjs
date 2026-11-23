/**
 * Offline regression for image input: capability advertisement, request
 * projection, wire serialization, offload budget, and refusal mapping.
 *
 * The gateway accepts OpenAI vision content parts for a measured subset of the
 * catalog and answers text-only models with a 400. These checks pin the whole
 * adapter-side contract without touching the network: a local HTTP server stands
 * in for the gateway and an in-memory attachment store stands in for the durable
 * one, so the request body that would have been sent is asserted byte for byte.
 *
 * Run with `npm test`. Exits 0 when every check passes, 1 otherwise.
 */
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { offloadedImageText, requestImageHandleText, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import { CannbotAdapter, Config, PROVIDER, fetchCatalog } from '../lib/index.js'
import { readConfig } from '../lib/config-runtime.js'

const JWT = 'test-jwt-0123456789abcdef'
const ACCOUNT_VK = 'vk-account-0123456789'

const VISION_MODEL = 'model-vision'
const TEXT_MODEL = 'model-text'

const ROSTER = {
  success: true,
  data: {
    personalModels: [
      { model: VISION_MODEL, title: 'Model Vision', apiKey: ACCOUNT_VK, contextLength: 1_000 },
      { model: TEXT_MODEL, title: 'Model Text', contextLength: 1_000 },
    ],
    builtinModels: [],
  },
}

/** One durable image reference as session history carries it. */
const imageRef = (id, overrides = {}) => ({
  attachmentId: id,
  mediaType: 'image/png',
  bytes: 1_024,
  width: 64,
  height: 64,
  name: `${id}.png`,
  ...overrides,
})

const userMessage = (content) => ({ id: 'msg_user', role: 'user', content, source: { kind: 'user' } })

let failures = 0
const fail = (message) => {
  console.error(`FAIL: ${message}`)
  failures += 1
}
const ok = (message) => console.log(`ok   ${message}`)

/** Assert one value and label the check. */
const eq = (label, actual, expected) => {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  if (same) ok(`${label} = ${JSON.stringify(actual)}`)
  else fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

/** Assert a predicate with a labelled failure. */
const check = (label, predicate, detail) => {
  if (predicate) ok(label)
  else fail(`${label}${detail === undefined ? '' : `: ${detail}`}`)
}

/** Point credential reads at throwaway files instead of the real CANNWork state. */
function isolateCredentials() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-cannbot-image-'))
  const dir = join(home, 'opencode')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.json'), JSON.stringify({ accessToken: JWT }))
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({ cannbot: { key: ACCOUNT_VK } }))
  const previous = { home: process.env.HOME, userProfile: process.env.USERPROFILE, data: process.env.XDG_DATA_HOME, config: process.env.XDG_CONFIG_HOME }
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.XDG_DATA_HOME = home
  process.env.XDG_CONFIG_HOME = join(home, 'config-empty')
  return () => {
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
}

/** One SSE frame carrying `payload`. */
const frame = (payload) => `data: ${JSON.stringify(payload)}\n\n`

/** Start one mock gateway for the duration of `fn`, recording every request. */
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

/** Answer the catalog and every chat request with a short SSE completion. */
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

/** Chat body of the most recent request the mock recorded. */
const chatBodyOf = (requests) => {
  const chat = requests.findLast((request) => request.url === '/v1/chat/completions')
  return chat === undefined ? undefined : JSON.parse(chat.body)
}

/**
 * In-memory stand-in for the durable attachment store.
 *
 * `sizes` lets one case report a request-version byte count without allocating
 * it, which is how the offload budget is exercised. `imageHostPath` is the only
 * other method the adapter's access resolver reads.
 */
function fakeAttachments({ sizes = {}, calls = [], hostPath } = {}) {
  return {
    calls,
    async readImageRequest(ref, target) {
      calls.push({ ref, target })
      const data = Buffer.from(`request-bytes:${ref.attachmentId}`)
      return {
        variantId: `variant-${ref.attachmentId}`,
        attachment: ref,
        data,
        mediaType: ref.mediaType,
        bytes: sizes[ref.attachmentId] ?? data.byteLength,
        width: target.width,
        height: target.height,
        depth: 'uchar',
        space: 'srgb',
        hasAlpha: false,
      }
    },
    imageHostPath(ref) {
      return hostPath?.(ref)
    },
  }
}

const adapterFor = (gatewayURLs, { config = {}, attachments, mapHostPath = () => undefined } = {}) => {
  const dependencies =
    attachments === undefined
      ? {}
      : {
          resolveAttachments: () => attachments,
          // The same shared resolver the plugin wires in production: host path
          // first, then the execution-world mapping for model tools.
          resolveImageAccess: (store, ref) => resolveImageAttachmentAccess(store, mapHostPath, ref),
        }
  return {
    adapter: new CannbotAdapter(
      {
        baseURL: gatewayURLs.baseURL,
        modelsURL: gatewayURLs.modelsURL,
        streamIdleTimeoutMs: 5_000,
        defaultContextWindow: 8_192,
        defaultMaxTokens: 1_024,
        visionModels: [VISION_MODEL],
        ...config,
      },
      dependencies,
    ),
    attachments,
  }
}

/** Stream one turn with a given message list, returning the recorded body. */
async function runTurn(adapter, urls, messages) {
  for await (const _chunk of adapter.stream({ provider: PROVIDER, model: VISION_MODEL, messages })) {
    // Drain; the assertions read the recorded request.
  }
  return chatBodyOf(urls.requests)
}

/** Run one turn expected to fail and return the thrown error. */
async function runTurnError(adapter, messages, model = VISION_MODEL) {
  try {
    for await (const _chunk of adapter.stream({ provider: PROVIDER, model, messages })) {
      // Drain.
    }
  } catch (error) {
    return error
  }
  throw new Error('expected the turn to fail, but it succeeded')
}

async function main() {
  const cleanup = isolateCredentials()
  try {
    // ── 1. Capability advertisement is per model ───────────────────────────
    {
      const { adapter } = adapterFor({ baseURL: 'http://127.0.0.1:1/v1', modelsURL: 'http://127.0.0.1:1/models' })
      adapter.adoptCatalog([
        { id: VISION_MODEL, name: 'Vision', contextWindow: 1_000, maxTokens: 100 },
        { id: TEXT_MODEL, name: 'Text', contextWindow: 1_000, maxTokens: 100 },
      ])
      const listed = new Map((await adapter.listModels()).map((model) => [model.id, model.inputModalities]))
      eq('vision model advertises image', listed.get(VISION_MODEL), ['text', 'image'])
      eq('unlisted model advertises text only', listed.get(TEXT_MODEL), ['text'])
      eq(
        'resolveModel agrees with listModels',
        (await adapter.resolveModel(PROVIDER, VISION_MODEL)).inputModalities,
        ['text', 'image'],
      )
      eq('text model resolves without image', (await adapter.resolveModel(PROVIDER, TEXT_MODEL)).inputModalities, [
        'text',
      ])
    }

    // ── 2. The default vision list is the measured one ─────────────────────
    {
      const defaults = readConfig(new Config({})).visionModels
      check('default vision list contains qwen3.8-flash', defaults.includes('qwen3.8-flash'), defaults.join(','))
      check('default vision list contains glm-5.3-flash', defaults.includes('glm-5.3-flash'))
      check(
        'default vision list excludes the damaged glm-5.3 image path',
        !defaults.includes('glm-5.3'),
        defaults.join(','),
      )
      check('default vision list excludes the text-only deepseek-v4-pro', !defaults.includes('deepseek-v4-pro'))
      check('default vision list excludes the hanging deepseek-v4-flash', !defaults.includes('deepseek-v4-flash'))
    }

    // ── 3. Image target scales down, never up, and keeps the byte target ───
    {
      const { adapter } = adapterFor({ baseURL: 'http://127.0.0.1:1/v1', modelsURL: 'http://127.0.0.1:1/models' })
      const small = adapter.imageRequestTarget(PROVIDER, VISION_MODEL, imageRef('small', { width: 640, height: 480 }))
      eq('small image is not enlarged', [small.width, small.height], [640, 480])
      eq('byte target defaults to 1MiB', small.maxBytes, 1_048_576)
      const large = adapter.imageRequestTarget(PROVIDER, VISION_MODEL, imageRef('large', { width: 6_000, height: 4_000 }))
      check(
        'large image fits the pixel budget',
        large.width * large.height <= 4_194_304,
        `${large.width}x${large.height}`,
      )
      check(
        'target keeps the aspect ratio',
        Math.abs(large.width / large.height - 6_000 / 4_000) < 0.01,
        `${large.width}x${large.height}`,
      )
    }

    await withServer(gateway(), async (urls) => {
      const store = fakeAttachments()
      const { adapter } = adapterFor(urls, { attachments: store })

      // ── 4. A retained image is sent as handle text plus a data URL ───────
      {
        const ref = imageRef('att_one')
        const body = await runTurn(adapter, urls, [userMessage([{ type: 'text', text: 'what is this?' }, { type: 'image', attachment: ref }])])
        const content = body?.messages?.[0]?.content
        check('user content carrying an image is an array', Array.isArray(content), JSON.stringify(content)?.slice(0, 120))
        eq('text part stays first', content?.[0], { type: 'text', text: 'what is this?' })
        eq(
          'handle text names the image and its request dimensions',
          content?.[1],
          { type: 'text', text: requestImageHandleText(ref, { width: 64, height: 64 }, undefined) },
        )
        eq(
          'image part is an OpenAI vision data URL',
          content?.[2],
          {
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${Buffer.from('request-bytes:att_one').toString('base64')}` },
          },
        )
        eq('attachment read the projected target', store.calls.at(-1)?.target, {
          width: 64,
          height: 64,
          maxBytes: 1_048_576,
          maxImageBytes: 1_048_576,
          imageTargetBytes: 1_048_576,
        })
      }

      // ── 5. A text-only message keeps the string content shape ────────────
      {
        const body = await runTurn(adapter, urls, [userMessage([{ type: 'text', text: 'ping' }])])
        eq('text-only user content stays a string', body?.messages?.[0]?.content, 'ping')
      }

      // ── 6. Multiple images keep their order, and each keeps its bytes ────
      {
        const first = imageRef('att_first', { mediaType: 'image/jpeg' })
        const second = imageRef('att_second', { mediaType: 'image/webp' })
        const body = await runTurn(adapter, urls, [
          userMessage([
            { type: 'text', text: 'compare' },
            { type: 'image', attachment: first },
            { type: 'text', text: 'and' },
            { type: 'image', attachment: second },
          ]),
        ])
        const content = body?.messages?.[0]?.content ?? []
        const partTypes = content.map((part) => part.type)
        eq('parts keep the block order', partTypes, ['text', 'text', 'image_url', 'text', 'text', 'image_url'])
        eq(
          'first image keeps its media type',
          content?.[2]?.image_url?.url?.startsWith('data:image/jpeg;base64,'),
          true,
        )
        eq(
          'second image keeps its media type',
          content?.[5]?.image_url?.url?.startsWith('data:image/webp;base64,'),
          true,
        )
      }

      // ── 7. The handle text exposes the read-only path when one resolves ──
      {
        const pathStore = fakeAttachments({ hostPath: () => '/host/att_path.png' })
        const { adapter: pathAdapter } = adapterFor(urls, {
          attachments: pathStore,
          mapHostPath: (hostPath) => hostPath.replace('/host/', '/world/'),
        })
        const ref = imageRef('att_path')
        const body = await runTurn(pathAdapter, urls, [userMessage([{ type: 'image', attachment: ref }])])
        const content = body?.messages?.[0]?.content ?? []
        const expected = requestImageHandleText(ref, { width: 64, height: 64 }, { readonlyPath: '/world/att_path.png' })
        eq('handle text exposes the execution-world path', content?.[0], { type: 'text', text: expected })
        check('path text names the read-only copy', /\/world\/att_path\.png/.test(content?.[0]?.text ?? ''))
      }

      // ── 8. An offloaded image becomes placeholder text, never bytes ──────
      {
        const before = store.calls.length
        const ref = imageRef('att_offloaded')
        const body = await runTurn(adapter, urls, [
          userMessage([
            { type: 'text', text: 'see' },
            { type: 'image', attachment: ref, offloaded: true },
          ]),
        ])
        eq('offloaded image triggers no attachment read', store.calls.length, before)
        const content = body?.messages?.[0]?.content
        eq('offloaded image collapses back to a string', Array.isArray(content), false)
        eq('offloaded image leaves the harness placeholder', content, `see${offloadedImageText(ref, undefined)}`)
      }

      // ── 9. Tool messages carry image bytes in the array form ─────────────
      {
        const ref = imageRef('att_tool')
        const body = await runTurn(adapter, urls, [
          userMessage([{ type: 'text', text: 'take a screenshot' }]),
          {
            id: 'msg_assistant',
            role: 'assistant',
            content: [
              { type: 'tool-call', id: 'call_1', name: 'screenshot', arguments: '{}' },
            ],
            source: { kind: 'model', provider: PROVIDER, model: VISION_MODEL },
          },
          {
            id: 'msg_tool',
            role: 'tool',
            toolCallId: 'call_1',
            content: [
              { type: 'text', text: 'screenshot result' },
              { type: 'image', attachment: ref },
            ],
            source: { kind: 'tool', callId: 'call_1', name: 'screenshot' },
          },
        ])
        const tool = body?.messages?.find((message) => message.role === 'tool')
        check('tool content with an image is an array', Array.isArray(tool?.content))
        eq('tool text part survives', tool?.content?.[0], { type: 'text', text: 'screenshot result' })
        eq('tool handle text precedes the bytes', tool?.content?.[1]?.type, 'text')
        eq('tool image part is a data URL', tool?.content?.[2]?.type, 'image_url')
      }

      // ── 10. A retained image outside an input role is refused, not dropped ─
      {
        const error = await runTurnError(adapter, [
          {
            id: 'msg_assistant',
            role: 'assistant',
            content: [
              { type: 'text', text: 'earlier' },
              { type: 'image', attachment: imageRef('att_assistant') },
            ],
            source: { kind: 'model', provider: PROVIDER, model: VISION_MODEL },
          },
        ])
        eq('assistant-side image is refused', error?.code, 'UNSUPPORTED_CONTENT')
        check('refusal names the roles that can carry an image', /user content and tool results/.test(error?.message ?? ''))
      }

      // ── 10b. The same attachment twice reads once, serializes twice ──────
      {
        const before = store.calls.length
        const ref = imageRef('att_shared')
        const body = await runTurn(adapter, urls, [
          userMessage([{ type: 'image', attachment: ref }]),
          userMessage([{ type: 'image', attachment: ref }]),
        ])
        eq('shared attachment is read once', store.calls.length - before, 1)
        const parts = body?.messages?.map((message) => message.content).flat()
        eq('shared attachment is serialized per occurrence', parts?.filter((part) => part.type === 'image_url').length, 2)
      }
    })

    // ── 11. A model outside visionModels refuses an image up front ─────────
    await withServer(gateway(), async (urls) => {
      const { adapter } = adapterFor(urls, { attachments: fakeAttachments() })
      const error = await runTurnError(adapter, [userMessage([{ type: 'image', attachment: imageRef('att_x') }])], TEXT_MODEL)
      eq('unlisted model refuses an image', error?.code, 'UNSUPPORTED_CONTENT')
      eq('refusal happens before any chat request', urls.requests.length, 0)
      check('refusal names the setting', /visionModels/.test(error?.message ?? ''))
    })

    // ── 12. No attachment service is a clear refusal ───────────────────────
    await withServer(gateway(), async (urls) => {
      const { adapter } = adapterFor(urls)
      const error = await runTurnError(adapter, [userMessage([{ type: 'image', attachment: imageRef('att_y') }])])
      eq('missing attachment service refuses the image', error?.code, 'UNSUPPORTED_CONTENT')
      check('missing service message names the service', /attachment service/.test(error?.message ?? ''))
    })

    // ── 12b. Offloaded-only history needs no attachment service at all ─────
    await withServer(gateway(), async (urls) => {
      const { adapter } = adapterFor(urls)
      const ref = imageRef('att_already_offloaded')
      const body = await runTurn(adapter, urls, [
        userMessage([
          { type: 'text', text: 'see' },
          { type: 'image', attachment: ref, offloaded: true },
        ]),
        {
          id: 'msg_assistant',
          role: 'assistant',
          content: [{ type: 'image', attachment: imageRef('att_assistant_offloaded'), offloaded: true }],
          source: { kind: 'model', provider: PROVIDER, model: VISION_MODEL },
        },
      ])
      check('offloaded-only history keeps the placeholder', body?.messages?.[0]?.content === `see${offloadedImageText(ref, undefined)}`)
      check(
        'offloaded assistant image keeps a placeholder too',
        /image omitted to fit request image limits/.test(body?.messages?.[1]?.content ?? ''),
      )
    })

    // ── 12c. A text-only turn still works without the attachment service ───
    await withServer(gateway(), async (urls) => {
      const { adapter } = adapterFor(urls)
      const body = await runTurn(adapter, urls, [userMessage([{ type: 'text', text: 'ping' }])])
      eq('text-only turn without attachments keeps the string wire', body?.messages?.[0]?.content, 'ping')
    })

    // ── 13. Over-budget image bytes ask the harness to offload ─────────────
    await withServer(gateway(), async (urls) => {
      const store = fakeAttachments({ sizes: { att_a: 80, att_b: 80 } })
      const { adapter } = adapterFor(urls, { attachments: store, config: { maxRequestImageBytes: 100 } })
      const error = await runTurnError(adapter, [
        userMessage([
          { type: 'image', attachment: imageRef('att_a') },
          { type: 'image', attachment: imageRef('att_b') },
        ]),
      ])
      eq('over-budget request fails with IMAGE_OFFLOAD_REQUIRED', error?.code, 'IMAGE_OFFLOAD_REQUIRED')
      // 80-byte versions become 108 base64 bytes each; a 100-byte budget removes
      // both. A 'raw' representation regression would remove only one.
      eq('base64 budget counts every occurrence', error?.failure?.offloadImages, 2)
      eq('nothing was sent to the gateway', urls.requests.length, 0)
    })

    // ── 13b. A retained image outside an input role is refused before the ──
    //         budget can ask for an offload the harness cannot perform.
    await withServer(gateway(), async (urls) => {
      const store = fakeAttachments({ sizes: { att_assistant_big: 4_096 } })
      const { adapter } = adapterFor(urls, { attachments: store, config: { maxRequestImageBytes: 1 } })
      const error = await runTurnError(adapter, [
        {
          id: 'msg_assistant',
          role: 'assistant',
          content: [{ type: 'image', attachment: imageRef('att_assistant_big') }],
          source: { kind: 'model', provider: PROVIDER, model: VISION_MODEL },
        },
      ])
      eq('untransmitted image is a role refusal, not an offload request', error?.code, 'UNSUPPORTED_CONTENT')
    })

    // ── 14. An image refusal from the gateway is actionable, not AUTH ──────
    await withServer(
      gateway({
        onChat: refuseWith(400, {
          error: {
            code: 'invalid_argument',
            message: 'Invalid content type. image_url is only supported by certain models',
            type: 'invalid_request_error',
          },
        }),
      }),
      async (urls) => {
        const { adapter } = adapterFor(urls, { attachments: fakeAttachments() })
        const error = await runTurnError(adapter, [
          userMessage([{ type: 'image', attachment: imageRef('att_refused') }]),
        ])
        eq('gateway image refusal code', error?.code, 'UNSUPPORTED_CONTENT')
        check('refusal points at visionModels', /visionModels/.test(error?.message ?? ''))
        check('refusal does not tell the user to sign in', !/sign in/i.test(error?.message ?? ''))
        eq('refusal keeps the provider status', error?.failure?.status, 400)
      },
    )

    // ── 15. A 413 names the image budget setting ───────────────────────────
    await withServer(
      gateway({
        onChat: (req, res) => {
          res.writeHead(413, { 'Content-Type': 'text/plain' })
          res.end('Payload Too Large')
        },
      }),
      async (urls) => {
        const { adapter } = adapterFor(urls, { attachments: fakeAttachments() })
        const error = await runTurnError(adapter, [
          userMessage([{ type: 'image', attachment: imageRef('att_big') }]),
        ])
        eq('413 code', error?.code, 'INVALID_REQUEST')
        check('413 message names the budget setting', /maxRequestImageBytes/.test(error?.message ?? ''))
      },
    )

    // ── 16. Non-image 400s keep their own classification ───────────────────
    await withServer(
      gateway({ onChat: refuseWith(400, { error: { message: 'unsupported parameter: image detail' } }) }),
      async (urls) => {
        const { adapter } = adapterFor(urls, { attachments: fakeAttachments() })
        const error = await runTurnError(adapter, [
          userMessage([{ type: 'image', attachment: imageRef('att_generic') }]),
        ])
        eq('a generic 400 stays INVALID_REQUEST', error?.code, 'INVALID_REQUEST')
      },
    )
    await withServer(
      gateway({
        onChat: refuseWith(400, { error: { message: "This model's maximum context length is 128000 tokens" } }),
      }),
      async (urls) => {
        const { adapter } = adapterFor(urls, { attachments: fakeAttachments() })
        const error = await runTurnError(adapter, [
          userMessage([{ type: 'image', attachment: imageRef('att_window') }]),
        ])
        eq('a context-window 400 keeps CONTEXT_WINDOW_EXCEEDED', error?.code, 'CONTEXT_WINDOW_EXCEEDED')
      },
    )

    // ── 17. Cancellation reaches the attachment read and reports ABORTED ──
    await withServer(gateway(), async (urls) => {
      const controller = new AbortController()
      const slowStore = {
        imageHostPath: () => undefined,
        readImageRequest(ref, target, signal) {
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve({ attachment: ref, data: new Uint8Array(), bytes: 1, mediaType: ref.mediaType, width: target.width, height: target.height }), 5_000)
            const abort = () => {
              clearTimeout(timer)
              reject(signal.reason ?? new Error('aborted'))
            }
            if (signal?.aborted === true) abort()
            else signal?.addEventListener('abort', abort, { once: true })
          })
        },
      }
      const { adapter } = adapterFor(urls, { attachments: slowStore })
      const turn = (async () => {
        for await (const _chunk of adapter.stream({
          provider: PROVIDER,
          model: VISION_MODEL,
          messages: [userMessage([{ type: 'image', attachment: imageRef('att_slow') }])],
          signal: controller.signal,
        })) {
          // Drain.
        }
      })()
      setTimeout(() => controller.abort(new Error('test abort')), 25)
      let error
      try {
        await turn
      } catch (thrown) {
        error = thrown
      }
      eq('aborted image read reports ABORTED', error?.code, 'ABORTED')
      eq('aborted image read sends nothing', urls.requests.length, 0)
    })

    // ── 17b. A wedged attachment read is bounded by the idle watchdog ──────
    await withServer(gateway(), async (urls) => {
      const stuckStore = {
        imageHostPath: () => undefined,
        readImageRequest(ref, target, signal) {
          return new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true })
          })
        },
      }
      const { adapter } = adapterFor(urls, {
        attachments: stuckStore,
        config: { streamIdleTimeoutMs: 25 },
      })
      const error = await runTurnError(adapter, [userMessage([{ type: 'image', attachment: imageRef('att_stuck') }])])
      eq('wedged attachment read times out', error?.code, 'TIMEOUT')
      eq('wedged attachment read sends nothing', urls.requests.length, 0)
    })

    // ── 17c. An attachment-resolver failure keeps its own cause, not TRANSPORT ─
    await withServer(gateway(), async (urls) => {
      const failingStore = {
        imageHostPath() {
          throw new Error('resolver boom')
        },
        async readImageRequest(ref, target) {
          return { attachment: ref, data: new Uint8Array(), bytes: 1, mediaType: ref.mediaType, width: target.width, height: target.height }
        },
      }
      const { adapter } = adapterFor(urls, { attachments: failingStore })
      const error = await runTurnError(adapter, [userMessage([{ type: 'image', attachment: imageRef('att_broken') }])])
      check('resolver failure is not reported as a transport failure', error?.code !== 'TRANSPORT')
      check('resolver failure keeps its own message', /resolver boom/.test(error?.message ?? ''))
      eq('resolver failure sends nothing', urls.requests.length, 0)
    })

    // ── 18. A frozen text-only request serializes to the exact legacy body ─
    await withServer(gateway(), async (urls) => {
      const { adapter } = adapterFor(urls)
      const freeze = (message) => Object.freeze({ ...message, content: Object.freeze(message.content) })
      const messages = Object.freeze([
        freeze({ id: 'msg_system', role: 'system', content: [{ type: 'text', text: 'SYS' }] }),
        freeze({
          id: 'msg_assistant',
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'think' },
            { type: 'tool-call', id: 'call_1', name: 'probe', arguments: '{}' },
          ],
          source: { kind: 'model', provider: PROVIDER, model: VISION_MODEL },
        }),
        freeze({
          id: 'msg_tool',
          role: 'tool',
          toolCallId: 'call_1',
          content: [{ type: 'text', text: 'result' }],
          source: { kind: 'tool', callId: 'call_1', name: 'probe' },
        }),
        freeze({ id: 'msg_user', role: 'user', content: [{ type: 'text', text: 'go' }] }),
      ])
      for await (const _chunk of adapter.stream({ provider: PROVIDER, model: VISION_MODEL, messages, tools: [] })) {
        // Drain.
      }
      eq('frozen text-only body matches the pre-image wire shape', chatBodyOf(urls.requests)?.messages, [
        { role: 'system', content: 'SYS' },
        {
          role: 'assistant',
          content: '',
          reasoning_content: 'think',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'probe', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'result' },
        { role: 'user', content: 'go' },
      ])
    })

    // ── 19. Catalog fetch still works with the new configuration ───────────
    {
      const result = await withServer(gateway(), ({ modelsURL }) => fetchCatalog({ modelsURL }))
      check('catalog fetch stays successful', result.ok === true)
      eq('catalog ids are unchanged by the image configuration', result.catalog.map((entry) => entry.id), [
        VISION_MODEL,
        TEXT_MODEL,
      ])
    }
  } finally {
    cleanup()
  }

  if (failures > 0) {
    console.error(`\nFAIL: ${failures} check(s) failed.`)
    process.exit(1)
  }
  console.log('\nPASS: image input advertisement, serialization, and refusals hold.')
  process.exit(0)
}

await main()
