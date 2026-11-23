/**
 * Live configuration helpers.
 *
 * Every field in {@link Config} is volatile, so the Host hands `apply` a
 * record of `{ get(): T }` references instead of plain values. Settings writes
 * update those references in place and publish `loader/volatile-update`; this
 * module is the one place that turns a config record into the plain snapshot
 * the adapter and catalog store consume.
 *
 * @module dsh-cannbot-connect/config-runtime
 */

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

/** Every plain field a live config record resolves to. */
const DEFAULTS = Object.freeze({
  baseURL: GATEWAY_BASE_URL,
  modelsURL: MODELS_URL,
  catalogRefreshMs: DEFAULT_CATALOG_REFRESH_MS,
  streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  defaultContextWindow: DEFAULT_CONTEXT_WINDOW,
  defaultMaxTokens: DEFAULT_MAX_TOKENS,
  visionModels: Object.freeze([...DEFAULT_VISION_MODELS]),
  requestImagePixelBudget: DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
  requestImageMaxBytes: DEFAULT_REQUEST_IMAGE_MAX_BYTES,
  maxRequestImageBytes: DEFAULT_MAX_REQUEST_IMAGE_BYTES,
  maxRequestImages: DEFAULT_MAX_REQUEST_IMAGES,
  imageOffloadCountQuantum: DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM,
  refreshNonce: '',
})

/**
 * Read one config field, accepting both the volatile `{ get() }` shape the
 * Loader supplies and a plain value (tests, direct adapter construction).
 * @param record - config record.
 * @param key - field name.
 * @returns the current value, or its built-in default.
 */
function readField(record, key) {
  const field = record?.[key]
  const value = field !== null && typeof field === 'object' && typeof field.get === 'function'
    ? field.get()
    : field
  return value === undefined ? DEFAULTS[key] : value
}

/**
 * Resolve the whole live config into a detached plain snapshot.
 * @param record - config record from `apply`.
 * @returns plain configuration with every field filled.
 */
export function readConfig(record = {}) {
  return {
    baseURL: readField(record, 'baseURL'),
    modelsURL: readField(record, 'modelsURL'),
    catalogRefreshMs: readField(record, 'catalogRefreshMs'),
    streamIdleTimeoutMs: readField(record, 'streamIdleTimeoutMs'),
    defaultContextWindow: readField(record, 'defaultContextWindow'),
    defaultMaxTokens: readField(record, 'defaultMaxTokens'),
    visionModels: [...readField(record, 'visionModels')],
    requestImagePixelBudget: readField(record, 'requestImagePixelBudget'),
    requestImageMaxBytes: readField(record, 'requestImageMaxBytes'),
    maxRequestImageBytes: readField(record, 'maxRequestImageBytes'),
    maxRequestImages: readField(record, 'maxRequestImages'),
    imageOffloadCountQuantum: readField(record, 'imageOffloadCountQuantum'),
    refreshNonce: readField(record, 'refreshNonce'),
  }
}

/** JSON equality for the plain snapshot (only arrays, strings, numbers, booleans). */
function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Fields whose change alters advertised model metadata, so the picker must
 * reload. Request-only knobs are deliberately absent.
 * @param previous - old plain config.
 * @param next - new plain config.
 * @returns whether `llm/models-updated` should be emitted.
 */
export function modelFacingChanged(previous, next) {
  return !sameJson(previous.visionModels, next.visionModels)
    || previous.defaultContextWindow !== next.defaultContextWindow
    || previous.defaultMaxTokens !== next.defaultMaxTokens
}

/**
 * Whether a live refresh nonce asks for a catalog refresh. The nonce is a
 * random string, so an unchanged value never re-triggers.
 * @param previous - old plain config.
 * @param next - new plain config.
 * @returns whether the store should refresh.
 */
export function refreshRequested(previous, next) {
  return typeof next.refreshNonce === 'string'
    && next.refreshNonce !== ''
    && next.refreshNonce !== previous.refreshNonce
}

export { DEFAULTS }
