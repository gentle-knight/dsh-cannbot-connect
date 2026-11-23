#!/usr/bin/env node
/**
 * Probe how the CANNBOT gateway carries the data types this plugin can meet.
 *
 * The roster publishes no modality field, and a 200 alone does not prove the
 * model read the payload (`probe-vision.mjs` documents the `glm-5.3` case:
 * image tokens billed, image never read). This script therefore asks for a
 * specific fact and checks the answer:
 *
 *   images     — two solid-colour PNGs, both colours must be named (delegates
 *                to the same method as probe-vision; run that script directly
 *                for the full per-model table).
 *   pdf        — a one-page PDF saying the secret word; the answer must name
 *                it. Sent both as an `image_url` data URL and as a `file` part
 *                so the two wire shapes are distinguished.
 *   reasoning  — one tiny request per effort; a 400 means the level is not
 *                accepted by that model/route.
 *
 * It only documents what the gateway does; it does NOT make the plugin send
 * PDF/audio/video (the harness has no audio/video content block, and files are
 * projected to text handles by the host). Keep the plugin's claims aligned
 * with this output rather than with CANNWork's blanket modality declaration.
 *
 * Requires CANNWork to be signed in. Usage:
 *   node scripts/probe-data-types.mjs [--timeout-ms 30000] [--json-out path]
 *        [--models id1,id2] [--only images,pdf,reasoning]
 *
 * With 7 catalog models and every section enabled this makes ~77 short
 * requests; narrow it with `--models` / `--only` when checking one change.
 *
 * Exit codes: 0 every probe classified, 1 setup failure, 2 some probe could not
 * be classified (timeout / unreadable answer).
 */
import { writeFileSync } from 'node:fs'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'

import { fetchCatalog, readAccountVk, readJwt } from '../lib/index.js'

const GATEWAY_BASE_URL = 'https://cannbot.hicann.cn/gateway/compatible-mode/v1'
const DEFAULT_TIMEOUT_MS = 30_000
const REASONING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'max', 'xhigh']

/** 64×64 solid blue PNG, well above the gateway's 10px floor. */
const BLUE_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAn0lEQVRoge2SQQkAQRDDqqTCTnvErIh7hIFCBKSh6cdpoht0A9ArdhfiLtENugHoFbsLcZfoBt0A9IrdhbhLdINuAHrF7kLcJbpBNwC9Ynch7hLdoBuAXrG7EHeJbtANQK/YXYi7RDfoBqBX7C7EXaIbdAPQK3YX4i7RDboB6BW7C3GX6AbdAPSK3YW4S3SDbgB6xe5C3CW6QTcAveIfHlsmQTwiFSCUAAAAAElFTkSuQmCC'

const RED_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAnklEQVRoge2SUQkAQBSDlsT+oRbmQtyHPBgYwMlSOE10g24AesXuQtwlukE3AL1idyHuEt2gG4BesbsQd4lu0A1Ar9hdiLtEN+gGoFfsLsRdoht0A9ArdhfiLtENugHoFbsLcZfoBt0A9IrdhbhLdINuAHrF7kLcJbpBNwC9Ynch7hLdoBuAXrG7EHeJbtANQK/YXYi7RDfoBqBX/OEBzyyBALA4OlEAAAAASUVORK5CYII='

/** A minimal one-page PDF whose only sentence is the probe word. */
function buildProbePdf() {
  const objects = [
    '1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n',
    '2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n',
    '3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>endobj\n',
    '4 0 obj<< /Length 78 >>stream\nBT /F1 18 Tf 20 100 Td (The secret word is BANANA) Tj ET\nendstream\nendobj\n',
    '5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj\n',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'))
    pdf += object
  }
  const xref = Buffer.byteLength(pdf, 'latin1')
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (let index = 1; index <= objects.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

/** Parse `--flag value` pairs this script understands. */
function parseArgs(argv) {
  let timeoutMs = DEFAULT_TIMEOUT_MS
  let jsonOut
  let models
  let only
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--timeout-ms') {
      const value = Number(argv[index + 1])
      if (Number.isFinite(value) && value > 0) timeoutMs = value
      index += 1
    } else if (flag === '--json-out') {
      jsonOut = argv[index + 1]
      index += 1
    } else if (flag === '--models') {
      models = String(argv[index + 1] ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
      index += 1
    } else if (flag === '--only') {
      only = new Set(
        String(argv[index + 1] ?? '')
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean),
      )
      index += 1
    }
  }
  return { timeoutMs, jsonOut, models, only }
}

/** One non-streaming chat request; returns the HTTP status and the body text. */
async function chat({ model, vk, jwt, messages, extra = {}, timeoutMs }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${GATEWAY_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...attributionHeaders(),
        'x-api-vkey': vk,
        'api-key': vk,
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({ model, messages, stream: false, max_tokens: 32, ...extra }),
      signal: controller.signal,
      redirect: 'error',
    })
    const text = await response.text()
    return { status: response.status, text }
  } catch (error) {
    return { status: 0, text: String(error?.message ?? error) }
  } finally {
    clearTimeout(timer)
  }
}

/** The assistant text of a non-streaming answer, or undefined. */
function answerText(body) {
  try {
    const json = JSON.parse(body)
    const message = json?.choices?.[0]?.message
    return typeof message?.content === 'string' ? message.content : undefined
  } catch {
    return undefined
  }
}

/** Classify one probe result without over-claiming. */
function classify(result, matches) {
  if (result.status === 0) return 'timeout-or-transport'
  if (result.status >= 400) return `refused-${result.status}`
  const answer = answerText(result.text)
  if (answer === undefined) return 'unreadable-answer'
  return matches.test(answer) ? 'supported' : 'answered-without-reading'
}

async function main() {
  const { timeoutMs, jsonOut, models, only } = parseArgs(process.argv.slice(2))
  const jwt = readJwt()
  const accountVk = readAccountVk()
  if (jwt === undefined || accountVk === undefined) {
    console.error('CANNWork is not signed in (session.json accessToken / auth.json cannbot.key missing).')
    process.exit(1)
  }

  const catalog = await fetchCatalog()
  if (!catalog.ok) {
    console.error(`catalog unavailable: ${catalog.reason}`)
    process.exit(1)
  }

  const wanted = models === undefined ? catalog.catalog : catalog.catalog.filter((row) => models.includes(row.id))
  if (wanted.length === 0) {
    console.error(`none of the requested models are in the catalog: ${models?.join(', ')}`)
    process.exit(1)
  }
  const wants = (section) => only === undefined || only.has(section)
  const report = { date: new Date().toISOString(), timeoutMs, only: only === undefined ? 'all' : [...only], models: {} }
  let unclassified = 0

  for (const row of wanted) {
    const vk = row.vk ?? accountVk
    const entry = { id: row.id, title: row.name, image: {}, pdf: {}, reasoning: {} }

    // images: the same colour test as probe-vision, for completeness in one report
    if (wants('images')) {
    entry.image.blue = classify(
      await chat({
        model: row.id,
        vk,
        jwt,
        timeoutMs,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What colour is this solid image? One word.' },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${BLUE_PNG}` } },
            ],
          },
        ],
      }),
      /\bblue\b|蓝/i,
    )
    entry.image.red = classify(
      await chat({
        model: row.id,
        vk,
        jwt,
        timeoutMs,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What colour is this solid image? One word.' },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${RED_PNG}` } },
            ],
          },
        ],
      }),
      /\bred\b|红/i,
    )
    }

    // pdf: image_url data URL form
    if (wants('pdf')) {
    const pdfBase64 = buildProbePdf().toString('base64')
    entry.pdf.asImageUrl = classify(
      await chat({
        model: row.id,
        vk,
        jwt,
        timeoutMs,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is the secret word in this document? One word.' },
              { type: 'image_url', image_url: { url: `data:application/pdf;base64,${pdfBase64}` } },
            ],
          },
        ],
      }),
      /\bbanana\b/i,
    )
    entry.pdf.asFilePart = classify(
      await chat({
        model: row.id,
        vk,
        jwt,
        timeoutMs,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is the secret word in this document? One word.' },
              {
                type: 'file',
                file: { filename: 'probe.pdf', file_data: `data:application/pdf;base64,${pdfBase64}` },
              },
            ],
          },
        ],
      }),
      /\bbanana\b/i,
    )
    }

    // reasoning: one minimal request per level
    if (wants('reasoning')) for (const level of REASONING_LEVELS) {
      const result = await chat({
        model: row.id,
        vk,
        jwt,
        timeoutMs,
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        extra: { reasoning_effort: level, max_tokens: 4 },
      })
      entry.reasoning[level] = result.status === 0 ? 'timeout-or-transport' : result.status < 400 ? 'accepted' : `refused-${result.status}`
    }

    const checks = []
    if (wants('images')) checks.push(entry.image.blue, entry.image.red)
    if (wants('pdf')) checks.push(entry.pdf.asImageUrl, entry.pdf.asFilePart)
    for (const value of checks) {
      if (!['supported', 'answered-without-reading'].includes(value)) unclassified += 1
    }
    report.models[row.id] = entry
    console.log(
      `${row.id}: image=${entry.image.blue}/${entry.image.red} pdf=${entry.pdf.asImageUrl}/${entry.pdf.asFilePart} reasoning=${Object.entries(entry.reasoning)
        .map(([level, verdict]) => `${level}:${verdict === 'accepted' ? 'ok' : verdict.replace('refused-', '')}`)
        .join(',')}`,
    )
  }

  if (jsonOut !== undefined) {
    writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`)
    console.log(`\nreport: ${jsonOut}`)
  } else {
    console.log(`\n${JSON.stringify(report, null, 2)}`)
  }
  if (unclassified > 0) {
    console.error(`\n${unclassified} probe(s) could not be classified; treat them as unverified, not supported.`)
    process.exit(2)
  }
}

await main()
