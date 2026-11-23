import {
  IMAGE_OFFLOAD_REQUIRED_CODE,
  LlmError,
  contentHasImage,
  offloadedImageText,
  projectOffloadedImages,
  requestImageHandleText,
  requiredImageOffload,
} from '@deepseek-ai/dsh-llm'

import { visionModelsOf } from './capabilities.js'
import { readConfig } from './config-runtime.js'
import {
  DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM,
  DEFAULT_MAX_REQUEST_IMAGE_BYTES,
  DEFAULT_MAX_REQUEST_IMAGES,
  DEFAULT_REQUEST_IMAGE_MAX_BYTES,
  DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
  PACKAGE,
} from './constants.js'

/**
 * Request projection for one image: aspect-preserving dimensions inside the
 * pixel budget, plus the encoded-byte target the attachment service must hit.
 *
 * Small images are never enlarged, matching the base adapter contract; the
 * harness uses this same projection for coordinate mapping, so it must describe
 * exactly the bytes the request carries.
 *
 * The target field names changed inside the supported engine range: the 0.2.2
 * attachment store reads `maxBytes`, while 0.2.3 reads `maxImageBytes` plus the
 * soft `imageTargetBytes`. Returning all three keeps one adapter compatible with
 * both lines; each host ignores the fields it does not read. `imageTargetBytes`
 * equals the hard cap so the encoder never enlarges or re-encodes merely to chase
 * a lower soft target, preserving the 0.2.2 behavior.
 *
 * @param image - durable normalized image reference.
 * @param config - resolved plugin configuration.
 * @returns dimensions and encoded-byte targets for one request image.
 */
function requestImageTarget(image, config) {
  const settings = readConfig(config)
  const maxPixels = settings.requestImagePixelBudget ?? DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET
  const maxBytes = settings.requestImageMaxBytes ?? DEFAULT_REQUEST_IMAGE_MAX_BYTES
  let { width, height } = image
  if (width * height > maxPixels) {
    const scale = Math.sqrt(maxPixels / (width * height))
    width = Math.max(1, Math.floor(width * scale))
    height = Math.max(1, Math.floor(height * scale))
  }
  return {
    width,
    height,
    maxBytes,
    maxImageBytes: maxBytes,
    imageTargetBytes: maxBytes,
  }
}

/** Refuse a payload this request path never carries (the harness projects files to text first). */
function assertNoFileBlocks(content) {
  for (const block of content) {
    if (block.type === 'file') {
      throw new LlmError(
        `${PACKAGE}: a file block reached the adapter; the harness projects file attachments to text handles before dispatch, so this means the request bypassed that projection`,
        'UNSUPPORTED_CONTENT',
      )
    }
  }
}

/** Every retained image reference this request sends bytes for, deduplicated by attachment. */
function imageRefsOf(messages) {
  const refs = new Map()
  for (const message of messages) {
    // Preparation refuses any retained image outside these input roles, so the
    // filter is what keeps the read set equal to the transmitted set.
    if (message.role !== 'user' && message.role !== 'tool') continue
    for (const block of message.content ?? []) {
      if (block.type !== 'image' || block.offloaded === true) continue
      if (!refs.has(block.attachment.attachmentId)) refs.set(block.attachment.attachmentId, block.attachment)
    }
  }
  return [...refs.values()]
}

/**
 * Resolve every retained image into its request version before the body is
 * built, and refuse a request the route cannot carry.
 *
 * The order matters and mirrors the reference adapters: the surface's durable
 * offload decisions are projected first, so a request whose images were all
 * offloaded needs neither the attachment service nor any image bytes. Only then
 * are the vision-model and attachment-service requirements checked, and a
 * retained image in a role the wire cannot carry (anything but user content or a
 * tool result) is refused instead of silently dropped.
 *
 * The gateway accepts OpenAI vision content parts but has a request-body ceiling
 * (measured between 12MB and 16MB), so accumulated image bytes are bounded here
 * instead of being discovered as a 413: a request over the budget fails with
 * `IMAGE_OFFLOAD_REQUIRED`, which `dsh-compaction-image-offload` turns into a
 * durable offload of the oldest occurrences and one retry. The budget counts
 * exactly the occurrences this route transmits, so the recovery step can always
 * satisfy it.
 *
 * @param options - the assembled request.
 * @param config - resolved plugin configuration.
 * @param dependencies - lazily resolved attachment-service access.
 * @param signal - request cancellation, also covering attachment reads.
 * @returns prepared versions and projected history.
 */
async function prepareImages(options, config, dependencies, signal) {
  const settings = readConfig(config)
  const services = dependencies ?? {}
  const attachments = services.resolveAttachments?.()
  // Access resolves to undefined without the service, which only shortens the
  // placeholder text; projection itself never needs image bytes.
  const accessOf = (ref) => (attachments === undefined ? undefined : services.resolveImageAccess?.(attachments, ref))
  const messages = projectOffloadedImages(options.messages ?? [], (ref) => offloadedImageText(ref, accessOf(ref)))
  if (!messages.some((message) => contentHasImage(message.content ?? []))) {
    return { versions: new Map(), accessOf, messages }
  }

  if (!visionModelsOf(settings).includes(options.model)) {
    throw new LlmError(
      `${PACKAGE}: model ${options.model} is not declared image-capable; add it to visionModels or select a model that accepts images`,
      'UNSUPPORTED_CONTENT',
    )
  }
  const unsupported = messages.find(
    (message) => message.role !== 'user' && message.role !== 'tool' && contentHasImage(message.content ?? []),
  )
  if (unsupported !== undefined) {
    throw new LlmError(
      `${PACKAGE}: this route carries images only in user content and tool results; refusing a ${unsupported.role} image`,
      'UNSUPPORTED_CONTENT',
    )
  }
  if (attachments === undefined) {
    throw new LlmError(
      `${PACKAGE}: image input requires the durable attachment service, which is not mounted`,
      'UNSUPPORTED_CONTENT',
    )
  }

  const versions = new Map()
  await Promise.all(
    imageRefsOf(messages).map(async (ref) => {
      const version = await attachments.readImageRequest(ref, requestImageTarget(ref, settings), signal)
      versions.set(ref.attachmentId, version)
    }),
  )

  const maxBytes = settings.maxRequestImageBytes ?? DEFAULT_MAX_REQUEST_IMAGE_BYTES
  // The count bound is a placeholder far above any real request until the
  // gateway publishes its own limit; the byte bound is the operative one. Both
  // are passed because the seam's budget type requires them and because a
  // future measured count limit should not need a second code path.
  const maxImages = Math.max(1, Math.floor(settings.maxRequestImages ?? DEFAULT_MAX_REQUEST_IMAGES))
  const countQuantum = Math.min(
    maxImages,
    Math.max(1, Math.floor(settings.imageOffloadCountQuantum ?? DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM)),
  )
  const offloadImages = requiredImageOffload(
    messages,
    { representation: 'base64', maxBytes, maxImages, byteQuantum: 1, countQuantum },
    (block) => versions.get(block.attachment.attachmentId).bytes,
  )
  if (offloadImages > 0) {
    throw new LlmError(
      `${PACKAGE}: the request carries more images than this route allows (count or byte budget); ${offloadImages} oldest image(s) must be offloaded`,
      IMAGE_OFFLOAD_REQUIRED_CODE,
      { offloadImages },
    )
  }

  return { versions, accessOf, messages }
}

/**
 * Build one message's OpenAI `content` value.
 *
 * A message without a retained image stays a plain string, so text-only wire
 * bodies are unchanged. A retained image becomes the two parts the gateway
 * reads: deterministic handle text (name, dimensions, read-only path) and the
 * bytes as a `data:` URL. Preparation refuses every occurrence it cannot
 * transmit, so a missing prepared version is an internal invariant violation,
 * not a case to paper over with placeholder text.
 *
 * @param content - typed content blocks of one message.
 * @param images - prepared image state.
 * @returns a string when no image part is present, otherwise the content parts.
 */
function toContent(content, images) {
  const parts = []
  let imagesSent = 0
  for (const block of content) {
    if (block.type === 'text') {
      if (block.text !== '') parts.push({ type: 'text', text: block.text })
      continue
    }
    if (block.type !== 'image') continue
    const ref = block.attachment
    const version = images?.versions.get(ref.attachmentId)
    if (version === undefined) {
      throw new LlmError(
        `${PACKAGE}: image ${ref.name ?? ref.attachmentId} reached serialization without a prepared request version`,
        'UNSUPPORTED_CONTENT',
      )
    }
    parts.push({ type: 'text', text: requestImageHandleText(ref, version, images.accessOf(ref)) })
    parts.push({
      type: 'image_url',
      image_url: { url: `data:${version.mediaType};base64,${Buffer.from(version.data).toString('base64')}` },
    })
    imagesSent += 1
  }
  return imagesSent === 0 ? parts.map((part) => part.text).join('') : parts
}

export { assertNoFileBlocks, imageRefsOf, prepareImages, requestImageTarget, toContent }
