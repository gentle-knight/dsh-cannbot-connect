/**
 * Offline regression for the plugin's host import surface.
 *
 * The plugin runs inside whatever DSH version the profile boots, and DSH has
 * removed helper exports between releases (0.2.3-alpha dropped
 * `assertUsableApiKey` and `normalizeApiKey` from `@deepseek-ai/dsh-llm`). A
 * static `import { missing } from ...` is an ESM instantiation error: the whole
 * plugin fails to load, and every other check here is skipped. This test turns
 * that class of break into a named offline failure by comparing the names the
 * plugin imports with the names the installed host actually exports.
 *
 * Run with `npm test`, and via `scripts/host-matrix.mjs` against the stable and
 * alpha host lines. Exits 0 when every imported symbol exists.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const libDir = join(here, '..', 'lib')

let failures = 0
const fail = (message) => {
  console.error(`FAIL: ${message}`)
  failures += 1
}
const ok = (message) => console.log(`ok   ${message}`)

/** Every `lib/*.js` module, in a stable order. */
function pluginSources() {
  const files = readdirSync(libDir)
    .filter((name) => name.endsWith('.js'))
    .sort()
  return files.map((name) => ({ name, source: readFileSync(join(libDir, name), 'utf8') }))
}

/**
 * Named imports from one module specifier across the plugin's own sources.
 *
 * The imports in this repo are written one name per line, so a literal scan is
 * enough and avoids parsing JavaScript. Anything the regex cannot see is also
 * invisible to an ESM loader only if it is not a static named import.
 */
function namedImports(sources, specifier) {
  const names = new Set()
  const pattern = new RegExp(`import\\s*\\{([\\s\\S]*?)\\}\\s*from\\s*['"]${specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`, 'g')
  for (const { source } of sources) {
    for (const match of source.matchAll(pattern)) {
      for (const part of match[1].split(',')) {
        const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim()
        if (name !== '') names.add(name)
      }
    }
  }
  return [...names].sort()
}

/** Default imports from one module specifier. */
function defaultImports(sources, specifier) {
  const names = new Set()
  const pattern = new RegExp(`import\\s+(?!\\{)([A-Za-z_$][\\w$]*)\\s*(?:,\\s*\\{[^}]*\\}\\s*)?from\\s*['"]${specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`, 'g')
  for (const { source } of sources) {
    for (const match of source.matchAll(pattern)) names.add(match[1])
  }
  return [...names].sort()
}

const sources = pluginSources()
if (sources.length === 0) fail('no plugin sources found under lib/')

// ── @deepseek-ai/dsh-llm named exports ───────────────────────────────────────
const llmNames = namedImports(sources, '@deepseek-ai/dsh-llm')
if (llmNames.length === 0) fail('the plugin imports no symbols from @deepseek-ai/dsh-llm')
const llm = await import('@deepseek-ai/dsh-llm')
for (const name of llmNames) {
  if (name in llm) ok(`dsh-llm exports ${name}`)
  else fail(`dsh-llm does NOT export ${name} (this is a load-time ESM failure in production)`)
}

// ── @deepseek-ai/schemastery default export ──────────────────────────────────
const schemaDefaults = defaultImports(sources, '@deepseek-ai/schemastery')
if (schemaDefaults.length === 0) fail('the plugin imports no default from @deepseek-ai/schemastery')
const schemastery = await import('@deepseek-ai/schemastery')
for (const name of schemaDefaults) {
  if (typeof schemastery.default === 'function') ok(`schemastery default is callable (as ${name})`)
  else fail(`schemastery default is not callable (imported as ${name})`)
}

// ── host version, for the record ────────────────────────────────────────────
try {
  const { createRequire } = await import('node:module')
  const require = createRequire(import.meta.url)
  const version = require('@deepseek-ai/dsh-llm/package.json').version
  console.log(`host @deepseek-ai/dsh-llm: ${version}`)
} catch {
  // A host that does not expose package.json is still a valid import target.
}

if (failures > 0) {
  console.error(`\nFAIL: ${failures} import-surface check(s) failed.`)
  process.exit(1)
}
console.log('\nPASS: every host symbol the plugin imports exists in this host.')
