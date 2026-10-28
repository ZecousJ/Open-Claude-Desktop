#!/usr/bin/env bash
# Seeds a Claudex server (the Sub2API fork in backend/) with the Claudex plan
# groups, upstream account, pricing, public settings and a test user, and with
# --claudex-provisioning the default group of desktop device provisioning. Run
# it from a Claudex checkout (npm ci done) only after the owner has accepted
# the compliance commitment in the admin console; before that it stops with
# exit code 3 and changes nothing.
#
#   deploy/sub2api/seed-claudex.sh --env deploy/sub2api/seed.env --dry-run
#   deploy/sub2api/seed-claudex.sh --env deploy/sub2api/seed.env [--claudex-provisioning]
#
# Exit codes: 0 done, 1 API error, 2 bad configuration, 3 compliance not accepted.
# The logic, and the handler-source citations for every request body, live in
# scripts/sub2api-seed.ts and scripts/sub2api-admin.ts.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd -P)
# Resolve a relative --env path before changing directory.
args=()
while [ $# -gt 0 ]; do
  if [ "$1" = "--env" ] && [ $# -gt 1 ]; then
    case "$2" in /*) args+=("$1" "$2") ;; *) args+=("$1" "$PWD/$2") ;; esac
    shift 2
  else
    args+=("$1")
    shift
  fi
done
cd "$ROOT"
exec npx --no-install tsx scripts/sub2api-seed.ts "${args[@]}"
