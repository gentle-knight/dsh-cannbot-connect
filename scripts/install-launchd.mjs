#!/usr/bin/env node
/**
 * Install the CANNBOT local model service as a macOS LaunchAgent, so the
 * endpoint an editor sidebar points at is up whether or not DSH happens to be
 * running.
 *
 *     node scripts/install-launchd.mjs                  # install and start
 *     node scripts/install-launchd.mjs --port 8788      # pick the port
 *     node scripts/install-launchd.mjs --uninstall      # stop and remove
 *
 * The plist is written to `~/Library/LaunchAgents/`, logs go to
 * `~/Library/Logs/dsh-cannbot-connect.log`, and the job is reloaded through
 * `launchctl bootstrap gui/$UID` (the same mechanism `launchctl load` uses, but
 * not deprecated). Nothing is written outside those two paths.
 *
 * @module dsh-cannbot-connect/install-launchd
 */

import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** LaunchAgent label; also the `launchctl` service name. */
const LABEL = 'com.dsh-cannbot-connect.local-server'

/** Default loopback port, matching `lib/local-server.js`. */
const DEFAULT_PORT = 8788

/** Absolute path to the service entry point. */
const SERVER_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'local-server.js')

/** Parse `--flag value` / `--flag=value` arguments. */
function parseArgs(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const eq = arg.indexOf('=')
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1)
      continue
    }
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      flags[key] = 'true'
      continue
    }
    flags[key] = next
    i += 1
  }
  return flags
}

/** Where the agent's plist lives. */
function plistPath() {
  return join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
}

/** Where the agent's stdout/stderr land. */
function logPath() {
  return join(homedir(), 'Library', 'Logs', 'dsh-cannbot-connect.log')
}

/** Run launchctl, tolerating "not loaded" style failures. */
function launchctl(args) {
  try {
    return execFileSync('/bin/launchctl', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    const detail = `${error.stderr ?? ''}${error.stdout ?? ''}`.trim()
    return { failed: true, detail: detail === '' ? String(error.message) : detail }
  }
}

/** Has the job been bootstrapped for this user? */
function isLoaded() {
  const result = launchctl(['print', `gui/${process.getuid()}/${LABEL}`])
  return typeof result === 'string' && result !== ''
}

/** Stop the job if it is loaded; never fatal. */
function bootout() {
  if (!isLoaded()) return
  launchctl(['bootout', `gui/${process.getuid()}/${LABEL}`])
}

/** Escape a value for XML text/attribute context. */
function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** Render the LaunchAgent plist. */
function plistXml({ port, nodePath, env }) {
  const environment = Object.entries(env)
    .map(([key, value]) => `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(SERVER_ENTRY)}</string>
    <string>--port</string>
    <string>${escapeXml(port)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
${environment === '' ? '' : `${environment}\n`}  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${logPath()}</string>
  <key>StandardErrorPath</key>
  <string>${logPath()}</string>
</dict>
</plist>
`
}

function main() {
  if (process.platform !== 'darwin') {
    process.stderr.write('this installer is macOS-only; start the service with `node lib/local-server.js` instead\n')
    process.exit(1)
  }
  const flags = parseArgs(process.argv.slice(2))
  if (flags.help !== undefined) {
    process.stdout.write(`Usage: node scripts/install-launchd.mjs [options]

  --port <n>        loopback port (default ${DEFAULT_PORT})
  --key <token>     require this key from local clients (CANNBOT_LOCAL_KEY)
  --uninstall       stop the agent and remove its plist
  --help            show this help
`)
    return
  }

  if (flags.uninstall !== undefined) {
    bootout()
    if (existsSync(plistPath())) rmSync(plistPath())
    process.stdout.write(`removed ${LABEL}\n`)
    return
  }

  const port = Number(flags.port ?? DEFAULT_PORT)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port: ${String(flags.port)}`)
  const nodePath = process.execPath
  const env = {}
  if (flags.key !== undefined) env.CANNBOT_LOCAL_KEY = String(flags.key)

  mkdirSync(dirname(plistPath()), { recursive: true })
  mkdirSync(dirname(logPath()), { recursive: true })
  // The plist can carry CANNBOT_LOCAL_KEY, so it is owner-only like any file
  // that holds a secret.
  writeFileSync(plistPath(), plistXml({ port, nodePath, env }))
  // `mode` above only applies to a newly created file, so tighten an existing
  // plist explicitly — it can carry CANNBOT_LOCAL_KEY.
  chmodSync(plistPath(), 0o600)

  bootout()
  // launchd occasionally answers EIO when the same label is bootstrapped right
  // after being booted out, so retry briefly before giving up.
  let result = launchctl(['bootstrap', `gui/${process.getuid()}`, plistPath()])
  for (let attempt = 0; attempt < 3 && typeof result !== 'string' && result.failed; attempt += 1) {
    execFileSync('/bin/sleep', ['0.5'])
    result = launchctl(['bootstrap', `gui/${process.getuid()}`, plistPath()])
  }
  if (typeof result !== 'string' && result.failed) {
    throw new Error(`launchctl bootstrap failed: ${result.detail}`)
  }
  launchctl(['kickstart', '-k', `gui/${process.getuid()}/${LABEL}`])

  process.stdout.write(`installed: ${plistPath()}\n`)
  process.stdout.write(`service  : ${LABEL} on http://127.0.0.1:${port}/v1\n`)
  process.stdout.write(`logs     : ${logPath()}\n`)
  process.stdout.write(`stop it  : node scripts/install-launchd.mjs --uninstall\n`)
}

try {
  main()
} catch (error) {
  process.stderr.write(`${error?.message ?? error}\n`)
  process.exit(1)
}
