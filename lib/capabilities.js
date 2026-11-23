import { DEFAULT_VISION_MODELS } from './constants.js'

// ── request translation ──────────────────────────────────────────────────────

/** The models this configuration lets the route advertise as image-capable. */
function visionModelsOf(config) {
  return config.visionModels ?? DEFAULT_VISION_MODELS
}

export { visionModelsOf }
