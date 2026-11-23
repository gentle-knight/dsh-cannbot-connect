#!/bin/sh
# Pre-publish guard. The implementation lives in scripts/check-secrets.mjs so the
# same check runs on Linux, macOS, and Windows through `npm run check`.
exec node "$(dirname "$0")/scripts/check-secrets.mjs" "$@"
