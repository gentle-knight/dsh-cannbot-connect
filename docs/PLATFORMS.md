# Platform dependencies and compatibility

Status: analysis · Last revised: 2026-11-23 · Development platform: Linux only
Companion: `docs/TEST-PLAN.md`

This document states what the plugin depends on, how those dependencies differ
between Linux, macOS, and Windows, and which compatibility risks remain because
only Linux was executed. It is deliberately explicit about what is verified,
what is simulated, and what is only analysed.

## 1. Runtime dependency inventory

The plugin is plain ESM JavaScript. It bundles no runtime dependency and starts
no subprocess, server, or native addon.

| Dependency | Kind | Platform-specific? | Used for |
|---|---|---|---|
| `@deepseek-ai/dsh-llm` | host-provided peer | No (pure JS) | `LlmAdapter`, `LlmError`, stream/usage helpers, `attributionHeaders`, `resolveRetryPolicy` |
| `@deepseek-ai/schemastery` | host-provided peer | No (pure JS) | `Config` schema |
| `@deepseek-ai/cordis` | host-provided peer | No (pure JS) | plugin contract (`apply`/`ctx.effect`/`ctx.logger`) |
| `node:fs` | Node builtin | API is platform-neutral; behaviour follows the OS filesystem | reading `session.json` / `auth.json` with `existsSync`, `readFileSync`, `statSync` |
| `node:os` | Node builtin | `homedir()` resolves `%USERPROFILE%` on Windows and `$HOME`/passwd on POSIX | finding the credential roots |
| `node:path` | Node builtin | `join()` uses the host separator (`/` or `\`) | composing paths |
| `fetch` (global) | Node builtin (undici) | Transport is cross-platform; proxy/CA configuration is environment-specific | catalog and chat requests |
| `AbortSignal.timeout` / `AbortSignal.any` | Node builtin | Cross-platform | idle/abort handling |
| `Buffer`, `TextDecoder`, `ReadableStream` | Node builtin | Cross-platform | base64 images, SSE decoding |
| `Response` (tests only) | Node builtin | Cross-platform | simulating a body-less 200 |

Not used: native modules (`node-pty`, addons), `child_process` in runtime code,
filesystem writes, OS-specific APIs, shell commands, environment-variable
secrets, and install scripts. The bundle declares `engines.node >=24.9.0`;
DSH 0.2.2 itself requires that floor, and the alpha line requires ≥24.22.3.

Development dependencies are only the host packages used for offline runs; the
test tooling itself uses Node builtins (`node:test` is not used; the suites are
standalone scripts). No test framework, coverage package, or shell dependency is
required.

## 2. Credential path differences

CANNWork's opencode plugin hardcodes `join(homedir(), '.local', 'share',
'opencode', 'session.json')` and `join(homedir(), '.config', 'opencode',
'auth.json')` (local evidence: `cannwork-auth.js` lines 23–26). Current opencode
documentation also states the home-relative layout for macOS/Linux and
`%USERPROFILE%\.local\share\opencode` / `%USERPROFILE%\.config\opencode` for
Windows ([opencode troubleshooting](https://opencode.ai/docs/troubleshooting/)).
Those two home-relative roots are therefore the **primary** candidates on every
platform.

Newer opencode builds are moving to platform directories (an `env-paths`
migration: macOS `~/Library/Application Support`, Windows `%LOCALAPPDATA%`) —
see [opencode PR #8236](https://github.com/anomalyco/opencode/pull/8236). The
plugin appends those as **fallbacks** after the home layout, so a future install
that moves its files is still found, while today's install keeps its current
first choice.

| Platform | Data candidates (JWT) in order | Config candidates (VK) in order |
|---|---|---|
| Linux | `$XDG_DATA_HOME/opencode` → `~/.local/share/opencode` | `$XDG_CONFIG_HOME/opencode` → `~/.config/opencode` |
| macOS | `$XDG_DATA_HOME/opencode` → `~/.local/share/opencode` → `~/Library/Application Support/opencode` | `$XDG_CONFIG_HOME/opencode` → `~/.config/opencode` → `~/Library/Preferences/opencode` |
| Windows | `$XDG_DATA_HOME/opencode` → `%USERPROFILE%\.local\share\opencode` → `%LOCALAPPDATA%\opencode\Data` → `%LOCALAPPDATA%\opencode` | `$XDG_CONFIG_HOME/opencode` → `%USERPROFILE%\.config\opencode` → `%APPDATA%\opencode\Config` → `%APPDATA%\opencode` |

Ordering rules:

- The JWT is searched in data candidates first, then config candidates.
- The VK is searched in config candidates first (current CANNWork writes it
  there), then data candidates; the legacy `cannbot-cli.refresh` shape is the
  last resort and only when it starts with `vk-`.
- The first readable non-empty value wins. Within a kind, the order above is
  the precedence; a stale earlier file can shadow a newer later one, which is
  why `authStatus()` records the `label` and path it used.
- `XDG_*` is honoured if set, but the home layout remains a fallback rather than
  being replaced: CANNWork itself does not read `XDG_*`, so a user with a custom
  XDG root can still have the files in `~/.local/share`.
- A UTF-8 BOM is stripped before JSON parsing; a Windows editor or copy step can
  add one and `JSON.parse` would otherwise reject a valid document.

`os.homedir()` semantics are documented by Node
([os.homedir](https://nodejs.org/api/os.html#oshomedir)); path composition uses
`node:path` ([path](https://nodejs.org/api/path.html)).

## 3. Platform-by-platform differences

| Concern | Linux | macOS | Windows | Handled by |
|---|---|---|---|---|
| Home directory | `$HOME`/passwd | `$HOME` | `%USERPROFILE%` | `os.homedir()` |
| Primary credential layout | home-relative (CANNWork hardcode) | home-relative | home-relative (`%USERPROFILE%`) | resolver |
| Future env-paths layout | n/a | `~/Library/Application Support` / `Preferences` | `%LOCALAPPDATA%\opencode\Data` / `%APPDATA%\opencode\Config` | fallback candidates |
| Path separator | `/` | `/` | `\` (drive letters) | `node:path.join` |
| Filesystem case | sensitive | insensitive by default | insensitive | fixed file names; no case folding needed |
| File permissions / ACL | `rw`/`ro` bits | POSIX + sandbox flags | NTFS ACL | read-only access; failure degrades to "missing credential" |
| Line endings | LF | LF | CRLF | JSON parsing; no files written |
| BOM | rare | rare | possible | stripped |
| Symlinked credential file | possible | possible | junction/symlink | `readFileSync` follows |
| Long path (>260 chars) | n/a | n/a | possible with deep profiles | Node wide APIs; not specifically exercised |
| Shell for dev scripts | sh/bash | zsh/sh | cmd/PowerShell | `npm run check` is Node-only; `check-secrets.sh` is an optional POSIX wrapper |
| npm script chaining | `&&` | `&&` | `&&` in cmd | replaced by a Node runner for tests/checks |
| Proxy / corporate CA | environment | environment | environment | Node fetch; `NODE_EXTRA_CA_CERTS` works, `HTTPS_PROXY` is not implemented by undici by default |

## 4. Packaging and installation

- The package is a DSH bundle: `package.json.dsh.bundle.patch` points at a
  one-row YAML patch; there is no platform-conditional content.
- Installation is `dsh plugin --profile <name> add file:<absolute path>` (pnpm).
  The package has no `preinstall`/`install`/`postinstall` script; pnpm's
  `file:` dependency uses a directory link/hard links, so a Windows path with
  spaces or a drive letter is handled by pnpm, not by plugin code.
- The bundle declares only host packages as peers; pnpm does not install them
  into the profile (the profile uses `nodeLinker: hoisted`,
  `autoInstallPeers: false`). No native binary is downloaded.
- The host-matrix tooling creates directory links for its temporary host
  roots; on Windows it uses a junction so a normal (non-elevated) account can
  run `npm run test:compat`.
- `npm pack`/`npm publish` content is platform-neutral: JS, JSON, SVG, Markdown.
- The `icon.svg` and locale JSON are read by the host's Plugin Manager, not by
  the plugin; their validation is platform-independent.

## 5. Verification on macOS and Windows (when available)

Only Linux has been executed. On a macOS or Windows machine with the same DSH
host, run in this order and record the result:

1. `node -v` — must satisfy `engines` (≥24.9; alpha ≥24.22.3).
2. `npm run check` — syntax, 17 offline suites, host matrix when a host is
   configured, coverage thresholds, secret scan. This uses Node and Git only.
3. `npm run test:compat` — set `CANNBOT_HOST_STABLE` / `CANNBOT_HOST_ALPHA`, or
   rely on `DSH_INSTALL_DIR` when launched from a profile.
4. With CANNWork signed in, run `node e2e.mjs`; it prints which credential roots
   were used (`jwt=present (home-data) vk=present (home-config)`), which is the
   fastest way to confirm the platform path conventions.
5. Open **Plugins** in DSH and verify the icon, English/Chinese title and
   description, and the detail page (visual verification is manual).
6. Report any path that was not the expected one; add it as a candidate and a
   `credentials-platform` case.

## 6. Risk register

Likelihood/impact are for macOS/Windows deployments that were not executed here.

| # | Risk | Platform | L | I | Mitigation | Residual |
|---|---|---|---|---|---|---|
| 1 | opencode moves credentials to env-paths | macOS/Windows | M | H | platform fallbacks; `label` in diagnostics; test matrix | a stale primary file can shadow the moved one until removed |
| 2 | `USERPROFILE` vs `HOME` in tests | Windows | H | M | every offline test sets both; production uses `os.homedir()` | none known |
| 3 | Path separator / drive letter | Windows | L | M | `node:path.join`; no hand-built separators | not executed; low |
| 4 | BOM-prefixed JSON | Windows | M | L | BOM stripped in `readJsonEntry`; test | none known |
| 5 | macOS app sandbox blocks `~/Library` | macOS | L | M | DSH is not sandboxed; read-only access | not executed; low |
| 6 | ACL/permission denies a file | all | L | M | unreadable file is "missing credential", explicit diagnostic; no crash | user must fix access |
| 7 | Long path > 260 chars | Windows | L | L | Node wide APIs | not exercised |
| 8 | Non-ASCII home/profile name | all | L | L | Node paths are UTF-16/UTF-8 aware; JSON is UTF-8 | not exercised |
| 9 | Corporate proxy / custom CA | all | M | H | `NODE_EXTRA_CA_CERTS`; no proxy support implemented | user/network config needed |
| 10 | `check-secrets.sh` run on Windows | Windows | M | L | canonical check is `scripts/check-secrets.mjs`; `npm run check` uses it | shell wrapper is POSIX-only |
| 11 | Host DSH not supported on a platform | all | unknown | H | out of plugin control; documented as a dependency | host decision |
| 12 | Native dependency appears later | all | L | H | current dependency audit: zero native modules | must re-audit when adding a dependency |

## 7. What is simulated vs executed

- **Executed on Linux**: runtime logic, HTTP/SSE behavior, image budget, catalog
  lifecycle, credential lookup on the Linux layout and on fake home trees for
  macOS/Windows layouts (candidate order, BOM, fallback reads), host matrix on
  two DSH lines, live gateway.
- **Simulated on Linux**: macOS/Windows candidate paths use the same resolver
  with an injected `platform`, `home`, and environment; the test creates the
  corresponding directories under a Linux temp tree. Path separators and ACLs
  are not simulated.
- **Analysed only**: the platform-by-platform table above, packaging behavior,
  proxy/CA behavior, and the host's own platform support.

## 8. Change rule

Any change that adds a platform branch, an environment variable, or a filesystem
assumption must:

1. extend `credentialRootEntries` or the relevant pure function with an
   injectable `platform`/`env`/`home`;
2. add a row to `test/credentials-platform.mjs` (or the relevant suite);
3. update this document's candidate table and risk register;
4. keep runtime code free of shell commands and platform-specific APIs.
