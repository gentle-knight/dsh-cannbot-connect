/**
 * Offline checks for the bundle manifest and its Cordis patch.
 *
 * `plugin_manager` installs this package as a bundle: it reads
 * `package.json.dsh.bundle.patch`, applies the YAML layer, and then lets the
 * Loader activate each inserted row by its `name` (the module specifier). A
 * typo in either file fails at install/activation time, outside every adapter
 * test, so these checks pin the two files together and keep the packaged file
 * list honest.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(here, '..')
const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))

let failures = 0
const fail = (message) => {
  console.error(`FAIL: ${message}`)
  failures += 1
}
const ok = (message) => console.log(`ok   ${message}`)

const check = (label, predicate, detail) => {
  if (predicate) ok(label)
  else fail(`${label}${detail === undefined ? '' : `: ${detail}`}`)
}

/** Resolve a package-relative path and prove it stays inside the package. */
function insidePackage(relPath) {
  const absolute = resolve(packageDir, relPath)
  const rel = relative(packageDir, absolute)
  return rel !== '' && !rel.startsWith('..') && !rel.includes(`..${process.platform === 'win32' ? '\\' : '/'}`)
}

// ── identity and bundle wiring ───────────────────────────────────────────────
check('package name is dsh-cannbot-connect', manifest.name === 'dsh-cannbot-connect', manifest.name)
check('package type is module', manifest.type === 'module', manifest.type)
check('version is a semver string', /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version), manifest.version)
check('main points at a file', typeof manifest.main === 'string' && existsSync(join(packageDir, manifest.main)))
check(
  'dsh.bundle.patch is declared',
  typeof manifest.dsh?.bundle?.patch === 'string' && manifest.dsh.bundle.patch !== '',
)
check('dsh.bundle.patch stays inside the package', insidePackage(manifest.dsh.bundle.patch))
check(
  'dsh.bundle.patch exists',
  existsSync(join(packageDir, manifest.dsh.bundle.patch)),
  manifest.dsh.bundle.patch,
)
check('exports. maps to a file', typeof manifest.exports?.['.'] === 'string' && existsSync(join(packageDir, manifest.exports['.'])))
check(
  'exports["./cordis.patch.yml"] maps to the declared patch',
  manifest.exports?.['./cordis.patch.yml'] === manifest.dsh.bundle.patch,
)

// ── patch rows ───────────────────────────────────────────────────────────────
const patch = readFileSync(join(packageDir, manifest.dsh.bundle.patch), 'utf8')
const rows = [...patch.matchAll(/-\s*insert:\s*\n((?:\s+.*\n?)*)/g)]
check('patch has at least one insert layer', rows.length >= 1, `${rows.length}`)
const rowIds = [...patch.matchAll(/^\s*-\s*id:\s*(\S+)\s*$/gm)].map((match) => match[1])
const rowNames = [...patch.matchAll(/^\s*name:\s*(\S+)\s*$/gm)].map((match) => match[1])
check('patch inserts exactly one row', rowIds.length === 1, rowIds.join(','))
check('patch row id is llm-cannbot', rowIds[0] === 'llm-cannbot', rowIds[0])
check('patch row name is the package name', rowNames[0] === manifest.name, rowNames[0])
check(
  'patch is not empty and has no absolute path',
  patch.trim() !== '' && !/^[/~]/m.test(patch),
)

// ── packaged files ──────────────────────────────────────────────────────────
const files = Array.isArray(manifest.files) ? manifest.files : []
check('files includes lib', files.includes('lib'))
check('files includes the patch', files.includes(manifest.dsh.bundle.patch.replace(/^\.\//, '')))
check('files includes README', files.includes('README.md'))
check('files does not include node_modules or scratch', !files.some((entry) => /node_modules|scratch|reports/.test(entry)))
check('files includes the locale documents', files.includes('locale/*.json'))
check('files includes the icon', files.includes('icon.svg'))
check('files includes the detail documents', files.includes('docs'))
check('exports exposes ./icon', manifest.exports?.['./icon'] === './icon.svg')
check('exports exposes the locale JSON', manifest.exports?.['./locale/*.json'] === './locale/*.json')

// Every declared runtime file must exist. `files` is a packaging filter, not a
// guarantee, and a local directory install links the checkout instead of a
// tarball, so a typo would only show up after publishing.
for (const entry of files) {
  if (/[*?]/.test(entry)) continue // glob entries are checked by `npm pack`
  const absolute = join(packageDir, entry)
  if (!existsSync(absolute)) fail(`declared file does not exist: ${entry}`)
}
ok('declared non-glob files exist')

// ── supply chain ────────────────────────────────────────────────────────────
const scripts = manifest.scripts ?? {}
check('no preinstall script', scripts.preinstall === undefined)
check('no install script', scripts.install === undefined)
check('no postinstall script', scripts.postinstall === undefined)
check('engines.dsh is declared', typeof manifest.engines?.dsh === 'string')
check('engines.node is declared', typeof manifest.engines?.node === 'string')

// ── metadata declared by later phases (checked when present) ────────────────
if (manifest.icon !== undefined) {
  check('icon file exists', existsSync(join(packageDir, manifest.icon)), manifest.icon)
  check('icon is inside the package', insidePackage(manifest.icon))
  check('icon is not a directory', !statSync(join(packageDir, manifest.icon)).isDirectory())
}
for (const localePath of ['locale/en.json', 'locale/zh.json']) {
  if (!existsSync(join(packageDir, localePath))) continue
  const locale = JSON.parse(readFileSync(join(packageDir, localePath), 'utf8'))
  check(`${localePath} declares meta.title`, typeof locale.meta?.title === 'string' && locale.meta.title !== '')
  check(
    `${localePath} declares meta.description`,
    typeof locale.meta?.description === 'string' && locale.meta.description !== '',
  )
  if (locale.meta?.detail !== undefined) {
    check(`${localePath} detail is a package-relative markdown file`, insidePackage(locale.meta.detail) && locale.meta.detail.endsWith('.md'))
    check(`${localePath} detail exists`, existsSync(join(packageDir, locale.meta.detail)))
  }
}

if (failures > 0) {
  console.error(`\nFAIL: ${failures} manifest check(s) failed.`)
  process.exit(1)
}
console.log('\nPASS: bundle manifest and patch agree with the packaged files.')
