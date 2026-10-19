#!/bin/sh
# Pre-publish guard: fail if any credential literal or machine-specific path
# reaches the tracked tree or the git history.
#
# Usage: ./check-secrets.sh
set -e

cd "$(dirname "$0")"

PATTERNS='vk-[0-9a-fA-F]{16,}|eyJ[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20,}|GITCODE_API_TOKEN|ghp_[A-Za-z0-9]{20,}|/Users/[A-Za-z0-9_-]+/'
STATUS=0

echo "== working tree =="
if git grep -nE "$PATTERNS" -- . ':!check-secrets.sh'; then
  echo "^^ FOUND — remove before publishing"
  STATUS=1
else
  echo "clean"
fi

echo "== git history =="
if git rev-list --all >/dev/null 2>&1; then
  if git grep -nE "$PATTERNS" $(git rev-list --all) -- . ':!check-secrets.sh' 2>/dev/null; then
    echo "^^ FOUND in history — rewrite history before publishing"
    STATUS=1
  else
    echo "clean"
  fi
fi

echo "== tracked files =="
git ls-files

exit $STATUS
