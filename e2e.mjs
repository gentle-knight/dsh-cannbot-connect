/**
 * End-to-end check: registers the plugin through the real DSH `LlmRuntime`
 * and streams one request to the live CANNBOT gateway.
 *
 * Requires (see README § 5):
 *   1. `npm install`
 *   2. CANNWork signed in — the JWT and VK come from its opencode files
 *
 * Exits 0 on success, 1 on any failed assertion.
 */
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import * as plugin from './lib/index.js'

const fail = (message) => {
  console.error(`\nFAIL: ${message}`)
  process.exit(1)
}

// ── credentials ──────────────────────────────────────────────────────────────
const jwt = plugin.readJwt()
const vk = plugin.readAccountVk()
console.log(`jwt: ${jwt === undefined ? 'MISSING' : 'present'}`)
console.log(`vk : ${vk === undefined ? 'MISSING' : 'present'}`)
if (jwt === undefined || vk === undefined) {
  fail(
    'CANNWork sign-in not found. Open CANNWork (cannbot-toolkit) in VS Code/Cursor and sign in,\n' +
      '      which writes ~/.local/share/opencode/session.json (JWT) and auth.json (VK).',
  )
}

// ── register ─────────────────────────────────────────────────────────────────
const ctx = new Context()
ctx.logger = {
  info: (...a) => console.log('[info]', ...a),
  warn: (...a) => console.warn('[warn]', ...a),
  error: (...a) => console.error('[error]', ...a),
}
new LlmRuntime(ctx)
const release = plugin.apply(ctx)
console.log(`providers: ${ctx.llm.listProviders().map((p) => p.id).join(', ')}`)

// ── catalog ──────────────────────────────────────────────────────────────────
// The plugin fetches the roster in the background after registering; wait for
// it without racing a fixed sleep.
let models = []
for (let attempt = 0; attempt < 20; attempt++) {
  models = await ctx.llm.listModels(plugin.CANNBOT_PROVIDER)
  if (models.length > 1) break
  await new Promise((resolve) => setTimeout(resolve, 500))
}
console.log(`live models: ${models.length} -> ${models.map((m) => m.id).join(', ')}`)
if (models.length < 2) {
  fail('the live catalog did not load (still serving the fallback model); check the JWT expiry')
}

// ── resolve ──────────────────────────────────────────────────────────────────
const target = models.find((m) => m.id.includes('flash')) ?? models[0]
const info = await ctx.llm.resolveModelInfo(plugin.CANNBOT_PROVIDER, target.id)
console.log(`resolved ${target.id}: context=${info.context?.contextWindow} efforts=${info.reasoning?.efforts?.map((e) => e.id).join('/') ?? 'none'}`)

// ── stream ───────────────────────────────────────────────────────────────────
const prepared = await ctx.llm.prepareCall(
  { provider: plugin.CANNBOT_PROVIDER, model: target.id },
  new AbortController().signal,
)
const chunks = []
for await (const chunk of ctx.llm.stream({
  ...prepared.config,
  messages: [
    {
      id: 'msg_e2e_1',
      role: 'user',
      content: [{ type: 'text', text: 'Reply with exactly: PONG' }],
      source: { kind: 'user' },
    },
  ],
})) {
  chunks.push(chunk)
}

const finish = chunks.find((c) => c.type === 'finish')
const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')

console.log(`finish: ${JSON.stringify(finish?.reason)}`)
console.log(`text  : ${JSON.stringify(text)}`)
console.log(`reason: ${reasoning.length} chars`)

release()

if (finish?.reason?.kind !== 'stop') {
  fail(`stream did not finish cleanly: ${JSON.stringify(finish?.reason)}`)
}
if (!text.includes('PONG')) {
  fail(`expected "PONG" in the reply, got ${JSON.stringify(text)}`)
}

console.log('\nPASS: CANNBOT is reachable through the DSH LLM seam.')
process.exit(0)
