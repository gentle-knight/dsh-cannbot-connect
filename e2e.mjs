/**
 * End-to-end check against the REAL DSH kernel (extracted from app.asar):
 * the plugin's `apply()` registers through the real `LlmRuntime`, and one
 * request streams through the real `dsh-llm-pi-ai` adapter to the live
 * CANNBOT gateway.
 */
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import * as plugin from './lib/index.js'

console.log('jwt:', plugin.readJwt() === undefined ? 'MISSING' : 'present')
console.log('vk :', plugin.readAccountVk() === undefined ? 'MISSING' : 'present')

const ctx = new Context()
ctx.logger = {
  info: (...a) => console.log('[info]', ...a),
  warn: (...a) => console.warn('[warn]', ...a),
  error: (...a) => console.error('[error]', ...a),
}
new LlmRuntime(ctx)

const release = plugin.apply(ctx)
console.log('providers:', ctx.llm.listProviders().map((p) => p.id).join(', '))

// Give the fire-and-forget catalog fetch a moment to land.
await new Promise((r) => setTimeout(r, 5000))
const models = await ctx.llm.listModels(plugin.CANNBOT_PROVIDER)
console.log('live models:', models.length, '->', models.map((m) => m.id).join(', '))

const target = models.find((m) => m.id.includes('flash')) ?? models[0]
console.log('streaming from:', target.id)

const info = await ctx.llm.resolveModelInfo(plugin.CANNBOT_PROVIDER, target.id)
console.log('resolved info:', JSON.stringify(info))

const prepared = await ctx.llm.prepareCall({ provider: plugin.CANNBOT_PROVIDER, model: target.id }, new AbortController().signal)
const chunks = []
for await (const chunk of ctx.llm.stream({
  ...prepared.config,
  messages: [
    {
      id: 'msg_test_1',
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
console.log('finish:', JSON.stringify(finish))
console.log('text  :', JSON.stringify(text))
console.log('reason:', reasoning.length, 'chars')
release()
process.exit(0)
