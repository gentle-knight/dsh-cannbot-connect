# Changelog

## 0.5.0

- Add a **CANNBOT settings page** under DSH Settings, registered by a new
  `dsh.client` browser half. It shows CANNWork credential state, the live model
  catalog, per-model image switches, image budgets, refresh/capacity settings,
  and the effective endpoint, and writes changes through the platform's
  revisioned `configForms` API.
- Add the same panel as a folding **Models page footer** card, so the Models
  page is a working entry point without pretending to be a native provider row.
  The built-in Models editor only supports `llm-deepseek` and `llm-pi-ai`;
  third-party namespaces fall back to an `unknown` layout whose Apply action is
  disabled. This plugin therefore keeps its own settings surface, like
  `dsh-connect-workbuddy`.
- Make every Config field volatile and apply `loader/volatile-update` live:
  image capability changes refresh the model picker, catalog/interval changes
  re-arm the roster, and endpoint changes are validated before they replace the
  previous endpoints. A rejected live endpoint is reported without taking the
  provider down.
- Add `GET /cannbot-connect/status`, an authenticated read-only resource for the
  credential/catalog facts the settings document cannot carry. It strips JWTs,
  VKs, full credential paths, and raw upstream diagnostics.
- Add `config-runtime`, status, route, live-update, and client-manifest tests;
  raise the suite count to 23.

## 0.4.3

- Fix image input on DSH 0.2.3: the attachment service renamed the request-image
  target from `maxBytes` to `maxImageBytes` plus `imageTargetBytes`. The adapter
  now returns all three names, so the same code works on 0.2.2-rc.3 and
  0.2.3-alpha.2; on 0.2.3 the previous shape failed with
  `Image request maxImageBytes must be a positive integer`.
- Add regression assertions for both target shapes.

## 0.4.2

- Make GitHub the canonical marketplace/install URL: `package.json`
  `repository`/`homepage`/`bugs` and the README install command now point at
  `github.com/gentle-knight/dsh-cannbot-connect`; GitCode remains the development
  source and mirrors to GitHub.
- Document the GitCode-to-GitHub Push-mirror setup, token scope, verification,
  and overwrite behavior in `docs/REPOSITORY-SYNC.md`, and rewrite the README
  marketplace section for the already-listed entry.
- Add `.github/workflows/verify.yml` (syntax, 18 offline suites, coverage gate,
  secret scan) and the README badge. Host-matrix and live e2e remain local
  because they need a DSH host or CANNWork sign-in.
- Fix the stale duplicate Node prerequisite in the README (the 0.2.1 line is
  gone; the only floor is Node >=24.9.0).
- Rewrite the README for end users: functionality, install, usage, images/files,
  configuration, FAQ, security, and limitations; move architecture, detailed
  troubleshooting, security internals, manual install, and maintainer guidance
  to `docs/` and `CONTRIBUTING.md`.

## 0.4.1

- Resolve credentials from platform-specific candidates: the home layout stays
  first (that is what CANNWork writes today), with macOS `~/Library/...` and
  Windows `%LOCALAPPDATA%`/`%APPDATA%` `env-paths` locations appended as
  fallbacks, and a UTF-8 BOM stripped before parsing. `authStatus()` reports the
  label of the root it used.
- Fix 403 model-refusal classification for dotted model ids (`deepseek-v4.1-flash`);
  the old sentence-boundary regex treated the dot as the end of the sentence and
  reported `AUTH`.
- Add the test programme: `docs/TEST-PLAN.md`, `docs/PLATFORMS.md`, a shared
  suite list, a Node test runner, a Node secret scanner (the POSIX wrapper now
  delegates), a syntax checker, and a dependency-free V8 coverage gate
  (lines ≥98 %, functions ≥90 %). Current result: 100 % lines, 92.63 %
  functions across 18 offline suites.
- Make the host matrix platform-neutral (`DSH_INSTALL_DIR` or explicit
  `CANNBOT_HOST_*`), use Windows junctions for its temporary links, and read
  the suite list from one place. `npm run check` is now a Node orchestrator
  with no shell operators.
- Add regression suites for platform credential candidates, roster HTTP/store
  failures, adapter registration/forced stream branches, BOM/invalid JSON, and
  image-without-prepared-version; isolate every offline test from the real
  `HOME`/`USERPROFILE`/XDG state.

## 0.4.0

- Split the single adapter file into `lib/` modules (`config`, `credentials`,
  `catalog`, `capabilities`, `images`, `wire`, `errors`, `adapter`) and kept the
  public exports unchanged.
- Add offline suites for the configuration schema, bundle manifest, plugin
  contract, wire translation, failure taxonomy, credential ordering, roster
  lifecycle, model metadata, image budgets, and terminal stream outcomes.
- Add `scripts/host-matrix.mjs`: the same offline suite runs against DSH
  `0.2.2-rc.3` and `0.2.3-alpha.2`; `test/import-surface.mjs` turns a removed
  host export into a named offline failure.
- Refresh the model roster in the background (`catalogRefreshMs`, default 10
  minutes) and after a request-side `AUTH`/`MODEL_UNSUPPORTED`, emitting
  `llm/adapters-updated` and `llm/models-updated`. A failed refresh keeps the
  previous catalog.
- Read the VK from the config directory before the data directory, decode the
  JWT expiry for diagnostics, and report presence/root without ever logging a
  value.
- Surface `defaultMaxTokens` from the catalog (clamped to the model's context),
  floor non-integer context values, and use the requested provider in
  `listModels`.
- Pass the full request-image budget (`maxImages`, `byteQuantum`,
  `countQuantum`); the count bound is a documented placeholder because the
  gateway publishes no count limit.
- Classify missing vs malformed credentials (`MISSING_CREDENTIAL` /
  `INVALID_CREDENTIAL`), map invalid tool arguments to `MALFORMED_RESPONSE`,
  raise unknown/`content_filter` finish reasons as `INVALID_RESPONSE` instead of
  a clean stop, preserve in-band status, and parse HTTP-date `Retry-After`.
- Treat configuration-time endpoint errors as `INVALID_CONFIG`.
- Add `docs/capability-matrix.md` and `scripts/probe-data-types.mjs`; state the
  data-type contract (text/image on the wire, files as host-projected handles,
  no audio/video).
- Add plugin-market metadata: `locale/en.json`, `locale/zh.json`, `icon.svg`,
  `docs/DETAIL.md`, `docs/DETAIL.zh.md`, `docs/preview.svg`, and the matching
  `exports`/`files` entries.
- Raise the host floor to DSH `0.2.2-rc.3` / Node `>=24.9.0` (0.2.1 is no longer
  supported).

## 0.3.2

- Load on the `0.2.3-alpha` host line: `@deepseek-ai/dsh-llm@0.2.3-alpha.2`
  removed `assertUsableApiKey` (and `normalizeApiKey`), so the plugin now owns
  the printable-ASCII-without-spaces rule locally. The replacement in
  `@deepseek-ai/dsh-credentials` is not exported by the 0.2.2 line this release
  still supports.
- Distinguish a missing credential (`MISSING_CREDENTIAL`) from a malformed one
  (`INVALID_CREDENTIAL`).
- Add `test/import-surface.mjs` as the regression for host export removals.

## 0.3.1

- Keep the usage sample self-consistent so the harness does not drop it whole.
- Accept image input on the models the gateway can actually read.
- Honor per-model VK and separate model refusals from auth failures.
- Report cache hits as disjoint input tokens.
