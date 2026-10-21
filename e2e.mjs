/**
 * End-to-end check: registers the plugin through the real DSH `LlmRuntime` and
 * exercises the live CANNBOT gateway through the harness seam — catalog, model
 * resolution, a text+reasoning turn, a tool call, and a multi-turn tool result.
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
      '      it writes ~/.local/share/opencode/session.json (JWT) and auth.json (VK).',
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

/** Stream one call and return the assembled chunks plus the terminal reason. */
async function stream(options) {
  const chunks = []
  for await (const chunk of ctx.llm.stream({ provider: plugin.PROVIDER, model: target.id, ...options })) {
    chunks.push(chunk)
  }
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
  const toolCalls = chunks
    .filter((c) => c.type === 'block-end' && c.block.type === 'tool-call')
    .map((c) => c.block)
  return { chunks, text, reasoning, toolCalls, finish: chunks.find((c) => c.type === 'finish') }
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
else if (!(usageChunk.usage.inputTokens > 0 && usageChunk.usage.outputTokens > 0)) {
  fail(`usage looks wrong: ${JSON.stringify(usageChunk.usage)}`)
} else ok(`usage reported (in=${usageChunk.usage.inputTokens} out=${usageChunk.usage.outputTokens})`)

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

release()

if (failures > 0) {
  console.error(`\nFAIL: ${failures} check(s) failed.`)
  process.exit(1)
}
console.log('\nPASS: CANNBOT is reachable through the DSH LLM seam.')
process.exit(0)
