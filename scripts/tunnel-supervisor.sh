#!/bin/sh
# Keep a reverse SSH tunnel from the local CANNBOT model service to a remote dev
# host, and clear the one failure a plain retry loop cannot fix by itself.
#
# When the client dies without closing its TCP connection (Mac sleep, network
# change), the remote sshd keeps listening on the forwarded port but forwards
# nothing. Every reconnect then fails with "remote port forwarding failed".
# Before retrying, this supervisor asks the remote endpoint for /healthz; when it
# does not answer, it kills the TTY-less sshd session holding the port
# (passwordless sudo required) and retries. A healthy tunnel is never touched,
# and a listener that is not an sshd is never killed.
#
# Usage: tunnel-supervisor.sh <port> <host> [host...]

set -u

PORT="${1:?usage: $0 <port> <host> [host...]}"
shift
[ "$#" -gt 0 ] || {
  echo "usage: $0 <port> <host> [host...]" >&2
  exit 2
}

SSH_OPTS="-N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ConnectTimeout=15 -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o StrictHostKeyChecking=accept-new"

# A POSIX sh program sent to the remote host over `ssh -T host sh -s`.
# The local port expands here; every remote-side variable is escaped.
remote_cleanup() {
  cat <<EOF
if ! command -v curl >/dev/null 2>&1; then exit 0; fi
curl -fsS -m 2 http://127.0.0.1:${PORT}/healthz >/dev/null 2>&1 && exit 0
if ! sudo -n true 2>/dev/null; then
  echo "[supervisor] remote sudo needs a password; cannot clear a stale forward on port ${PORT}" >&2
  exit 0
fi
if command -v ss >/dev/null 2>&1; then
  pid=\$(sudo -n ss -ltnp 2>/dev/null | sed -n 's/.*:${PORT}[[:space:]].*pid=\([0-9][0-9]*\).*/\1/p' | head -n 1)
else
  pid=\$(sudo -n netstat -ltnp 2>/dev/null | awk '\$4 ~ ":${PORT}\$" {split(\$7, a, "/"); print a[1]; exit}')
fi
[ -n "\$pid" ] || exit 0
args=\$(sudo -n ps -o args= -p "\$pid" 2>/dev/null)
tty=\$(sudo -n ps -o tty= -p "\$pid" 2>/dev/null | tr -d '[:space:]')
case "\$args" in sshd:*) ;; *) exit 0 ;; esac
case "\$args" in *"[listener]"*) exit 0 ;; esac
[ "\$tty" = "?" ] || exit 0
echo "[supervisor] clearing stale sshd \$pid on remote port ${PORT}" >&2
sudo -n kill "\$pid" 2>/dev/null || true
sleep 1
EOF
}

supervise() {
  host="$1"
  while :; do
    # shellcheck disable=SC2086
    /usr/bin/ssh $SSH_OPTS -R "127.0.0.1:${PORT}:127.0.0.1:${PORT}" "$host"
    status=$?
    echo "[supervisor] $(/bin/date '+%Y-%m-%d %H:%M:%S') tunnel to $host exited ($status)" >&2
    # Keep the remote cleanup's stderr (it names the pid it cleared); drop stdout.
    remote_cleanup | /usr/bin/ssh -T -o BatchMode=yes -o ConnectTimeout=15 \
      -o StrictHostKeyChecking=accept-new "$host" 'sh -s' >/dev/null
    /bin/sleep 10
  done
}

# launchd stops the job with SIGTERM; take the ssh children down with it.
trap 'trap - TERM INT; kill $(jobs -p) 2>/dev/null; exit 0' TERM INT

for host in "$@"; do
  supervise "$host" &
done
wait
