/**
 * Read-only status projection for the CANNBOT Settings page.
 *
 * The Settings page is a browser surface, so it must never receive credential
 * material, full credential paths, or raw upstream errors. This module is the
 * one place that maps the Host's internal state onto that safe wire shape.
 *
 * @module dsh-cannbot-connect/status
 */

import { inputModalitiesOf } from './capabilities.js'

/** Stable catalog failure categories, in the order the UI explains them. */
const FAILURE_REASONS = new Set(['auth', 'network', 'server', 'unknown'])

/**
 * Project one credential into its public, non-secret view.
 * @param credential - one entry from `authStatus()`.
 * @returns presence, expiry, and a source label only.
 */
function credentialView(credential) {
  const expiresAtMs = credential?.expiresAtMs
  return {
    present: credential?.present === true,
    ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
    expired: expiresAtMs !== undefined && expiresAtMs <= Date.now(),
    sourceLabel: credential?.label ?? credential?.root ?? 'default',
  }
}

/**
 * Endpoint text without userinfo, query, or fragment. A configured URL may
 * carry a proxy credential in its userinfo or a one-off token in its query;
 * neither belongs in a browser-readable status document.
 * @param raw - configured endpoint.
 * @returns the safe endpoint, or undefined when it is not a URL.
 */
function publicEndpoint(raw) {
  if (typeof raw !== 'string' || raw === '') return undefined
  try {
    const url = new URL(raw)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return undefined
  }
}

/**
 * Public model row. `vk` and any other credential material stay on the Host.
 * @param model - one catalog row.
 * @param config - effective plain config.
 * @returns the safe model descriptor.
 */
function modelView(model, config) {
  return {
    id: model.id,
    name: model.name ?? model.id,
    ...(Number.isFinite(model.contextWindow) ? { contextWindow: model.contextWindow } : {}),
    ...(Number.isFinite(model.maxTokens) ? { maxTokens: model.maxTokens } : {}),
    inputModalities: inputModalitiesOf(model.id, config),
  }
}

/**
 * Build the JSON body returned by `GET /cannbot-connect/status`.
 * @param input - live Host state.
 * @returns a detached, secret-free status document.
 */
export function buildStatus(input) {
  const config = input.config ?? {}
  const catalog = input.catalog ?? {}
  const failure = typeof catalog.lastFailure === 'string' && FAILURE_REASONS.has(catalog.lastFailure)
    ? catalog.lastFailure
    : undefined
  return {
    version: input.version,
    provider: input.provider,
    settingsNs: input.settingsNs,
    active: input.active === true,
    generatedAt: Date.now(),
    modelCount: input.models?.length ?? 0,
    models: (input.models ?? []).map((model) => modelView(model, config)),
    credentials: {
      jwt: credentialView(input.auth?.jwt),
      vk: credentialView(input.auth?.vk),
    },
    catalog: {
      ...(catalog.lastRefreshAt === undefined ? {} : { lastRefreshAt: catalog.lastRefreshAt }),
      ...(failure === undefined ? {} : { lastFailure: failure }),
      ...(typeof catalog.lastReason === 'string' ? { lastReason: catalog.lastReason } : {}),
      isRefreshing: catalog.isRefreshing === true,
    },
    config: {
      baseURL: publicEndpoint(config.baseURL),
      modelsURL: publicEndpoint(config.modelsURL),
      catalogRefreshMs: config.catalogRefreshMs,
      streamIdleTimeoutMs: config.streamIdleTimeoutMs,
      defaultContextWindow: config.defaultContextWindow,
      defaultMaxTokens: config.defaultMaxTokens,
      visionModels: [...(config.visionModels ?? [])],
      requestImagePixelBudget: config.requestImagePixelBudget,
      requestImageMaxBytes: config.requestImageMaxBytes,
      maxRequestImageBytes: config.maxRequestImageBytes,
      maxRequestImages: config.maxRequestImages,
      imageOffloadCountQuantum: config.imageOffloadCountQuantum,
    },
    ...(typeof input.configError === 'string' && input.configError !== ''
      ? { configError: input.configError }
      : {}),
  }
}
