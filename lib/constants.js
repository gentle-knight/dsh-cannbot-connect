import { createRequire } from 'node:module'

const { version: VERSION } = createRequire(import.meta.url)('../package.json')

/** The provider route this plugin owns. */
export const PROVIDER = 'cannbot'

/** Package name used in diagnostics. */
const PACKAGE = 'dsh-cannbot-connect'

/** Gateway base URL (OpenAI-compatible mode). */
const GATEWAY_BASE_URL = 'https://cannbot.hicann.cn/gateway/compatible-mode/v1'

/** Model-list endpoint; returns `builtinModels` + `personalModels`. */
const MODELS_URL = 'https://cannbot.hicann.cn/cannbot/api/models/personal'

/** Bounds one outstanding provider read, not consumer think time. */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

/** Sizing fallbacks for a model the catalog did not describe. */
const DEFAULT_CONTEXT_WINDOW = 1_048_576
const DEFAULT_MAX_TOKENS = 131_072

/**
 * Catalog models measured to accept image input through the gateway.
 *
 * The roster endpoint discloses no modality field, so capability has to be
 * established empirically (`scripts/probe-vision.mjs`, 2026-11-17): each id here
 * answered the same question about two solid-colour images with the right
 * colour. The failures are informative too, so they are recorded rather than
 * guessed at:
 *   - `glm-5.3` answers that the image data is truncated/incomplete (the gateway
 *     hands it a damaged payload), so its image path is not usable;
 *   - `deepseek-v4-pro` refuses with 400 `Invalid content type. image_url is only
 *     supported by certain models` or never answers;
 *   - `deepseek-v4-flash` answers correctly once and then stops answering image
 *     requests at all (its text requests stay fast), which would turn a pasted
 *     screenshot into a multi-minute hang.
 * Over-claiming would let the harness admit an image and then fail or hang the
 * turn, so unverified ids stay text-only; `visionModels` overrides this list
 * without a release.
 */
const DEFAULT_VISION_MODELS = Object.freeze([
  'deepseek-v4.1-flash',
  'qwen3.8-max',
  'qwen3.8-flash',
  'glm-5.3-flash',
])

/** Per-image request projection: pixels and encoded bytes handed to the gateway. */
const DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET = 4_194_304
const DEFAULT_REQUEST_IMAGE_MAX_BYTES = 1_048_576

/**
 * Accumulated base64 image bytes one request may carry.
 *
 * The gateway answered 12MB request bodies and returned 413 for 16MB, so the
 * default stays well below that while leaving room for text and tool schemas.
 */
const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 8_388_608

/**
 * Default request-image count bound.
 *
 * The gateway does not disclose a per-request image count limit, and until it
 * is measured this stays far above any real request: it is a type-level bound
 * that preserves the current behaviour (byte budget is the operative limit)
 * instead of silently narrowing a long session. The byte budget is the real
 * protection; see {@link DEFAULT_MAX_REQUEST_IMAGE_BYTES}.
 */
const DEFAULT_MAX_REQUEST_IMAGES = 1_000_000

/**
 * Default count-overflow offload step, kept equal to the count bound so a
 * count overflow (unreachable in practice) removes the whole prefix once
 * rather than one image at a time. It must not exceed the count bound.
 */
const DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM = 1_000_000

/** Default interval between roster refreshes; `0` disables the timer. */
const DEFAULT_CATALOG_REFRESH_MS = 600_000

/**
 * Thinking levels this gateway validates and honours.
 *
 * Measured against `deepseek-v4.1-flash`: `minimal`, `low`, `medium`, `high`,
 * `max` and `xhigh` are accepted and change the reasoning-token budget, while
 * `off` is refused with HTTP 400 `InvalidParameter`. `off` is therefore not
 * offered — a request naming no effort keeps the provider's own default, which
 * is what the seam would send for `off` anyway.
 */
const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'max', 'xhigh']

export {
  PACKAGE,
  VERSION,
  GATEWAY_BASE_URL,
  MODELS_URL,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_VISION_MODELS,
  DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
  DEFAULT_REQUEST_IMAGE_MAX_BYTES,
  DEFAULT_MAX_REQUEST_IMAGE_BYTES,
  DEFAULT_MAX_REQUEST_IMAGES,
  DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM,
  DEFAULT_CATALOG_REFRESH_MS,
  REASONING_EFFORTS,
}
