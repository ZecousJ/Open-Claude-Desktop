#!/usr/bin/env bash
# Builds the Claudex server (the Sub2API fork in backend/ of this repository)
# with local toolchains, for hosts where the Docker image cannot run.
#
#   deploy/sub2api/build-from-source.sh [--out DIR]
#
# Builds the Vue admin console (embedded into the binary) and the Go server,
# the same steps as deploy/claudex-server/Dockerfile, and writes
#   $OUT/sub2api              the server binary
#   $OUT/resources/           fallback model-pricing data read at startup
#   $OUT/LICENSE              LGPL-3.0 (backend/LICENSE)
#   $OUT/COPYING              GPL-3.0, on which the LGPL builds (backend/COPYING)
#   $OUT/CLAUDEX_CHANGES.md   the changes made to Sub2API
#   $OUT/SOURCE.txt           version, commit and where the corresponding source is
# Default OUT: work/claudex-server (ignored by git).
#
# Requires Node.js 24 with pnpm 9 (corepack) and Go (GOTOOLCHAIN=auto fetches
# the version backend/backend/go.mod asks for). Without them, build the image
# (deploy/claudex-server/build-image.sh) or use scripts/backend/build.sh, which
# run the toolchains in Docker.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd -P)
OUT="$ROOT/work/claudex-server"
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT=${2:?--out needs a directory}; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "Usage: $0 [--out DIR]" >&2; exit 2 ;;
  esac
done
FORK="$ROOT/backend"
[ -f "$FORK/backend/go.mod" ] || { echo "No Sub2API fork at $FORK" >&2; exit 2; }

base=$(tr -d '\r\n' < "$FORK/backend/cmd/server/VERSION")
rev=${CLAUDEX_REV:-$(git -C "$ROOT" rev-list --count HEAD -- backend 2>/dev/null || echo 0)}
commit=$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)
if [ "$commit" != unknown ] && [ -n "$(git -C "$ROOT" status --porcelain -- backend deploy/sub2api 2>/dev/null)" ]; then
  commit="$commit-dirty"
fi
# Semver build metadata, as in deploy/claudex-server/Dockerfile.
VERSION="$base+claudex.$rev"
upstream=$(sed -n 's/^[[:space:]]*UpstreamCommit[[:space:]]*=[[:space:]]*"\([0-9a-f]*\)".*/\1/p' "$FORK/backend/internal/claudex/module.go")
source_url=${SOURCE_URL:-https://github.com/ZecousJ/Open-Claude-Desktop}

echo "Building the admin console (pnpm, frozen lockfile)"
(cd "$FORK/frontend" && pnpm install --frozen-lockfile && pnpm run build)

echo "Building Claudex server $VERSION (commit $commit)"
mkdir -p "$OUT"
(cd "$FORK/backend" && CGO_ENABLED=0 GOTOOLCHAIN=${GOTOOLCHAIN:-auto} go build \
  -tags embed -trimpath \
  -ldflags "-s -w -X main.Version=$VERSION -X main.Commit=$commit -X main.Date=$(date -u +%Y-%m-%dT%H:%M:%SZ) -X main.BuildType=source" \
  -o "$OUT/sub2api" ./cmd/server)
rm -rf "$OUT/resources"
cp -R "$FORK/backend/resources" "$OUT/resources"
cp "$FORK/LICENSE" "$OUT/LICENSE"
cp "$FORK/COPYING" "$OUT/COPYING"
cp "$FORK/CLAUDEX_CHANGES.md" "$OUT/CLAUDEX_CHANGES.md"
{
  echo "Claudex server $VERSION"
  echo "Built from $source_url, commit $commit."
  echo
  echo "This program is a modified version of Sub2API (https://github.com/Wei-Shaw/sub2api,"
  echo "commit ${upstream:-unknown}), licensed under the GNU Lesser General Public License v3.0;"
  echo "the license texts are LICENSE (LGPL-3.0) and COPYING (GPL-3.0);"
  echo "CLAUDEX_CHANGES.md lists the changes."
  echo
  echo "Corresponding source: the backend/ directory of $source_url at commit $commit,"
  echo "built with deploy/sub2api/build-from-source.sh from the same commit."
  case "$commit" in
    *-dirty | unknown)
      echo
      echo "WARNING: built from uncommitted changes or an unknown commit. There is no exact"
      echo "corresponding source commit for this build: do not distribute it."
      ;;
  esac
} > "$OUT/SOURCE.txt"
echo "Built $OUT/sub2api"
"$OUT/sub2api" --version 2>/dev/null || true
