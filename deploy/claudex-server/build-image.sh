#!/usr/bin/env bash
# Builds the Claudex server image from backend/ with the version and commit
# filled in:
#
#   deploy/claudex-server/build-image.sh [--tag NAME[:TAG]] [--platform P] [-- <docker build args>]
#
# Version: <backend/backend/cmd/server/VERSION>+claudex.<N> (semver build
# metadata), where N counts the commits that touched backend/ (CLAUDEX_REV
# overrides it). The commit gets a "-dirty" suffix when backend/ or this folder
# has uncommitted changes; such an image says in /app/SOURCE.txt that it must
# not be distributed.
# Default tags: claudex-server:<version with "+" as "-"> (image tags cannot
# contain "+") and claudex-server:latest.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd -P)
TAG=""
PLATFORM=""
extra=()
while [ $# -gt 0 ]; do
  case "$1" in
    --tag) TAG=${2:?--tag needs a name}; shift 2 ;;
    --platform) PLATFORM=${2:?--platform needs a value}; shift 2 ;;
    --) shift; extra=("$@"); break ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "Unknown option $1 (see --help)" >&2; exit 2 ;;
  esac
done

base=$(tr -d '\r\n' < "$ROOT/backend/backend/cmd/server/VERSION")
if [ -z "${CLAUDEX_REV:-}" ]; then
  CLAUDEX_REV=$(git -C "$ROOT" rev-list --count HEAD -- backend 2>/dev/null || echo 0)
fi
commit=$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)
if [ "$commit" != unknown ] && [ -n "$(git -C "$ROOT" status --porcelain -- backend deploy/claudex-server 2>/dev/null)" ]; then
  commit="$commit-dirty"
fi
version="$base+claudex.$CLAUDEX_REV"
source_url=${SOURCE_URL:-https://github.com/ZecousJ/Open-Claude-Desktop}

tags=()
if [ -n "$TAG" ]; then tags=(-t "$TAG"); else tags=(-t "claudex-server:${version//+/-}" -t claudex-server:latest); fi
platform=()
[ -n "$PLATFORM" ] && platform=(--platform "$PLATFORM")

echo "Building Claudex server $version (commit $commit)"
exec docker build \
  -f "$ROOT/deploy/claudex-server/Dockerfile" \
  --build-arg "CLAUDEX_REV=$CLAUDEX_REV" \
  --build-arg "GIT_COMMIT=$commit" \
  --build-arg "SOURCE_URL=$source_url" \
  "${tags[@]}" ${platform[@]+"${platform[@]}"} ${extra[@]+"${extra[@]}"} \
  "$ROOT/backend"
