#!/usr/bin/env node
/**
 * Keep a **reverse SSH tunnel** from the local CANNBOT model service to a remote
 * dev host, so a VS Code **Remote-SSH** window can use it too.
 *
 * In a Remote-SSH window the Copilot Chat extension runs on the remote host, so
 * the `http://127.0.0.1:8788/v1` endpoint in `chatLanguageModels.json` resolves
 * there, not on this machine. A reverse forward (`ssh -R`) makes the remote's
 * loopback port point back at the local service, which keeps one config URL
 * working in both local and remote windows and keeps the credentials on this
 * machine.
 *
 *     node scripts/install-remote-tunnel.mjs --host <ssh-alias>
 *     node scripts/install-remote-tunnel.mjs --list           # candidate hosts
 *     node scripts/install-remote-tunnel.mjs --uninstall
 *
 * The forward is exposed on the remote's loopback only (sshd's default
 * `GatewayPorts no`), so it is not reachable from the dev host's network.
 *
 * The installed LaunchAgent runs `tunnel-supervisor.sh`: after the client dies
 * without closing its TCP connection (Mac sleep, network change), the remote
 * sshd can keep the forwarded port without forwarding anything. The supervisor
 * checks the remote `/healthz`, clears that stale TTY-less sshd when it has
 * passwordless sudo, and retries, instead of looping on "remote port forwarding
 * failed" until the user kills it by hand.
 *
 * @module dsh-cannbot-connect/install-remote-tunnel
 */

import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** LaunchAgent label of the tunnel job. */
const LABEL = 'com.dsh-cannbot-connect.remote-tunnel'

/** Default loopback port, matching the local service. */
const DEFAULT_PORT = 8788

/** Parsed confidently as a dev-host alias. */
const DEV_HOST_RE = /(devenvc|devspace|atomgit)/i

/** Parse `--flag value` / `--flag=value`, keeping repeated flags as a list. */
function parseArgs(argv) {
  const flags = {}
  const push = (key, value) => {
    if (flags[key] === undefined) flags[key] = value
    else if (Array.isArray(flags[key])) flags[key].push(value)
    else flags[key] = [flags[key], value]
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const eq = arg.indexOf('=')
    if (eq !== -1) {
      push(arg.slice(2, eq), arg.slice(eq + 1))
      continue
    }
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      push(key, 'true')
      continue
    }
    push(key, next)
    i += 1
  }
  return flags
}

/** The SSH config file VS Code itself uses (`remote.SSH.configFile` or default). */
function sshConfigPath() {
  if (process.platform === 'darwin') {
    try {
      const raw = readFileSync(join(homedir(), 'Library', 'Application Support', 'Code', 'User', 'settings.json'), 'utf-8')
      const match = /"remote\.SSH\.configFile"\s*:\s*"([^"]+)"/.exec(raw)
      if (match !== null && match[1].trim() !== '') return match[1].replace(/^~/, homedir())
    } catch {
      // fall through to the default
    }
  }
  return join(homedir(), '.ssh', 'config')
}

/**
 * SSH host aliases of the Remote-SSH workspaces VS Code opened recently.
 *
 * This is the most reliable source: VS Code stores the remote authority
 * (`vscode-remote://ssh-remote%2B<alias>`) in each workspace's `workspace.json`,
 * even when the alias comes from an `Include`d config or a `Host *` match block
 * rather than a plain `Host` line.
 */
function remoteWorkspaceHosts() {
  const dir = join(homedir(), 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage')
  if (!existsSync(dir)) return []
  const entries = readdirSync(dir)
    .map((name) => {
      const file = join(dir, name, 'workspace.json')
      try {
        return { file, at: statSync(file).mtimeMs }
      } catch {
        return undefined
      }
    })
    .filter((entry) => entry !== undefined)
    .sort((a, b) => b.at - a.at)

  const hosts = []
  for (const { file } of entries) {
    let raw
    try {
      raw = readFileSync(file, 'utf-8')
    } catch {
      continue
    }
    for (const match of raw.matchAll(/ssh-remote(?:%2B|\+)([^/\\"]+)/gi)) {
      const alias = decodeURIComponent(match[1])
      if (!hosts.includes(alias)) hosts.push(alias)
    }
  }
  return hosts
}

/** Host aliases in the SSH config that look like a remote dev environment. */
function candidateHosts() {
  const file = sshConfigPath()
  if (!existsSync(file)) return []
  const hosts = []
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    const match = /^\s*Host\s+(.+)$/i.exec(line)
    if (match === null) continue
    for (const alias of match[1].trim().split(/\s+/)) {
      if (alias === '' || alias.includes('*') || alias.includes('?') || alias.includes('!')) continue
      if (DEV_HOST_RE.test(alias) && !hosts.includes(alias)) hosts.push(alias)
    }
  }
  return hosts
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

/** Where the tunnel agent's plist lives. */
function plistPath() {
  return join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
}

/** Where the tunnel's ssh output lands. */
function logPath() {
  return join(homedir(), 'Library', 'Logs', 'dsh-cannbot-connect-tunnel.log')
}

/**
 * The self-healing supervisor installed for launchd.
 *
 * It lives outside the repository so moving or deleting the checkout does not
 * break the LaunchAgent; every install refreshes it from {@link supervisorSource}.
 */
function supervisorPath() {
  return join(homedir(), '.dsh', 'bin', 'dsh-cannbot-connect-tunnel.sh')
}

/** The supervisor shipped next to this installer. */
function supervisorSource() {
  return join(dirname(fileURLToPath(import.meta.url)), 'tunnel-supervisor.sh')
}

/** Run launchctl, reporting failures instead of throwing. */
function launchctl(args) {
  try {
    return execFileSync('/bin/launchctl', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    const detail = `${error.stderr ?? ''}${error.stdout ?? ''}`.trim()
    return { failed: true, detail: detail === '' ? String(error.message) : detail }
  }
}

/** Is the tunnel job bootstrapped for this user? */
function isLoaded() {
  const result = launchctl(['print', `gui/${process.getuid()}/${LABEL}`])
  return typeof result === 'string' && result !== ''
}

/** Stop the job if it is loaded; never fatal. */
function bootout() {
  if (isLoaded()) launchctl(['bootout', `gui/${process.getuid()}/${LABEL}`])
}

/** Render the LaunchAgent plist. */
function plistXml({ hosts, port, supervisor }) {
  const args = ['/bin/sh', supervisor, String(port), ...hosts]
    .map((value) => `    <string>${escapeXml(value)}</string>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>15</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(logPath())}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logPath())}</string>
</dict>
</plist>
`
}

function main() {
  if (process.platform !== 'darwin') {
    process.stderr.write('this installer is macOS-only; run the ssh -R forward yourself on another platform\n')
    process.exit(1)
  }
  const flags = parseArgs(process.argv.slice(2))

  if (flags.help !== undefined) {
    process.stdout.write(`Usage: node scripts/install-remote-tunnel.mjs --host <ssh-alias> [...]

  --host <alias>   SSH host alias of the remote VS Code window (repeatable).
                   In VS Code the alias is the part after "ssh-remote+" in the
                   window's remote authority.
  --port <n>       local service port to forward (default ${DEFAULT_PORT})
  --list           print candidate dev-host aliases from the SSH config
  --uninstall      stop the tunnel and remove its plist + supervisor
  --help           show this help

The installed supervisor clears a stale remote forward after a client death
(Mac sleep, network change) when passwordless sudo is available on the remote;
it only kills a TTY-less sshd that holds this port and does not answer /healthz.
`)
    return
  }

  if (flags.list !== undefined) {
    const seen = [...new Set([...remoteWorkspaceHosts(), ...candidateHosts()])]
    if (seen.length === 0) process.stdout.write('no candidate hosts found\n')
    else process.stdout.write(`${seen.join('\n')}\n`)
    return
  }

  if (flags.uninstall !== undefined) {
    bootout()
    if (existsSync(plistPath())) rmSync(plistPath())
    if (existsSync(supervisorPath())) rmSync(supervisorPath())
    process.stdout.write(`removed ${LABEL}\n`)
    return
  }

  const rawHosts = flags.host === undefined ? [] : Array.isArray(flags.host) ? flags.host : [flags.host]
  const hosts = rawHosts.flatMap((value) => String(value).split(',').map((part) => part.trim())).filter(Boolean)
  if (hosts.length === 0) {
    const detected = remoteWorkspaceHosts()
    if (detected.length > 0) {
      hosts.push(detected[0])
      process.stdout.write(`detected remote window host: ${detected[0]}\n`)
    } else {
      const candidates = candidateHosts()
      process.stderr.write(
        'no --host given and no Remote-SSH workspace found; pass the SSH alias (see --list).\n' +
          (candidates.length === 0 ? '' : `candidates:\n  ${candidates.join('\n  ')}\n`),
      )
      process.exit(1)
    }
  }
  const port = Number(flags.port ?? DEFAULT_PORT)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port: ${String(flags.port)}`)

  const supervisor = supervisorPath()
  mkdirSync(dirname(supervisor), { recursive: true })
  copyFileSync(supervisorSource(), supervisor)
  chmodSync(supervisor, 0o700)

  mkdirSync(dirname(plistPath()), { recursive: true })
  mkdirSync(dirname(logPath()), { recursive: true })
  writeFileSync(plistPath(), plistXml({ hosts, port, supervisor }))
  chmodSync(plistPath(), 0o600)

  bootout()
  let result = launchctl(['bootstrap', `gui/${process.getuid()}`, plistPath()])
  for (let attempt = 0; attempt < 3 && typeof result !== 'string' && result.failed; attempt += 1) {
    execFileSync('/bin/sleep', ['0.5'])
    result = launchctl(['bootstrap', `gui/${process.getuid()}`, plistPath()])
  }
  if (typeof result !== 'string' && result.failed) {
    throw new Error(`launchctl bootstrap failed: ${result.detail}`)
  }

  process.stdout.write(`installed : ${plistPath()}\n`)
  process.stdout.write(`supervisor: ${supervisor}\n`)
  process.stdout.write(`tunnel    : ${hosts.join(', ')} → 127.0.0.1:${port} (on the remote loopback)\n`)
  process.stdout.write(`logs      : ${logPath()}\n`)
  process.stdout.write('verify   : open a terminal in the remote window and run\n')
  process.stdout.write(`           curl -s http://127.0.0.1:${port}/healthz\n`)
  process.stdout.write(`stop it  : node scripts/install-remote-tunnel.mjs --uninstall\n`)
}

try {
  main()
} catch (error) {
  process.stderr.write(`${error?.message ?? error}\n`)
  process.exit(1)
}
