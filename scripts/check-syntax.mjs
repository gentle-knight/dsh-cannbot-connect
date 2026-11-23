#!/usr/bin/env node
/**
 * Parse every JavaScript module in the repository before anything executes it.
 *
 * `npm test` imports the `lib/` modules, but the probe scripts, this tooling,
 * and `e2e.mjs` are only parsed when someone runs them. A syntax error there is
 * a broken developer workflow, not a runtime plugin defect, so it belongs in
 * `npm run check` where it costs one `node --check` per file.
 */
import { readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SKIP = new Set(['node_modules', '.git', '.agents', 'coverage', 'scratch', 'reports'])

/** Every `.js`/`.mjs` file under the repository, excluding generated dirs. */
function sources(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) sources(path, out)
    else if (entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)) out.push(path)
  }
  return out
}

const files = sources(root).sort()
let failures = 0
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (result.status === 0) {
    console.log(`ok   ${relative(root, file)}`)
    continue
  }
  failures += 1
  console.error(`FAIL ${relative(root, file)}`)
  console.error((result.stderr ?? '').trim())
}
if (failures > 0) {
  console.error(`\nFAIL: ${failures} file(s) do not parse.`)
  process.exit(1)
}
console.log(`\nPASS: ${files.length} files parse.`)
