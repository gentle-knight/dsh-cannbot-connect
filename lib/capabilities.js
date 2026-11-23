import { DEFAULT_VISION_MODELS } from './constants.js'

/**
 * The models this configuration lets the route advertise as image-capable.
 *
 * The roster discloses no modality field, so capability is measured per exact
 * model id (`scripts/probe-vision.mjs`) and kept as an explicit list. Unknown
 * ids are text-only: under-claiming refuses an image before it is attached and
 * names the model, while over-claiming admits one the gateway then rejects —
 * or, worse, accepts while silently failing to read the image.
 *
 * @param config - resolved plugin configuration.
 * @returns the configured (or built-in) vision model ids.
 */
function visionModelsOf(config) {
  const value = config?.visionModels
  return (value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value)
    ?? DEFAULT_VISION_MODELS
}

/**
 * Input modalities to advertise for one exact model.
 *
 * `ModelModalityMap` in the harness has exactly two values, `text` and
 * `image`; files are not a modality (the host projects them to handles), and
 * audio/video have no content block at all.
 *
 * @param model - exact model id.
 * @param config - resolved plugin configuration.
 * @returns `['text', 'image']` when measured image-capable, otherwise `['text']`.
 */
function inputModalitiesOf(model, config) {
  return visionModelsOf(config).includes(model) ? ['text', 'image'] : ['text']
}

export { inputModalitiesOf, visionModelsOf }
