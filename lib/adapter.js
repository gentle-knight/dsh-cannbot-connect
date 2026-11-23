import {
  EMPTY_RESPONSE_CODE,
  LlmAdapter,
  LlmError,
  attributionHeaders,
  resolveRetryPolicy,
} from '@deepseek-ai/dsh-llm'

import { visionModelsOf } from './capabilities.js'
import { FALLBACK_CATALOG } from './catalog.js'
import { PACKAGE, PROVIDER, REASONING_EFFORTS } from './constants.js'
import { normalizeCredential, readAccountVk, readJwt } from './credentials.js'
import { errorTextOf, providerFailure, safeCount } from './errors.js'
import { prepareImages, requestImageTarget } from './images.js'
import { STREAM_DONE, sseFrames, toRequestBody } from './wire.js'

// ── adapter ──────────────────────────────────────────────────────────────────

/**
 * The CANNBOT route's adapter: one OpenAI-compatible SSE request per call.
 *
 * The catalog is a mutable binding rather than constructor state, because
 * registration must not block on the network — the route mounts immediately
 * with a fallback and swaps to the live roster once a fetch lands.
 */
export class CannbotAdapter extends LlmAdapter {
  #config
  #dependencies
  #catalog = FALLBACK_CATALOG
  #retryPolicy

  /**
   * @param config - resolved plugin configuration.
   * @param dependencies - lazily resolved services used only by image requests.
   *   Both are read on the request path, so mounting never depends on the
   *   attachment service being present, and a text-only deployment keeps working
   *   without it.
   */
  constructor(config, dependencies = {}) {
    super()
    this.#config = config
    this.#dependencies = dependencies
    this.#retryPolicy = resolveRetryPolicy(undefined, `${PACKAGE} retryPolicy`)
  }

  /** Adopt a freshly fetched roster; the next catalog read serves it. */
  adoptCatalog(catalog) {
    this.#catalog = catalog
  }

  /** The roster currently being served. */
  get catalog() {
    return this.#catalog
  }

  /** Modalities this route advertises for one exact model. */
  #inputModalities(model) {
    return visionModelsOf(this.#config).includes(model) ? ['text', 'image'] : ['text']
  }

  providerInfo(provider) {
    return { id: provider, name: 'CANNBOT' }
  }

  providerRetryPolicy() {
    return this.#retryPolicy
  }

  listModels() {
    return Promise.resolve(
      this.#catalog.map((model) => ({
        provider: PROVIDER,
        id: model.id,
        name: model.name,
        inputModalities: this.#inputModalities(model.id),
      })),
    )
  }

  resolveModel(provider, model) {
    const row = this.#catalog.find((entry) => entry.id === model)
    return Promise.resolve({
      provider,
      id: model,
      name: row?.name ?? model,
      inputModalities: this.#inputModalities(model),
      context: { contextWindow: row?.contextWindow ?? this.#config.defaultContextWindow },
      reasoning: {
        efforts: REASONING_EFFORTS.map((id) => ({
          id,
          name: id.charAt(0).toUpperCase() + id.slice(1),
        })),
      },
    })
  }

  /**
   * The dimensions and byte target this route sends for one image.
   *
   * The harness applies the base projection unless overridden, and the same
   * target is what serialization reads, so an oversized screenshot is scaled
   * once instead of being sent at full resolution (which the gateway counts as
   * visual tokens and the body limit counts as payload).
   */
  imageRequestTarget(_provider, _model, image) {
    return requestImageTarget(image, this.#config)
  }

  stream(options) {
    return this.#generate(options)
  }

  /** One cancellable request lifecycle. */
  async *#generate(options) {
    const config = this.#config

    const jwt = readJwt()
    // Prefer the VK the catalog advertises for this exact model: the gateway
    // issues a distinct key per roster row (a builtin row's key differs from
    // the account-level one), so the row is the more specific credential.
    // Models with no row key — and the fallback catalog before the roster
    // lands — keep using CANNWork's account VK from auth.json.
    const row = this.#catalog.find((entry) => entry.id === options.model)
    const vk = row?.vk ?? readAccountVk()
    if (jwt === undefined) {
      throw new LlmError(
        `${PACKAGE}: no CANNBOT access token — open CANNWork and sign in so it writes session.json`,
        'MISSING_CREDENTIAL',
      )
    }
    if (vk === undefined) {
      throw new LlmError(
        `${PACKAGE}: no CANNBOT virtual key for ${options.model} — open CANNWork and sign in so it writes auth.json`,
        'MISSING_CREDENTIAL',
      )
    }
    // A value no HTTP header can carry is a malformed credential rather than a
    // missing one, and an empty/whitespace-only value is the missing case.
    const bearer = normalizeCredential(jwt, 'the CANNBOT access token (session.json accessToken)')
    const virtualKey = normalizeCredential(vk, 'the CANNBOT virtual key')

    const consumer = new AbortController()
    const signal =
      options.signal === undefined ? consumer.signal : AbortSignal.any([options.signal, consumer.signal])

    let idleTimer
    let idleExpired = false
    const armIdle = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        idleExpired = true
        consumer.abort()
      }, config.streamIdleTimeoutMs)
      idleTimer.unref?.()
    }

    let sawDone = false
    let usage
    let providerFinish
    const blocks = new Map()
    let nextIndex = 0
    let textIndex
    let reasoningIndex
    const toolIndexes = new Map()

    try {
      // Attachment reads run under the same idle ceiling and abort signal as the
      // provider read: a wedged attachment backend must not outlive the watchdog.
      armIdle()
      const images = await prepareImages(options, config, this.#dependencies, signal)
      // The body is built outside the transport try, so a serialization failure
      // (for example an attachment-resolver error) keeps its own code instead of
      // being reported as a transport failure.
      const body = JSON.stringify(toRequestBody(options, images))
      let response
      try {
        response = await fetch(`${config.baseURL.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            ...attributionHeaders(),
            'x-api-vkey': virtualKey,
            'api-key': virtualKey,
            Authorization: `Bearer ${bearer}`,
          },
          body,
          signal,
          // This request carries both credentials: never let a redirect hand
          // them to another origin.
          redirect: 'error',
        })
      } catch (error) {
        if (idleExpired) throw new LlmError(`${PACKAGE}: provider read timed out`, 'TIMEOUT', { cause: error })
        if (options.signal?.aborted) throw new LlmError(`${PACKAGE}: request aborted`, 'ABORTED', { cause: error })
        throw new LlmError(`${PACKAGE}: transport failed`, 'TRANSPORT', { cause: error })
      }

      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw providerFailure(response.status, errorTextOf(text), response.headers.get('retry-after'), [
          bearer,
          virtualKey,
        ])
      }
      if (response.body === null) {
        throw new LlmError(`${PACKAGE}: the gateway returned no response body`, 'TRANSPORT')
      }

      for await (const frame of sseFrames(response.body, armIdle)) {
        if (frame === STREAM_DONE) {
          sawDone = true
          break
        }
        let event
        try {
          event = JSON.parse(frame)
        } catch {
          continue // a keep-alive or comment the gateway chose to frame as data
        }
        if (event.error !== undefined) {
          throw providerFailure(400, errorTextOf(JSON.stringify(event)), undefined, [bearer, virtualKey])
        }
        if (event.usage !== undefined && event.usage !== null) usage = event.usage

        const choice = event.choices?.[0]
        if (choice === undefined) continue
        if (typeof choice.finish_reason === 'string') providerFinish = choice.finish_reason

        const delta = choice.delta
        if (delta === undefined) continue

        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
          if (reasoningIndex === undefined) {
            reasoningIndex = nextIndex++
            blocks.set(reasoningIndex, { type: 'reasoning', text: '' })
            yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' }
          }
          blocks.get(reasoningIndex).text += delta.reasoning_content
          yield { type: 'reasoning-delta', index: reasoningIndex, text: delta.reasoning_content }
        }

        if (typeof delta.content === 'string' && delta.content !== '') {
          if (textIndex === undefined) {
            textIndex = nextIndex++
            blocks.set(textIndex, { type: 'text', text: '' })
            yield { type: 'block-start', index: textIndex, blockType: 'text' }
          }
          blocks.get(textIndex).text += delta.content
          yield { type: 'text-delta', index: textIndex, text: delta.content }
        }

        for (const call of delta.tool_calls ?? []) {
          const providerIndex = Number.isInteger(call.index) ? call.index : 0
          let index = toolIndexes.get(providerIndex)
          if (index === undefined) {
            index = nextIndex++
            toolIndexes.set(providerIndex, index)
            blocks.set(index, {
              type: 'tool-call',
              id: call.id ?? `call_${providerIndex}`,
              name: '',
              arguments: '',
            })
            yield { type: 'block-start', index, blockType: 'tool-call' }
          }
          const block = blocks.get(index)
          if (typeof call.id === 'string' && call.id !== '') block.id = call.id
          if (typeof call.function?.name === 'string' && call.function.name !== '') {
            block.name = call.function.name
          }
          const argumentsDelta = typeof call.function?.arguments === 'string' ? call.function.arguments : ''
          block.arguments += argumentsDelta
          yield {
            type: 'tool-call-delta',
            index,
            id: block.id,
            ...(call.function?.name === undefined ? {} : { name: call.function.name }),
            argumentsDelta,
          }
        }
      }
    } catch (error) {
      if (idleExpired) throw new LlmError(`${PACKAGE}: provider read timed out`, 'TIMEOUT', { cause: error })
      if (options.signal?.aborted) throw new LlmError(`${PACKAGE}: request aborted`, 'ABORTED', { cause: error })
      throw error
    } finally {
      clearTimeout(idleTimer)
      consumer.abort()
    }

    if (!sawDone && providerFinish === undefined) {
      throw new LlmError(`${PACKAGE}: the stream ended before the gateway finished the message`, 'STREAM_CLOSED')
    }

    const hasToolCall = [...blocks.values()].some((block) => block.type === 'tool-call')
    const reason =
      providerFinish === 'length'
        ? { kind: 'max-tokens' }
        : providerFinish === 'tool_calls' || providerFinish === 'function_call'
          ? { kind: 'tool-calls' }
          : providerFinish === undefined && hasToolCall
            ? { kind: 'tool-calls' }
            : { kind: 'stop' }

    if (blocks.size === 0 && reason.kind === 'stop') {
      throw new LlmError(`${PACKAGE}: the gateway returned no content`, EMPTY_RESPONSE_CODE)
    }

    for (const [index, block] of [...blocks.entries()].sort((a, b) => a[0] - b[0])) {
      if (block.type === 'tool-call') {
        // A truncated (max-tokens) tool call is expected to be invalid JSON, so
        // only a completion that claimed to finish is held to the contract.
        if (reason.kind !== 'max-tokens') {
          try {
            JSON.parse(block.arguments === '' ? '{}' : block.arguments)
          } catch (error) {
            throw new LlmError(
              `${PACKAGE}: the gateway returned tool arguments that are not valid JSON`,
              'INVALID_TOOL_ARGUMENTS',
              { cause: error },
            )
          }
        }
        yield {
          type: 'block-end',
          index,
          block: { type: 'tool-call', id: block.id, name: block.name, arguments: block.arguments },
        }
      } else {
        yield { type: 'block-end', index, block: { type: block.type, text: block.text } }
      }
    }

    if (usage !== undefined) {
      const promptDetails = usage.prompt_tokens_details ?? {}
      const completionDetails = usage.completion_tokens_details ?? {}
      const promptTokens = safeCount(usage.prompt_tokens) ?? 0
      const outputTokens = safeCount(usage.completion_tokens) ?? 0
      // The gateway follows OpenAI semantics: `prompt_tokens` INCLUDES the
      // cached prefix, while the harness reports prompt-side counts as
      // DISJOINT buckets (`inputTokens` is uncached input only). Subtracting
      // the hit is required here: the session's displayed cache-hit share is
      // `cacheReadTokens / (input + cacheRead + cacheWrite)`, so leaving the
      // hit inside `inputTokens` counts it twice and caps the display at 50%.
      // `prompt_cache_hit_tokens` is DeepSeek's other spelling, seen on
      // gateways that omit `prompt_tokens_details`; `??` alone would forward a
      // null/string/negative value from that spelling, which the harness treats
      // as a contradiction and drops the entire sample over.
      const reportedHit = safeCount(promptDetails.cached_tokens) ?? safeCount(usage.prompt_cache_hit_tokens)
      // Clamp the hit itself, not just the subtraction: the harness reconciles
      // `inputTokens + cacheReadTokens + outputTokens` against `totalTokens`, so
      // a hit larger than the prompt would leave the buckets unreconcilable and
      // void the whole disclosure.
      const cacheRead = reportedHit === undefined ? undefined : Math.min(reportedHit, promptTokens)
      const reasoning = safeCount(completionDetails.reasoning_tokens)
      // The harness rejects a total that is smaller than the known buckets, so
      // the gateway's own total is kept only when it agrees with the derived
      // one; the contract explicitly allows deriving it from the authoritative
      // prompt/output counters instead.
      const providerTotal = safeCount(usage.total_tokens)
      const totalTokens = providerTotal === promptTokens + outputTokens ? providerTotal : promptTokens + outputTokens
      yield {
        type: 'usage',
        usage: {
          inputTokens: promptTokens - (cacheRead ?? 0),
          outputTokens,
          totalTokens,
          ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
          // Committed reasoning tokens are a subset of output tokens; a gateway
          // that reports more would otherwise void the sample, so clamp the
          // count rather than overstating the reasoning share.
          ...(reasoning === undefined ? {} : { reasoningTokens: Math.min(reasoning, outputTokens) }),
        },
      }
    }

    yield { type: 'finish', reason }
  }
}
