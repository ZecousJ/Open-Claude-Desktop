#!/usr/bin/env bash
# Read-only check of a Claudex server; kept at this path for existing scripts.
# The checks live in deploy/claudex-server/check.sh (see its --help).
#
#   deploy/sub2api/check.sh [BASE_URL]      (default http://127.0.0.1:8080)
exec "$(cd "$(dirname "$0")/../claudex-server" && pwd -P)/check.sh" "$@"
