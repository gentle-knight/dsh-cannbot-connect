# Test plan — dsh-cannbot-connect

Status: active · Last revised: 2026-11-23 · Owner: plugin maintainers
Implementation: `lib/` · Tooling: `scripts/` · Suites: `test/`, `e2e.mjs`

This document is the test strategy, not a test log. It defines what is tested,
at which layer, with which evidence, and what "done" means. The test inventory
itself lives in `scripts/test-suites.mjs`; that file is the single list every
runner consumes.

## 1. Objectives

The plugin is a thin but security-sensitive adapter: it reads another tool's
local credentials, forwards them to an HTTP gateway, and must keep the DSH
session coherent when the gateway, the roster, or the sign-in changes. The test
programme is therefore optimised for these properties, in order:

1. **No credential exposure** — no secret in logs, error text, source, or Git
   history; no credential sent to an unapproved origin.
2. **Contract fidelity** — the `LlmAdapter`/`StreamChunk`/`TokenUsage`/error
   vocabulary the host validates is produced correctly, including the failure
   paths.
3. **Data-plane correctness** — text, reasoning, tool calls, tool results,
   usage, images, and the image budget/offload contract.
4. **Operational resilience** — roster refresh, credential rotation, stale
   files, expired JWTs, missing sign-in, malformed provider answers.
5. **Reproducibility** — the same offline result on Linux, with the macOS and
   Windows path logic covered by simulation and a written risk analysis.
6. **Hermeticity** — offline suites never read the machine's real CANNWork
   state, never call the public gateway, and can run in any order.

## 2. Scope

In scope: `lib/` runtime modules; the bundle manifest and patch; the offline
test tooling; the live end-to-end script; credential path resolution on Linux,
macOS, and Windows; packaging metadata.

Out of scope for this plan: DSH itself, the CANNBOT gateway's model behaviour,
CANNWork's UI, plugin-market review, load/soak testing, and a browser UI
(the plugin ships no client-side surface).

## 3. Test levels

| Level | Purpose | Where |
|---|---|---|
| L0 static | Parse every module, validate the manifest/patch/exports, prove the host import surface | `scripts/check-syntax.mjs`, `test/manifest.mjs`, `test/import-surface.mjs` |
| L1 unit | Pure functions and schemas: config, wire translation, errors, credential resolution, platform candidates, model metadata | `test/config.mjs`, `test/errors.mjs`, `test/wire.mjs`, `test/credentials.mjs`, `test/credentials-platform.mjs`, `test/adapter-meta.mjs` |
| L2 contract/integration | Adapter streams against a local mock gateway; plugin mount/dispose; roster store; security properties | `test/adapter-*.mjs`, `test/plugin.mjs`, `test/catalog*.mjs`, `test/security.mjs` |
| L3 host compatibility | The same offline suites against the stable and alpha host lines | `scripts/host-matrix.mjs` |
| L4 live e2e | Real `LlmRuntime` + real gateway: text, reasoning, tools, replay, images | `e2e.mjs` |
| L5 manual | Rendered icon, locale strings, detail page in Plugin Manager | user, in a browser |

## 4. Inventory and traceability

| Requirement | Evidence |
|---|---|
| Bundle installs, patch inserts one row, exports/files stay honest | `test/manifest.mjs`; `npm pack --dry-run` |
| Plugin mounts without network, registers `cannbot`, returns a disposer | `test/plugin.mjs` |
| Host symbols imported by the plugin exist (alpha import break) | `test/import-surface.mjs`, L3 |
| Config defaults and obvious rejections | `test/config.mjs` |
| Text / system / developer / reasoning / tool-call / tool-result wire shapes | `test/wire.mjs`, `test/adapter-contract.mjs` |
| SSE framing: split reads, CRLF, comments, `[DONE]`, trailing frame | `test/wire.mjs` |
| Usage is DISJOINT and passes the host's own normalization gate | `test/adapter-usage.mjs` |
| Failure taxonomy: 401/403-model/403-other/429/5xx/413/image-400/context/quota/abort/timeout | `test/errors.mjs`, `test/adapter-finish.mjs`, `test/security.mjs` |
| Missing vs malformed credentials; per-model VK; redaction | `test/adapter-auth.mjs`, `test/credentials.mjs`, `test/security.mjs` |
| VK precedence (config dir before data dir); legacy fallback; JWT expiry | `test/credentials.mjs`, `test/credentials-platform.mjs` |
| Platform candidate paths for Linux/macOS/Windows; BOM tolerance | `test/credentials-platform.mjs` |
| Roster fetch shapes, dedupe, failure reasons, refresh timer, retry, dispose | `test/catalog.mjs`, `test/catalog-fetch.mjs` |
| Model metadata: context clamp, `defaultMaxTokens`, modalities, `listModels` provider | `test/adapter-meta.mjs` |
| Image budgets (count and bytes), offload count, file-block invariant | `test/adapter-image.mjs`, `test/adapter-meta.mjs` |
| Terminal stream outcomes: `content_filter`, unknown finish, empty response, bad tool JSON | `test/adapter-finish.mjs` |
| Live gateway: catalog, text+reasoning, tool call, replay, user image, tool image | `e2e.mjs` (L4) |
| Stable + alpha host compatibility | L3 |

## 5. Coverage

Measured by `npm run test:coverage` (`scripts/coverage.mjs`).

- **Method**: every suite runs in a child process with `NODE_V8_COVERAGE`. V8
  emits a top-level range covering the whole module plus nested function/block
  ranges; the script applies ranges widest-first so the innermost count wins,
  then marks a code line covered when at least one character was executed in at
  least one process. Functions are counted by the runtime's own function list.
- **Reported metrics**: line coverage and function coverage. **Branch coverage
  is not claimed** — V8 block ranges are not a branch model; the raw block
  counts are kept only in the JSON artifact as diagnostics.
- **Exclusions**: `scripts/`, `test/`, `e2e.mjs`, generated `coverage/`. The
  probes are operational tools, not runtime code.
- **Thresholds (gate)**: lines **≥ 98 %**, functions **≥ 90 %**.
- **Current result (2026-11-23, stable host)**: lines **100.00 % (1068/1068)**,
  functions **92.63 % (88/95)**, 17 offline suites.
- **Limits**: a line can be executed (covered) without its semantic branch
  being asserted; thresholds are a floor, not an adequacy proof. The risk-based
  matrix in §7 is the complementary evidence.
- Artifacts: `coverage/coverage-summary.json` and `coverage/coverage.md`, both
  generated and Git-ignored.

## 6. Environments

| Environment | Version | Status |
|---|---|---|
| Development / CI baseline | Linux, Node **v24.22.3** | executed |
| Stable DSH host | `@deepseek-ai/dsh@0.2.2-rc.3` (`dsh-llm` same) | executed (offline + live) |
| Alpha DSH host | `@deepseek-ai/dsh@0.2.3-alpha.2` | executed (offline + live) |
| CANNWork / opencode sign-in | CANNWork 2.0.0, opencode layout on this machine | executed for live tests |
| macOS | Node ≥ 24.9 | **not executed**; path logic simulated, risk analysis in `docs/PLATFORMS.md` |
| Windows | Node ≥ 24.9 | **not executed**; path logic simulated, risk analysis in `docs/PLATFORMS.md` |

Node floor comes from the host: DSH 0.2.2 requires Node ≥ 24.9; the 0.2.3-alpha
line requires ≥ 24.22.3. The plugin declares the same floor.

## 7. Risk-based test matrix

| Risk | Tests | Evidence level |
|---|---|---|
| Credential file lives in a new platform directory | `credentials-platform` candidate matrix + fallbacks | simulated; not executed on macOS/Windows |
| Stale data-dir VK shadows a rotated config-dir VK | `credentials` precedence cases | unit |
| Credential contains characters no header can carry | `credentials`, `adapter-auth` | unit + integration |
| Provider echoes a credential in an error body | `security`, `adapter-auth` | integration |
| Redirect would forward credentials | `security` (asserts target never contacted) | integration |
| Roster refresh races with disposal or fails | `catalog`, `catalog-fetch` | unit |
| Gateway refuses a model with a dotted id (403) | `errors`, `adapter-contract` | unit + integration |
| Image on a text-only model / over budget / no attachment service | `adapter-image`, `adapter-meta` | integration |
| File block bypasses the host projection | `adapter-meta` | unit |
| Usage double-counts cache hits | `adapter-usage` | unit + golden |
| Unknown finish reason hidden as a clean stop | `adapter-finish` | integration |
| Host removes an imported symbol (alpha) | `import-surface`, L3 | static + host matrix |
| Windows BOM / `USERPROFILE` / path separators | `credentials-platform` (BOM, candidates); `PLATFORMS.md` for the rest | simulated; separator/ACL not executed |
| Developer tooling fails on Windows (`./check-secrets.sh`, `&&` chains) | Node runners: `run-tests`, `check-secrets`, `check-syntax`; `npm run check` | static; shell wrapper is optional |

## 8. Test data and isolation

- Every offline suite that reads credentials points `HOME`, `USERPROFILE`,
  `XDG_DATA_HOME`, and `XDG_CONFIG_HOME` at a fresh temporary tree and restores
  them in `finally`. No suite reads the developer's real CANNWork files.
- Credentials in fixtures are obviously fake (`test-jwt-…`, `vk-test-…`); the
  secret scanner's patterns match real credential shapes, not fixture names.
- Gateway traffic is a loopback `node:http` server; the suites never call the
  public gateway. `card`/`e2e` (L4) is the only live path and consumes quota.
- Time-based tests use short timers with margin (refresh/dispose); they are
  bounded and `unref()`-ed in production code so a hung timer cannot keep the
  process alive.
- Git history is scanned for credential literals; the working tree is scanned
  including untracked files.

## 9. Entry and exit criteria

**Entry**: Node ≥ 24.9; dependencies linked (`node_modules/@deepseek-ai/*` or
`npm install`); for L3, at least one host root available (`DSH_INSTALL_DIR` or
an explicit `CANNBOT_HOST_*`); for L4, CANNWork signed in and quota approved.

**Exit for a change**:

1. `npm test` passes (17 offline suites).
2. `npm run test:compat` passes on every available host line.
3. `npm run test:coverage` meets lines ≥ 98 % and functions ≥ 90 %.
4. `npm run check:secrets` is clean (tree and history).
5. `npm run check-syntax` parses every module.
6. For a release: `node e2e.mjs` passes; the alpha profile boots without an
   activation warning; Plugin Manager metadata is verified by the user.
7. New behaviour has a test, and a fixed bug has a regression test (for
   example, the alpha `assertUsableApiKey` break produced
   `test/import-surface.mjs`).

## 10. Commands and CI

```bash
npm test                 # 17 offline suites, no network, no real credentials
npm run test:compat      # stable + alpha host matrix
npm run test:coverage    # V8 coverage + thresholds
npm run check:secrets    # tree + Git history scan
npm run check            # syntax + all of the above
node e2e.mjs             # live gateway (quota; CANNWork required)
node scripts/probe-vision.mjs        # capability evidence (quota)
node scripts/probe-data-types.mjs    # PDF/reasoning evidence (quota)
```

`npm run check` is the single CI entry point and uses only Node plus Git, so a
Linux, macOS, or Windows CI job can run it unchanged. The live suite is a
separate, secret-gated job because it needs CANNWork sign-in and spends gateway
quota. No provider-specific CI file is checked in; wire `npm run check` to the
repository host's CI.

On a macOS or Windows machine, run `npm run check` and, when a host is present,
`npm run test:compat`; set `CANNBOT_HOST_STABLE` and/or `CANNBOT_HOST_ALPHA` if
`DSH_INSTALL_DIR` is not already set. Then repeat the manual checks in
`docs/PLATFORMS.md` §5 and record the result.

## 11. Known gaps

- No execution on macOS or Windows; their path logic is simulated (candidate
  order, BOM, fake-home reads on Linux) and their remaining risks are listed in
  `docs/PLATFORMS.md`. Path separators and ACLs are Node's responsibility and
  are not exercised here.
- No branch coverage, mutation testing, fuzzing, or property-based testing.
- No load, soak, or concurrency stress beyond the catalog single-flight test.
- No live 429/5xx/rate-limit reproduction; those are classified offline.
- No real browser verification of the icon, locale strings, or detail page.
- No quota/billing or account-pool behaviour (out of scope for this plugin).
- The live image test depends on a measured subset of models; a gateway roster
  change can turn it into a skip or a failure, which is the intended signal to
  re-run `scripts/probe-vision.mjs` and update the evidence.
