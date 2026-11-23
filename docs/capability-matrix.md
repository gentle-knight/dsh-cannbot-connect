# CANNBOT capability matrix

Evidence date: **2026-11-17** (image / reasoning), maintained with
`scripts/probe-vision.mjs` and `scripts/probe-data-types.mjs`.

The roster endpoint (`/cannbot/api/models/personal`) discloses no modality
field. CANNWork declares `image/pdf/audio/video` for every model it registers,
but that is a blanket declaration, not a per-model measurement: the gateway
accepted an image on `glm-5.3`, billed image tokens, and still told the user the
base64 payload was truncated. This plugin therefore classifies by exact model id
and treats everything unmeasured as text-only.

## Input modalities

The harness vocabulary (`ModelModalityMap`) has exactly two values, `text` and
`image`. That decides what an adapter can advertise:

| DSH content | Representation | What the adapter sends | Evidence |
|---|---|---|---|
| user text | text blocks | `content` string | every e2e run |
| user image | image block + durable attachment | handle text + `image_url` data URL | `scripts/probe-vision.mjs`, `e2e.mjs` |
| tool-result image | image block inside a tool message | array content with text + `image_url` | `e2e.mjs` |
| file (PDF, code, …) | file block + durable bytes | **nothing** — the host projects it to a handle text | `projectFilesToText` in `dsh-llm`; `test/adapter-meta.mjs` |
| audio / video | no content block exists | not supported | harness vocabulary |

`audio`/`video` are not a gap in this plugin: DSH cannot express them in a
message at all, so an adapter must not claim them. Files are deliberately not a
wire modality either; the model receives a read-only path and uses its tools.
Sending raw PDF/audio bytes would bypass the harness contract and is not
implemented.

### Image-capable models (measured)

Each model was asked about two 64×64 solid-colour PNGs and had to name both
colours. A 200 with billed image tokens is not sufficient evidence.

| Model id | Result | Decision |
|---|---|---|
| `deepseek-v4.1-flash` | blue → Blue, red → Red | image-capable |
| `qwen3.8-max` | blue → Blue, red → Red | image-capable |
| `qwen3.8-flash` | blue → Blue, red → Red | image-capable |
| `glm-5.3-flash` | blue → Blue, red → Red | image-capable |
| `glm-5.3` | 200 + image tokens, but "base64 truncated / cannot read" | text-only |
| `deepseek-v4-pro` | 400 `Invalid content type. image_url is only supported by certain models`, sometimes hangs | text-only |
| `deepseek-v4-flash` | most image requests time out; one sporadic success | unclassified → text-only |

The default lives in `lib/constants.js` (`DEFAULT_VISION_MODELS`) and is
overridable per deployment with the `visionModels` config array. Unknown ids
stay text-only: under-claiming refuses an image before it is attached and names
the model, while over-claiming admits one the gateway may accept and then fail
to read.

### Reasoning levels (measured on `deepseek-v4.1-flash`)

`minimal`, `low`, `medium`, `high`, `max`, `xhigh` are accepted and change the
reasoning-token budget. `off` is refused with HTTP 400 `InvalidParameter`, so
the plugin does not offer it. The other models have not been measured per level;
the route advertises the same six levels until `probe-data-types.mjs --only
reasoning` records their own answers.

### PDF and the other declared modalities

`scripts/probe-data-types.mjs` sends a one-page PDF containing a known word both
as an `image_url` data URL and as an OpenAI `file` part, and records what the
gateway answers. Run it before changing anything here:

```bash
node scripts/probe-data-types.mjs --only pdf --models deepseek-v4.1-flash --json-out scratch/pdf.json
```

The plugin does not act on a positive result automatically: the harness projects
file blocks to text handles before dispatch, so there is no file content left to
serialize. A positive PDF result is documentation for a future contract change,
not a reason to bypass `projectFilesToText`.

## Request image budget

Measured against the gateway:

- A 12 MB request body parsed (then failed image validation); 16 MB returned
  413. The default aggregate image budget is 8 MiB, leaving room for text and
  tool schemas.
- png/jpeg/webp/gif are accepted; sides ≤10 px are refused with 400.
- The gateway does not publish a per-request image **count** limit, so the
  plugin's `maxRequestImages` default is a placeholder far above any real
  request (`1_000_000`) and the byte budget is the operative cap. When a count
  limit is measured, set `maxRequestImages` to it and
  `imageOffloadCountQuantum` to a step at most that value.

## Reproduction

```bash
node scripts/probe-vision.mjs              # per-model colour test, exit 0 = all classified
node scripts/probe-data-types.mjs --only pdf,reasoning --models <id>
node e2e.mjs                               # live text/reasoning/tool/image turns
```

Both scripts need CANNWork signed in and consume a little gateway quota. Update
`DEFAULT_VISION_MODELS` only with a fresh run and record the date here.
