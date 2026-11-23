/**
 * Offline checks for model metadata and the image/file request budget.
 *
 * `resolveModel` drives the GUI's context label, the default output cap, and
 * whether the host admits an image at all; `prepareImages` decides when a
 * request must be offloaded and when a file block is a caller error. These are
 * pure adapter/image-layer checks, so they need neither a gateway nor the real
 * attachment store.
 */
import { Config } from '../lib/config.js'
import { CannbotAdapter } from '../lib/adapter.js'
import { prepareImages } from '../lib/images.js'
import { toMessages } from '../lib/wire.js'

let failures = 0
const fail = (message) => {
  console.error(`FAIL: ${message}`)
  failures += 1
}
const ok = (message) => console.log(`ok   ${message}`)

const eq = (label, actual, expected) => {
  const same = Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected)
  if (same) ok(`${label} = ${JSON.stringify(actual)}`)
  else fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

const check = (label, predicate, detail) => {
  if (predicate) ok(label)
  else fail(`${label}${detail === undefined ? '' : `: ${detail}`}`)
}

const CATALOG = [
  { id: 'vision-model', name: 'Vision', contextWindow: 1000.7, maxTokens: 5000 },
  { id: 'text-model', name: 'Text', contextWindow: 2048 },
  { id: 'unsized-model', name: 'Unsized' },
]

const config = Config({ visionModels: ['vision-model'] })
const adapter = new CannbotAdapter(config)
adapter.adoptCatalog(CATALOG)

// ── listModels ──────────────────────────────────────────────────────────────
const models = await adapter.listModels('cannbot')
eq('listModels uses the requested provider', models[0]?.provider, 'cannbot')
eq('listModels advertises image only for the measured model', models.find((m) => m.id === 'vision-model')?.inputModalities, ['text', 'image'])
eq('listModels advertises text for the rest', models.find((m) => m.id === 'text-model')?.inputModalities, ['text'])

// ── resolveModel ────────────────────────────────────────────────────────────
const vision = await adapter.resolveModel('cannbot', 'vision-model')
eq('a float context window is floored', vision.context?.contextWindow, 1000)
eq('defaultMaxTokens is clamped to the context window', vision.defaultMaxTokens, 1000)
eq('reasoning offers the six gateway levels', vision.reasoning?.efforts?.map((e) => e.id), [
  'minimal',
  'low',
  'medium',
  'high',
  'max',
  'xhigh',
])

const text = await adapter.resolveModel('cannbot', 'text-model')
eq('a model without maxTokens is capped by its own context', text.defaultMaxTokens, 2048)
eq('a text model advertises text only', text.inputModalities, ['text'])

const unsized = await adapter.resolveModel('cannbot', 'unsized-model')
eq('a model the catalog did not size uses the configured context', unsized.context?.contextWindow, config.defaultContextWindow)
eq('an unknown model still resolves its id', unsized.id, 'unsized-model')

// ── imageRequestTarget ──────────────────────────────────────────────────────
const target = adapter.imageRequestTarget('cannbot', 'vision-model', { width: 4096, height: 4096 })
check('an oversized image is scaled inside the pixel budget', target.width * target.height <= config.requestImagePixelBudget)
check('the target carries the encoded-byte cap', target.maxBytes === config.requestImageMaxBytes)
const small = adapter.imageRequestTarget('cannbot', 'vision-model', { width: 32, height: 16 })
eq('a small image is not enlarged', [small.width, small.height], [32, 16])

// ── image budget: count and bytes ───────────────────────────────────────────
const imageRef = (id) => ({
  attachmentId: id,
  mediaType: 'image/png',
  bytes: 6,
  width: 16,
  height: 16,
  name: `${id}.png`,
})
const userMessage = (content) => ({ id: 'msg_user', role: 'user', content })
const attachmentService = {
  async readImageRequest(ref) {
    return {
      variantId: `v-${ref.attachmentId}`,
      attachment: ref,
      data: Buffer.alloc(ref.bytes),
      mediaType: ref.mediaType,
      bytes: ref.bytes,
      width: ref.width,
      height: ref.height,
      depth: 'uchar',
      space: 'srgb',
      hasAlpha: false,
    }
  },
}
const deps = { resolveAttachments: () => attachmentService, resolveImageAccess: () => undefined }

/** Prepare one request and return the thrown failure, if any. */
async function prepare(messages, overrides = {}) {
  try {
    return await prepareImages({ model: 'vision-model', messages }, Config({ visionModels: ['vision-model'], ...overrides }), deps)
  } catch (error) {
    return error
  }
}

const one = await prepare([userMessage([{ type: 'image', attachment: imageRef('a1') }])], {
  maxRequestImages: 1,
  imageOffloadCountQuantum: 1,
})
check('one image inside the count budget prepares', one?.versions?.size === 1, one?.message)

const countOver = await prepare(
  [
    userMessage([
      { type: 'image', attachment: imageRef('a1') },
      { type: 'image', attachment: imageRef('a2') },
    ]),
  ],
  { maxRequestImages: 1, imageOffloadCountQuantum: 1 },
)
eq('a count overflow fails with IMAGE_OFFLOAD_REQUIRED', countOver?.code, 'IMAGE_OFFLOAD_REQUIRED')
eq('the failure names the oldest occurrence count', countOver?.failure?.offloadImages, 1)

const byteOver = await prepare(
  [
    userMessage([
      { type: 'image', attachment: imageRef('b1') },
      { type: 'image', attachment: imageRef('b2') },
    ]),
  ],
  { maxRequestImages: 1_000, imageOffloadCountQuantum: 1, maxRequestImageBytes: 10 },
)
eq('a byte overflow fails with IMAGE_OFFLOAD_REQUIRED', byteOver?.code, 'IMAGE_OFFLOAD_REQUIRED')
eq('the byte overflow counts the bytes that must go', byteOver?.failure?.offloadImages, 1)

// ── file blocks are a caller error ──────────────────────────────────────────
const fileBlockError = (() => {
  try {
    toMessages({ messages: [userMessage([{ type: 'file', attachment: { attachmentId: 'f1', name: 'a.pdf' } }])] })
    return undefined
  } catch (error) {
    return error
  }
})()
eq('a file block reaching the wire is refused', fileBlockError?.code, 'UNSUPPORTED_CONTENT')
check('the file refusal explains the host projection', /projects file attachments to text handles/.test(fileBlockError?.message ?? ''))

// ── a text-only model refuses an image before serialization ────────────────
let textOnlyError
try {
  await prepareImages(
    { model: 'text-model', messages: [userMessage([{ type: 'image', attachment: imageRef('c1') }])] },
    Config({ visionModels: ['vision-model'] }),
    deps,
  )
} catch (error) {
  textOnlyError = error
}
eq('a text-only model refuses the image', textOnlyError?.code, 'UNSUPPORTED_CONTENT')
check('the refusal names the setting', /visionModels/.test(textOnlyError?.message ?? ''))

if (failures > 0) {
  console.error(`\nFAIL: ${failures} adapter metadata/budget check(s) failed.`)
  process.exit(1)
}
console.log('\nPASS: model metadata, image budgets, and file refusals hold.')
