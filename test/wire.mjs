/**
 * Offline checks for the wire translation layer: harness messages/tools to an
 * OpenAI-compatible request body, and SSE framing.
 *
 * These are pure functions, so the checks are deterministic and need no
 * gateway. The golden body here is the shape the live `e2e.mjs` sends; keeping
 * it pinned means a refactor cannot quietly change reasoning replay, tool-call
 * ids, or the `stream_options` flag that makes usage available.
 */
import { frameData, sseFrames, STREAM_DONE, toMessages, toRequestBody, toTools } from '../lib/wire.js'

let failures = 0
const fail = (message) => {
  console.error(`FAIL: ${message}`)
  failures += 1
}
const ok = (message) => console.log(`ok   ${message}`)

const eq = (label, actual, expected) => {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  if (same) ok(`${label} = ${JSON.stringify(actual)}`)
  else fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

const check = (label, predicate, detail) => {
  if (predicate) ok(label)
  else fail(`${label}${detail === undefined ? '' : `: ${detail}`}`)
}

const text = (value) => ({ type: 'text', text: value })
const user = (content) => ({ id: 'msg_user', role: 'user', content })
const assistant = (content) => ({ id: 'msg_assistant', role: 'assistant', content })
const tool = (content) => ({ id: 'msg_tool', role: 'tool', toolCallId: 'call_1', content })

// ── message translation ─────────────────────────────────────────────────────

eq(
  'plain text turn keeps a string content',
  toMessages({ messages: [user([text('go')])] }),
  [{ role: 'user', content: 'go' }],
)

eq(
  'leading system text is a system message',
  toMessages({ system: 'SYS', messages: [user([text('go')])] }),
  [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'go' },
  ],
)

eq(
  'assistant reasoning is replayed as reasoning_content',
  toMessages({
    messages: [
      assistant([
        { type: 'reasoning', text: 'think' },
        text('answer'),
      ]),
    ],
  }),
  [{ role: 'assistant', content: 'answer', reasoning_content: 'think' }],
)

eq(
  'assistant tool calls replay with their ids and JSON arguments',
  toMessages({
    messages: [
      assistant([
        text(''),
        { type: 'tool-call', id: 'call_1', name: 'probe', arguments: '{"a":1}' },
      ]),
    ],
  }),
  [
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'probe', arguments: '{"a":1}' } }],
    },
  ],
)

eq(
  'tool result stays a string when it carries no image',
  toMessages({ messages: [tool([text('result')])] }),
  [{ role: 'tool', tool_call_id: 'call_1', content: 'result' }],
)

eq(
  'developer messages are accepted as system text',
  toMessages({ messages: [{ role: 'developer', content: [text('DEV')] }] }),
  [{ role: 'system', content: 'DEV' }],
)

// An empty text block must not produce a content array; the gateway reads a
// string for a text-only turn and the harness compares a replayed request by
// the exact bytes it sent.
eq('empty text blocks collapse to an empty string', toMessages({ messages: [user([])] }), [{ role: 'user', content: '' }])

// ── tools ───────────────────────────────────────────────────────────────────

eq(
  'tool schemas map to OpenAI function definitions',
  toTools([{ name: 'probe', description: 'Probe it', parameters: { type: 'object', properties: {} } }]),
  [
    {
      type: 'function',
      function: {
        name: 'probe',
        description: 'Probe it',
        parameters: { type: 'object', properties: {} },
      },
    },
  ],
)
eq('no tools means the field is omitted', toTools([]), undefined)

// ── body ────────────────────────────────────────────────────────────────────

const body = toRequestBody({
  model: 'model-a',
  messages: [user([text('go')])],
  temperature: 0.2,
  maxTokens: 64,
  stop: ['END'],
  reasoningEffort: 'high',
})
eq('body model', body.model, 'model-a')
eq('body requests streaming usage', body.stream_options, { include_usage: true })
eq('body temperature', body.temperature, 0.2)
eq('body max_tokens', body.max_tokens, 64)
eq('body stop', body.stop, ['END'])
eq('body reasoning_effort', body.reasoning_effort, 'high')
check('body has no undefined tool field', !('tools' in body))
check('body stream is true', body.stream === true)

const withTools = toRequestBody({
  model: 'model-a',
  messages: [user([text('go')])],
  tools: [{ name: 'probe', description: 'Probe it', parameters: { type: 'object' } }],
})
check('body carries tools when supplied', Array.isArray(withTools.tools) && withTools.tools.length === 1)

// ── SSE framing ─────────────────────────────────────────────────────────────

eq('frame data is extracted', frameData('data: {"a":1}'), '{"a":1}')
eq('a comment frame has no data', frameData(': keep-alive'), undefined)
eq('[DONE] is the sentinel', frameData('data: [DONE]'), STREAM_DONE)
eq('multi-line data is joined', frameData('data: one\ndata: two'), 'one\ntwo')
eq('CRLF is tolerated', frameData('data: {"a":1}\r\n'), '{"a":1}')
eq('a leading space after data: is stripped', frameData('data:  {"a":1}'), ' {"a":1}')

/** Turn an array of chunks into a web ReadableStream. */
function streamOf(chunks) {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

/** Collect every framed payload from a chunk list. */
async function framesOf(chunks) {
  const out = []
  for await (const frame of sseFrames(streamOf(chunks))) out.push(frame)
  return out
}

const frames = await framesOf([
  'data: {"i":1}\n',
  '\ndata: {"i":2}\n\n',
  ': comment\n\n',
  'data: [DONE]\n\n',
])
eq('sseFrames reassembles frames split across reads', frames.slice(0, 2), ['{"i":1}', '{"i":2}'])
check('sseFrames returns the done sentinel', frames[2] === STREAM_DONE)

const tail = await framesOf(['data: {"i":3}'])
eq('a trailing frame without a blank line is still delivered', tail, ['{"i":3}'])

const crlf = await framesOf(['data: {"i":4}\r\n\r\ndata: [DONE]\r\n\r\n'])
eq('CRLF frames are reassembled', crlf.slice(0, 1), ['{"i":4}'])
check('CRLF done frame returns the sentinel', crlf[1] === STREAM_DONE)

if (failures > 0) {
  console.error(`\nFAIL: ${failures} wire check(s) failed.`)
  process.exit(1)
}
console.log('\nPASS: the wire translation and SSE framing are pinned.')
