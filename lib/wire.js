import { assertNoFileBlocks, toContent } from './images.js'

/** Sentinel marking the end of an SSE stream. */
const STREAM_DONE = Symbol('cannbot.streamDone')


/** Concatenate the text blocks of one message. */
function textOf(content) {
  let text = ''
  for (const block of content) if (block.type === 'text') text += block.text
  return text
}

/** Translate harness messages into the OpenAI chat-completions array. */
function toMessages(options, images) {
  const out = []
  if (options.system !== undefined && options.system !== '') {
    out.push({ role: 'system', content: options.system })
  }
  for (const message of images?.messages ?? options.messages ?? []) {
    const content = message.content ?? []
    switch (message.role) {
      case 'system':
      case 'developer':
        assertNoFileBlocks(content)
        out.push({ role: 'system', content: textOf(content) })
        break
      case 'user':
        assertNoFileBlocks(content)
        out.push({ role: 'user', content: toContent(content, images) })
        break
      case 'assistant': {
        assertNoFileBlocks(content)
        const text = textOf(content)
        let reasoning = ''
        const toolCalls = []
        for (const block of content) {
          if (block.type === 'reasoning') reasoning += block.text
          else if (block.type === 'tool-call') {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: { name: block.name, arguments: block.arguments },
            })
          }
        }
        const entry = { role: 'assistant', content: text }
        // The gateway accepts `reasoning_content` back on an assistant turn, so
        // a replayed reasoning prefix survives instead of being silently dropped
        // from the request.
        if (reasoning !== '') entry.reasoning_content = reasoning
        if (toolCalls.length > 0) entry.tool_calls = toolCalls
        out.push(entry)
        break
      }
      case 'tool':
        assertNoFileBlocks(content)
        // Tool content stays a string unless it carries images; the gateway
        // reads the array form (verified), which keeps a screenshot result in
        // the turn that produced it instead of inventing a user message.
        out.push({
          role: 'tool',
          tool_call_id: message.toolCallId,
          content: toContent(content, images),
        })
        break
      default:
        break
    }
  }
  return out
}

/** Translate harness tool schemas into OpenAI function definitions. */
function toTools(tools) {
  if (tools === undefined || tools.length === 0) return undefined
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
}

/** Build the streaming request body for one call. */
function toRequestBody(options, images) {
  const body = {
    model: options.model,
    messages: toMessages(options, images),
    stream: true,
    stream_options: { include_usage: true },
  }
  const tools = toTools(options.tools)
  if (tools !== undefined) body.tools = tools
  if (options.temperature !== undefined) body.temperature = options.temperature
  if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens
  if (options.stop !== undefined) body.stop = options.stop
  if (options.reasoningEffort !== undefined) body.reasoning_effort = String(options.reasoningEffort)
  return body
}

// ── SSE framing ──────────────────────────────────────────────────────────────

/** Extract the `data:` payload of one SSE frame, or undefined for a comment. */
function frameData(frame) {
  const parts = []
  for (const line of frame.split('\n')) {
    if (!line.startsWith('data:')) continue
    parts.push(line.slice(5).replace(/^ /, '').replace(/\r$/, ''))
  }
  if (parts.length === 0) return undefined
  const data = parts.join('\n')
  return data === '[DONE]' ? STREAM_DONE : data
}

/**
 * Yield the payload of every SSE frame in one response body.
 *
 * Frames are separated by a blank line and both LF and CRLF are tolerated,
 * since the transport is whatever `fetch` handed back.
 */
async function* sseFrames(body, onRead) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      onRead?.()
      buffer += decoder.decode(value, { stream: true })
      for (;;) {
        const match = /\r?\n\r?\n/.exec(buffer)
        if (match === null) break
        const frame = buffer.slice(0, match.index)
        buffer = buffer.slice(match.index + match[0].length)
        const data = frameData(frame)
        if (data !== undefined) yield data
      }
    }
    buffer += decoder.decode()
    const data = frameData(buffer)
    if (data !== undefined) yield data
  } finally {
    reader.cancel().catch(() => {})
  }
}

export { frameData, sseFrames, STREAM_DONE, toMessages, toRequestBody, toTools }
