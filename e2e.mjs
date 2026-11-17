/**
 * End-to-end check: registers the plugin through the real DSH `LlmRuntime` and
 * exercises the live CANNBOT gateway through the harness seam — catalog, model
 * resolution, a text+reasoning turn, a tool call, a multi-turn tool result, and
 * an image turn carried as a real attachment reference.
 *
 * Requires (see README § 3):
 *   1. `npm install`
 *   2. CANNWork signed in — the JWT and VK come from its opencode files
 *
 * Exits 0 when every assertion passes, 1 otherwise.
 */
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import * as plugin from './lib/index.js'

let failures = 0

const fail = (message) => {
  console.error(`FAIL: ${message}`)
  failures += 1
}

const ok = (message) => console.log(`ok   ${message}`)

// ── credentials ──────────────────────────────────────────────────────────────
const jwt = plugin.readJwt()
const vk = plugin.readAccountVk()
console.log(`jwt: ${jwt === undefined ? 'MISSING' : 'present'}`)
console.log(`vk : ${vk === undefined ? 'MISSING' : 'present'}`)
if (jwt === undefined || vk === undefined) {
  fail(
    'CANNWork sign-in not found. Open CANNWork (cannbot-toolkit) in VS Code/Cursor and sign in;\n' +
      '      it writes session.json (JWT) under ~/.local/share/opencode and auth.json (VK) under ~/.config/opencode.',
  )
  process.exit(1)
}

// ── register through the real seam ───────────────────────────────────────────
const ctx = new Context()
ctx.logger = {
  info: (...a) => console.log('[info]', ...a),
  warn: (...a) => console.warn('[warn]', ...a),
  error: (...a) => console.error('[error]', ...a),
}
new LlmRuntime(ctx)
const release = plugin.apply(ctx)
console.log(`providers: ${ctx.llm.listProviders().map((p) => p.id).join(', ')}`)

// The catalog is fetched in the background after registration; poll instead of
// racing a fixed sleep.
let models = []
for (let attempt = 0; attempt < 20; attempt++) {
  models = await ctx.llm.listModels(plugin.PROVIDER)
  if (models.length > 1) break
  await new Promise((resolve) => setTimeout(resolve, 500))
}
console.log(`models: ${models.length} -> ${models.map((m) => m.id).join(', ')}`)
if (models.length < 2) fail('the live catalog did not load (still on the fallback model)')

const target = models.find((m) => m.id.includes('flash')) ?? models[0]
const info = await ctx.llm.resolveModelInfo(plugin.PROVIDER, target.id)
console.log(
  `resolve ${target.id}: context=${info.context?.contextWindow} efforts=${info.reasoning?.efforts?.map((e) => e.id).join('/') ?? 'none'} input=${info.inputModalities?.join('+')}`,
)
if (info.context?.contextWindow === undefined) fail('resolveModelInfo returned no context window')
if ((info.reasoning?.efforts ?? []).length === 0) fail('resolveModelInfo advertised no reasoning efforts')

// Modality advertisement decides whether the harness admits an image at all
// (and whether it substitutes the text-only placeholder), so check both
// directions against the live catalog.
const visionTarget = models.find((m) => (m.inputModalities ?? []).includes('image'))
const textOnlyTarget = models.find(
  (m) => m.inputModalities !== undefined && !m.inputModalities.includes('image'),
)
if (visionTarget === undefined) fail('no catalog model advertises image input')
else ok(`vision model: ${visionTarget.id} advertises ${visionTarget.inputModalities.join('+')}`)
if (textOnlyTarget === undefined) fail('no catalog model advertises text-only input')
else {
  const textInfo = await ctx.llm.resolveModelInfo(plugin.PROVIDER, textOnlyTarget.id)
  if ((textInfo.inputModalities ?? []).includes('image')) fail(`${textOnlyTarget.id} resolves as image-capable`)
  else ok(`text-only model: ${textOnlyTarget.id} resolves without image`)
}

/**
 * A 64x64 solid blue PNG. The image turn asserts the model names the colour, so
 * the bytes must really reach the gateway — a placeholder substitution could not
 * produce it.
 */
const BLUE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAn0lEQVRoge2SQQkAQRDDqqTCTnvErIh7hIFCBKSh6cdpoht0A9ArdhfiLtENugHoFbsLcZfoBt0A9IrdhbhLdINuAHrF7kLcJbpBNwC9Ynch7hLdoBuAXrG7EHeJbtANQK/YXYi7RDfoBqBX7C7EXaIbdAPQK3YX4i7RDboB6BW7C3GX6AbdAPSK3YW4S3SDbgB6xe5C3CW6QTcAveIfHlsmQTwiFSCUAAAAAElFTkSuQmCC'

// Production mounts a durable attachment store; this script only needs the
// request-version bytes the adapter asks for, so provide the minimum surface.
const imageBytes = Buffer.from(BLUE_PNG_BASE64, 'base64')
ctx.provide('attachments', {
  imageHostPath: () => undefined,
  async readImageRequest(ref) {
    return {
      variantId: 'variant-e2e',
      attachment: ref,
      data: imageBytes,
      mediaType: ref.mediaType,
      bytes: imageBytes.length,
      width: ref.width,
      height: ref.height,
      depth: 'uchar',
      space: 'srgb',
      hasAlpha: false,
    }
  },
})

/** Stream one call and return the assembled chunks plus the terminal reason. */
async function stream(options, model = target.id) {
  const chunks = []
  for await (const chunk of ctx.llm.stream({ provider: plugin.PROVIDER, model, ...options })) {
    chunks.push(chunk)
  }
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
  const toolCalls = chunks
    .filter((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    .map((c) => c.block)
  return { chunks, text, reasoning, toolCalls, finish: chunks.find((c) => c.type === 'finish') }
}

/** Provider prompt tokens of one turn, from its usage chunk. */
const promptTokensOf = (turn) => {
  const usage = turn.chunks.find((c) => c.type === 'usage')?.usage
  return usage === undefined ? undefined : usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
}

const userMessage = (text) => ({
  id: 'msg_e2e',
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})

// ── plain turn ───────────────────────────────────────────────────────────────
const plain = await stream({ messages: [userMessage('Reply with exactly: PONG')] })
console.log(`plain: finish=${JSON.stringify(plain.finish?.reason)} text=${JSON.stringify(plain.text)} reasoning=${plain.reasoning.length}ch`)
if (plain.finish?.reason?.kind !== 'stop') fail(`plain turn did not stop cleanly: ${JSON.stringify(plain.finish?.reason)}`)
else if (!plain.text.includes('PONG')) fail(`expected "PONG", got ${JSON.stringify(plain.text)}`)
else ok('text turn returned the expected reply')

const usageChunk = plain.chunks.find((c) => c.type === 'usage')
if (usageChunk === undefined) fail('no usage chunk was emitted')
else {
  const usage = usageChunk.usage
  const billed = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  if (!(billed > 0 && usage.outputTokens > 0)) {
    fail(`usage looks wrong: ${JSON.stringify(usage)}`)
  } else if (usage.totalTokens !== undefined && billed + usage.outputTokens !== usage.totalTokens) {
    // The harness contract counts are DISJOINT, so the three prompt-side
    // buckets plus output must add up to the provider's own aggregate total.
    fail(`usage buckets are not disjoint with the provider total: ${JSON.stringify(usage)}`)
  } else {
    ok(
      `usage is disjoint (in=${usage.inputTokens} cacheRead=${usage.cacheReadTokens ?? 0} ` +
        `out=${usage.outputTokens} total=${usage.totalTokens ?? 'n/a'})`,
    )
  }
}

// ── tool call ────────────────────────────────────────────────────────────────
const weatherTool = {
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string', description: 'City name' } },
    required: ['city'],
  },
}
const toolTurn = await stream({
  messages: [userMessage('What is the weather in Beijing right now? Call the weather tool.')],
  tools: [weatherTool],
})
console.log(
  `tool : finish=${JSON.stringify(toolTurn.finish?.reason)} calls=${toolTurn.toolCalls.map((c) => `${c.name}(${c.arguments})`).join(' ')}`,
)
if (toolTurn.toolCalls.length === 0) fail('the model did not emit a tool call')
else if (toolTurn.finish?.reason?.kind !== 'tool-calls') {
  fail(`tool turn finished as ${JSON.stringify(toolTurn.finish?.reason)} instead of tool-calls`)
} else {
  const call = toolTurn.toolCalls[0]
  let args
  try {
    args = JSON.parse(call.arguments)
  } catch (error) {
    fail(`tool arguments are not JSON: ${call.arguments}`)
  }
  if (args !== undefined) {
    if (call.name !== 'get_weather') fail(`unexpected tool name ${call.name}`)
    else if (typeof args.city !== 'string' || args.city === '') fail(`tool arguments lack a city: ${call.arguments}`)
    else ok(`tool call assembled (${call.name} city=${args.city}, id=${call.id})`)
  }
}

// ── multi-turn: replay the tool call and its result ──────────────────────────
if (toolTurn.toolCalls.length > 0) {
  const call = toolTurn.toolCalls[0]
  const followUp = await stream({
    messages: [
      userMessage('What is the weather in Beijing right now? Call the weather tool.'),
      {
        id: 'msg_e2e_assistant',
        role: 'assistant',
        content: [
          { type: 'reasoning', text: toolTurn.reasoning },
          { type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments },
        ],
        source: { kind: 'model', provider: plugin.PROVIDER, model: target.id },
      },
      {
        id: 'msg_e2e_tool',
        role: 'tool',
        toolCallId: call.id,
        content: [{ type: 'text', text: 'Beijing: sunny, 25C, light wind.' }],
        source: { kind: 'tool', callId: call.id, name: call.name },
      },
    ],
    tools: [weatherTool],
  })
  console.log(`replay: finish=${JSON.stringify(followUp.finish?.reason)} text=${JSON.stringify(followUp.text.slice(0, 120))}`)
  if (followUp.finish?.reason?.kind !== 'stop') {
    fail(`tool-result replay did not finish cleanly: ${JSON.stringify(followUp.finish?.reason)}`)
  } else if (followUp.text.trim() === '') {
    fail('tool-result replay produced no text')
  } else ok('tool result replayed into a final answer')
}

// ── image turn ───────────────────────────────────────────────────────────────
if (visionTarget !== undefined) {
  const imageRef = {
    attachmentId: 'att_e2e_blue',
    mediaType: 'image/png',
    bytes: imageBytes.length,
    width: 64,
    height: 64,
    name: 'e2e-blue.png',
  }
  const imageTurn = await stream(
    {
      messages: [
        {
          id: 'msg_e2e_image',
          role: 'user',
          content: [
            { type: 'text', text: 'What is the dominant colour of this image? Answer with one word.' },
            { type: 'image', attachment: imageRef },
          ],
          source: { kind: 'user' },
        },
      ],
    },
    visionTarget.id,
  )
  console.log(`image: finish=${JSON.stringify(imageTurn.finish?.reason)} text=${JSON.stringify(imageTurn.text.slice(0, 80))}`)
  if (imageTurn.finish?.reason?.kind !== 'stop') fail(`image turn did not stop cleanly: ${JSON.stringify(imageTurn.finish?.reason)}`)
  else if (!/blue/i.test(`${imageTurn.text} ${imageTurn.reasoning}`)) {
    fail(`the model did not identify the image colour: ${JSON.stringify(imageTurn.text.slice(0, 160))}`)
  } else ok('image bytes reached the model through the live gateway')

  const plainPrompt = promptTokensOf(plain)
  const imagePrompt = promptTokensOf(imageTurn)
  if (plainPrompt === undefined || imagePrompt === undefined) fail('image turn produced no usage chunk')
  else if (!(imagePrompt > plainPrompt)) {
    fail(`image turn did not bill extra prompt tokens (plain=${plainPrompt} image=${imagePrompt})`)
  } else ok(`image turn bills visual tokens (plain=${plainPrompt} image=${imagePrompt})`)

  // A screenshot tool result carries an image in tool content, which the
  // adapter sends as a tool message whose content is a part array. Verify the
  // gateway really reads that shape instead of trusting the schema assumption.
  const toolImageTurn = await stream(
    {
      messages: [
        {
          id: 'msg_e2e_tool_image_user',
          role: 'user',
          content: [{ type: 'text', text: 'Take a screenshot of the page.' }],
          source: { kind: 'user' },
        },
        {
          id: 'msg_e2e_tool_image_assistant',
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'call_e2e_shot', name: 'screenshot', arguments: '{}' }],
          source: { kind: 'model', provider: plugin.PROVIDER, model: visionTarget.id },
        },
        {
          id: 'msg_e2e_tool_image_result',
          role: 'tool',
          toolCallId: 'call_e2e_shot',
          content: [
            { type: 'text', text: 'Screenshot result:' },
            { type: 'image', attachment: imageRef },
          ],
          source: { kind: 'tool', callId: 'call_e2e_shot', name: 'screenshot' },
        },
      ],
    },
    visionTarget.id,
  )
  console.log(
    `tool-image: finish=${JSON.stringify(toolImageTurn.finish?.reason)} text=${JSON.stringify(toolImageTurn.text.slice(0, 80))}`,
  )
  if (toolImageTurn.finish?.reason?.kind !== 'stop') {
    fail(`tool-result image turn did not stop cleanly: ${JSON.stringify(toolImageTurn.finish?.reason)}`)
  } else if (!/blue/i.test(`${toolImageTurn.text} ${toolImageTurn.reasoning}`)) {
    fail(`the model did not read the tool-result image: ${JSON.stringify(toolImageTurn.text.slice(0, 160))}`)
  } else ok('tool-result image bytes reached the model in the tool message')
}

release()

if (failures > 0) {
  console.error(`\nFAIL: ${failures} check(s) failed.`)
  process.exit(1)
}
console.log('\nPASS: CANNBOT is reachable through the DSH LLM seam.')
process.exit(0)
