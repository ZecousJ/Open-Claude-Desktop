#!/usr/bin/env bash
# Full build of the Sub2API fork: Vue admin console (node:24-alpine, pnpm 9),
# then the Go server with the console embedded (golang:1.27.0-alpine,
# -tags embed). Output: work/backend/out/sub2api (linux, host CPU architecture),
# which dev-stack.sh runs.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
"$here/fe.sh" install build || exit 1
"$here/go.sh" download build-embed || exit 1
