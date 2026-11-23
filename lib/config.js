import z from '@deepseek-ai/schemastery'

import {
  DEFAULT_CATALOG_REFRESH_MS,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM,
  DEFAULT_MAX_REQUEST_IMAGE_BYTES,
  DEFAULT_MAX_REQUEST_IMAGES,
  DEFAULT_MAX_TOKENS,
  DEFAULT_REQUEST_IMAGE_MAX_BYTES,
  DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_VISION_MODELS,
  GATEWAY_BASE_URL,
  MODELS_URL,
} from './constants.js'


// ── plugin configuration ─────────────────────────────────────────────────────

/**
 * Entry configuration. Every field has a working default, so the plugin mounts
 * with no `config` block at all.
 */
export const Config = z.object({
  /** Gateway endpoint serving the OpenAI-compatible surface. */
  baseURL: z.string().default(GATEWAY_BASE_URL),
  /** Endpoint listing the models this account may use. */
  modelsURL: z.string().default(MODELS_URL),
  /**
   * Interval between roster refreshes. `0` disables the timer; the mount-time
   * fetch and the failure-triggered refresh still run.
   */
  catalogRefreshMs: z.number().min(0).max(604_800_000).default(DEFAULT_CATALOG_REFRESH_MS),
  /** Idle ceiling for one outstanding provider read. */
  streamIdleTimeoutMs: z.number().min(1_000).max(86_400_000).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  /** Context window assumed for a model the catalog did not size. */
  defaultContextWindow: z.number().min(1).default(DEFAULT_CONTEXT_WINDOW),
  /** Output cap assumed for a model the catalog did not size. */
  defaultMaxTokens: z.number().min(1).default(DEFAULT_MAX_TOKENS),
  /**
   * Catalog models that accept image input; every other id is advertised as
   * text only. The roster discloses no modality, so this list is measured (see
   * {@link DEFAULT_VISION_MODELS}) and stays overridable per deployment.
   */
  visionModels: z.array(z.string()).default([...DEFAULT_VISION_MODELS]),
  /** Pixel budget one request image is scaled into, preserving its aspect ratio. */
  requestImagePixelBudget: z.number().min(1).default(DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET),
  /** Encoded-byte target for one request image; the attachment service re-encodes to fit. */
  requestImageMaxBytes: z.number().min(1).default(DEFAULT_REQUEST_IMAGE_MAX_BYTES),
  /** Accumulated base64 image bytes one request may carry before old images are offloaded. */
  maxRequestImageBytes: z.number().min(1).default(DEFAULT_MAX_REQUEST_IMAGE_BYTES),
  /**
   * Retained image occurrences one request may carry. The default is a
   * placeholder far above any real request because the gateway does not
   * disclose its count limit; the byte budget remains the operative cap.
   */
  maxRequestImages: z.number().min(1).default(DEFAULT_MAX_REQUEST_IMAGES),
  /**
   * Oldest occurrences removed per count overflow. It must not exceed
   * `maxRequestImages`; a larger value is clamped when the request is built.
   */
  imageOffloadCountQuantum: z.number().min(1).default(DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM),
})
