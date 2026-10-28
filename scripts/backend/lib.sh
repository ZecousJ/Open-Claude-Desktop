# shellcheck shell=bash
# Shared helpers for scripts/backend/*.sh, which build, test and run the Sub2API
# fork in backend/ (Go in backend/backend, Vue in backend/frontend).
# Everything runs in Docker containers; nothing is installed on the host.
# Source this file; do not execute it.
#
# Knobs (environment):
#   CLAUDEX_BACKEND_WORK  work directory for logs and build output (default work/backend, gitignored)
#   GO_IMAGE / NODE_IMAGE / ALPINE_IMAGE   golang:1.27.0-alpine / node:24-alpine / alpine:3.21
#   PNPM_SPEC             pnpm version activated through corepack (default pnpm@9.15.9)
#   CPUS / MEM            limits for every build container (default 3 / 4g)
#   GO_PARALLEL / GO_GOGC / GO_MEMLIMIT    Go toolchain memory knobs (2 / 50 / 3400MiB)
#   RETRIES               attempts for network steps (default 8)
#   GOPROXY_PRIMARY / GOPROXY_ALT          Go module proxies, alternated between attempts
#   FE_NPM_REGISTRY       force one npm registry; otherwise the official registry is tried
#                         FE_OFFICIAL_ATTEMPTS times, then FE_NPM_MIRROR (same tarballs,
#                         pnpm still checks every integrity hash from pnpm-lock.yaml)
#   *_VOLUME              names of the Docker cache volumes (see below)

if [ -z "${BASH_VERSION:-}" ] || [ -z "${BASH_SOURCE[0]:-}" ]; then
  echo "scripts/backend/lib.sh must be sourced from bash" >&2
  return 1 2>/dev/null || exit 1
fi
REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
[ -f "$REPO_ROOT/backend/backend/go.mod" ] || { echo "no Sub2API fork at $REPO_ROOT/backend" >&2; return 1 2>/dev/null || exit 1; }
BACKEND_DIR=$REPO_ROOT/backend
GO_SRC=$BACKEND_DIR/backend
FE_SRC=$BACKEND_DIR/frontend
WORK_DIR=${CLAUDEX_BACKEND_WORK:-$REPO_ROOT/work/backend}
LOG_DIR=$WORK_DIR/logs
OUT_DIR=$WORK_DIR/out
mkdir -p "$LOG_DIR" "$OUT_DIR"

GO_IMAGE=${GO_IMAGE:-golang:1.27.0-alpine}
NODE_IMAGE=${NODE_IMAGE:-node:24-alpine}
ALPINE_IMAGE=${ALPINE_IMAGE:-alpine:3.21}
PNPM_SPEC=${PNPM_SPEC:-pnpm@9.15.9}
CPUS=${CPUS:-3}
MEM=${MEM:-4g}
RETRIES=${RETRIES:-8}
# Memory: compiling internal/service with its tests needs more than 4 GB with
# the defaults. Fewer parallel compiles (-p), a lower GC target and a soft
# memory limit for the toolchain, and -c=1 for that package (go.sh vet/test)
# keep it under MEM.
GO_PARALLEL=${GO_PARALLEL:-2}
GO_GOGC=${GO_GOGC:-50}
GO_MEMLIMIT=${GO_MEMLIMIT:-3400MiB}
GO_HEAVY_GCFLAGS=${GO_HEAVY_GCFLAGS:--gcflags=github.com/Wei-Shaw/sub2api/internal/service=-c=1}
GOPROXY_PRIMARY=${GOPROXY_PRIMARY:-https://proxy.golang.org,https://goproxy.cn,direct}
# With "," Go falls through only on 404/410, not on dropped connections, so
# even-numbered attempts swap the order to really use the second proxy.
GOPROXY_ALT=${GOPROXY_ALT:-https://goproxy.cn,https://proxy.golang.org,direct}
FE_OFFICIAL_REGISTRY=https://registry.npmjs.org/
FE_NPM_MIRROR=${FE_NPM_MIRROR:-https://registry.npmmirror.com/}
FE_OFFICIAL_ATTEMPTS=${FE_OFFICIAL_ATTEMPTS:-2}

# Cache volumes: downloads survive dropped connections and later runs are
# offline-fast. The Go and pnpm caches are safe to share between builds.
GO_MODCACHE_VOLUME=${GO_MODCACHE_VOLUME:-sub2api-go-modcache}      # /go/pkg/mod
GO_BUILDCACHE_VOLUME=${GO_BUILDCACHE_VOLUME:-sub2api-go-buildcache}  # /root/.cache/go-build
GO_BIN_VOLUME=${GO_BIN_VOLUME:-claudex-backend-go-bin}             # /go/bin (wire)
FE_STORE_VOLUME=${FE_STORE_VOLUME:-sub2api-fe-pnpm-store}          # pnpm content-addressable store
FE_COREPACK_VOLUME=${FE_COREPACK_VOLUME:-sub2api-fe-corepack}      # corepack's pnpm download

# Build containers are named <step>-<suffix>; the suffix is per checkout so
# parallel worktrees never `docker rm -f` each other's running containers.
CONTAINER_SUFFIX=${CONTAINER_SUFFIX:-$(printf '%s' "$REPO_ROOT" | cksum | cut -d' ' -f1)}
# node_modules is per checkout too: worktrees may carry different lockfiles,
# and a concurrent `pnpm install` into a shared volume would clobber it. The
# pnpm store above stays shared, so a fresh install is mostly linking.
FE_NODE_MODULES_VOLUME=${FE_NODE_MODULES_VOLUME:-claudex-backend-fe-node-modules-$CONTAINER_SUFFIX}

log() { printf '[backend %s] %s\n' "$(date '+%F %T')" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

# retry <max> <pause-seconds> <cmd...>
retry() {
  local max=$1 pause=$2 n=1 rc
  shift 2
  until "$@"; do
    rc=$?
    if [ "$n" -ge "$max" ]; then log "giving up after $n attempts (rc=$rc): $*"; return "$rc"; fi
    log "attempt $n failed (rc=$rc), retrying in ${pause}s: $*"
    n=$((n + 1))
    sleep "$pause"
  done
}

# with_timeout <seconds> <cmd...>: macOS has no coreutils timeout.
with_timeout() { local t=$1; shift; perl -e 'alarm shift; exec @ARGV or die "exec: $!"' "$t" "$@"; }

# ensure_image <ref>: pull with retries when missing. Docker keeps finished
# layers between attempts. When `docker pull` keeps failing, fetch-image.sh
# downloads the blobs with resumable curl and loads them instead.
ensure_image() {
  local ref=$1
  docker image inspect "$ref" >/dev/null 2>&1 && return 0
  log "pulling $ref"
  if retry "${PULL_RETRIES:-6}" 15 with_timeout "${PULL_TIMEOUT:-600}" docker pull -q "$ref"; then return 0; fi
  docker image inspect "$ref" >/dev/null 2>&1 && return 0
  local repo=${ref%%:*} tag=${ref#*:}
  case "$repo" in */*) ;; *) repo=library/$repo ;; esac
  log "docker pull failed; resumable fetch of $repo:$tag"
  "$REPO_ROOT/scripts/backend/fetch-image.sh" "$repo" "$tag"
}

ensure_volume() { local v; for v in "$@"; do docker volume inspect "$v" >/dev/null 2>&1 || docker volume create "$v" >/dev/null; done; }

host_arch() { case "$(uname -m)" in arm64|aarch64) echo arm64 ;; x86_64|amd64) echo amd64 ;; *) uname -m ;; esac; }

# go_run <container-name> [docker-args...] -- <shell script>
# Runs the script in $GO_IMAGE with backend/backend at /src (read-write) and
# $OUT_DIR at /out. Pass --network none for steps that must stay offline.
go_run() {
  local name=$1-$CONTAINER_SUFFIX; shift
  local extra=()
  while [ $# -gt 0 ] && [ "$1" != "--" ]; do extra+=("$1"); shift; done
  shift
  ensure_volume "$GO_MODCACHE_VOLUME" "$GO_BUILDCACHE_VOLUME" "$GO_BIN_VOLUME"
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run --rm --name "$name" --cpus "$CPUS" --memory "$MEM" \
    -v "$GO_SRC":/src -w /src \
    -v "$OUT_DIR":/out \
    -v "$GO_MODCACHE_VOLUME":/go/pkg/mod \
    -v "$GO_BUILDCACHE_VOLUME":/root/.cache/go-build \
    -v "$GO_BIN_VOLUME":/go/bin \
    -e GOTOOLCHAIN=local -e GOPROXY="${GOPROXY:-$GOPROXY_PRIMARY}" \
    -e GOFLAGS="-buildvcs=false -p=$GO_PARALLEL" -e CGO_ENABLED=0 \
    -e GOGC="$GO_GOGC" -e GOMEMLIMIT="$GO_MEMLIMIT" \
    ${extra[@]+"${extra[@]}"} \
    "$GO_IMAGE" sh -ec "$*"
}

# fe_run <container-name> <shell script>: runs in $NODE_IMAGE with backend/ at
# /app (so vite's outDir ../backend/internal/web/dist/admin and the ?raw imports of
# ../../docs/legal resolve as upstream expects) and node_modules in a volume.
fe_run() {
  local name=$1-$CONTAINER_SUFFIX script=$2
  ensure_volume "$FE_STORE_VOLUME" "$FE_COREPACK_VOLUME" "$FE_NODE_MODULES_VOLUME"
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run --rm --name "$name" --cpus "$CPUS" --memory "$MEM" \
    -v "$BACKEND_DIR":/app \
    -v "$FE_NODE_MODULES_VOLUME":/app/frontend/node_modules \
    -v "$FE_STORE_VOLUME":/pnpm-store \
    -v "$FE_COREPACK_VOLUME":/corepack \
    -v "$WORK_DIR":/work \
    -e COREPACK_HOME=/corepack -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    -e npm_config_store_dir=/pnpm-store \
    -e npm_config_fetch_retries=6 -e npm_config_fetch_retry_mintimeout=10000 \
    -e npm_config_fetch_retry_maxtimeout=120000 -e npm_config_fetch_timeout=300000 \
    -e npm_config_registry="${FE_REGISTRY:-${FE_NPM_REGISTRY:-$FE_OFFICIAL_REGISTRY}}" \
    -e COREPACK_NPM_REGISTRY="$(r=${FE_REGISTRY:-${FE_NPM_REGISTRY:-$FE_OFFICIAL_REGISTRY}}; echo "${r%/}")" \
    -e CI=true -e NODE_OPTIONS="${FE_NODE_OPTIONS:---max-old-space-size=3072}" \
    -e PNPM_SPEC="$PNPM_SPEC" \
    -w /app/frontend \
    "$NODE_IMAGE" sh -ec "
      corepack enable
      i=1; until corepack prepare \"\$PNPM_SPEC\" --activate >/tmp/corepack.log 2>&1; do
        cat /tmp/corepack.log; [ \$i -ge 8 ] && exit 97; i=\$((i+1)); sleep 10; done
      $script"
}

# timed <step> <cmd...>: runs cmd, tees output to $LOG_DIR/<step>.log and
# appends "<time> <step> rc=<rc> <seconds>s" to $LOG_DIR/steps.tsv.
timed() {
  local step=$1; shift
  local logf="$LOG_DIR/$step.log" t0 rc
  t0=$(date +%s)
  log "BEGIN $step (log: $logf)"
  "$@" 2>&1 | tee "$logf"
  rc=${PIPESTATUS[0]}
  printf '%s\t%s\trc=%s\t%ss\n' "$(date '+%F %T')" "$step" "$rc" "$(( $(date +%s) - t0 ))" | tee -a "$LOG_DIR/steps.tsv" >&2
  return "$rc"
}
