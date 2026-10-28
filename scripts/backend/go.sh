#!/usr/bin/env bash
# Go side of the Sub2API fork (backend/backend) in golang:1.27.0-alpine.
#
# Usage: scripts/backend/go.sh <step> [args...] [<step> [args...]]...
#   download            go mod download with retries (the only step that needs the network,
#                       apart from `wire` the first time)
#   build               go build ./... and the server binary without the embedded UI
#                       -> work/backend/out/sub2api-noembed
#   build-embed         server binary with the embedded admin console (needs a frontend build,
#                       see fe.sh build) -> work/backend/out/sub2api
#   vet [pkgs...]       go vet (default ./...), with and without -tags=unit
#   vet-integration [pkgs...]
#                       go vet -tags=integration (default the Claudex packages): compiles the
#                       testcontainers tests without starting any container
#   test [pkgs...]      go test -tags=unit -count=1 (default ./...); the tag also runs the
#                       untagged tests, like upstream's `make test-unit`
#   wire                regenerate cmd/server/wire_gen.go (installs wire v0.7.0 into a volume)
#   wire-check          fail when cmd/server/wire_gen.go is out of date, or go.mod / go.sum
#                       differ from git HEAD (wire must never touch them)
#   lint [pkgs...]      golangci-lint (v2.13.x, like upstream CI) with backend/backend/.golangci.yml
#                       (default ./...); installs it into the tool volume the first time (network)
#   test-integration [pkgs...]
#                       go test -tags=integration via testcontainers (PostgreSQL, Redis) with the
#                       host Docker socket (default: the Claudex packages plus upstream's
#                       repository, middleware and server/routes). Each run has an id
#                       (IT_RUN_ID, passed in as CLAUDEX_IT_RUN_ID): the Claudex tests label their
#                       containers claudex.it.run=<id> (internal/claudex/core/testsupport), and
#                       only those are removed afterwards, so concurrent runs in other checkouts
#                       keep theirs. Unlabelled testcontainers that appear during the run
#                       (upstream packages' own tests) are capped but never removed; leftovers
#                       are listed at the end for the runner to check (Ryuk is disabled).
# Steps run offline (--network none) except download, wire/lint installs and test-integration.
# Example: scripts/backend/go.sh download build vet ./internal/claudex/... test ./internal/claudex/...
set -uo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

WIRE_VERSION=${WIRE_VERSION:-v0.7.0}
GOLANGCI_LINT_VERSION=${GOLANGCI_LINT_VERSION:-v2.13.2}
IT_IMAGE=${IT_IMAGE:-claudex-backend-go-it:1.27.0}
IT_PG_IMAGE=${IT_PG_IMAGE:-postgres:18-alpine}
IT_REDIS_IMAGE=${IT_REDIS_IMAGE:-redis:8.4-alpine}
IT_DEFAULT_PKGS=${IT_DEFAULT_PKGS:-./internal/claudex/... ./internal/repository/... ./internal/middleware/... ./internal/server/...}
IT_RUN_ID=${IT_RUN_ID:-it-$(date +%s)-$$-$RANDOM}
TC_CPUS=${TC_CPUS:-1}
TC_MEM=${TC_MEM:-1g}

_dl_attempt=0
_download_once() {
  _dl_attempt=$((_dl_attempt + 1))
  local proxy=$GOPROXY_PRIMARY
  [ $((_dl_attempt % 2)) -eq 0 ] && proxy=$GOPROXY_ALT
  log "go mod download attempt $_dl_attempt (GOPROXY=$proxy)"
  # go mod download fetches at most GOMAXPROCS modules at a time; downloads are
  # I/O bound, so raise it. timeout kills an attempt stuck on a dead connection.
  GOPROXY=$proxy go_run claudex-go-download -e GOMAXPROCS=16 -- \
    'timeout 1200 go mod download && go mod verify | tail -1'
}
step_download() { retry "$RETRIES" 20 _download_once; }

step_build() {
  go_run claudex-go-build --network none -- '
    go version
    go build ./...
    V=$(sh scripts/resolve-version.sh)
    go build -trimpath -ldflags="-s -w -X main.Version=$V -X main.BuildType=source" -o /out/sub2api-noembed ./cmd/server
    ls -l /out/sub2api-noembed'
}

step_build_embed() {
  # W-SITE: the console is embedded from dist/admin (the web app, when built,
  # from dist/app).
  [ -f "$GO_SRC/internal/web/dist/admin/index.html" ] || die "no console build in backend/backend/internal/web/dist/admin; run scripts/backend/fe.sh build first"
  local commit
  commit=$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)
  go_run claudex-go-build-embed --network none -- "
    V=\$(sh scripts/resolve-version.sh)
    D=\$(date -u +%Y-%m-%dT%H:%M:%SZ)
    # timetzdata: the binary also runs on a bare alpine image without tzdata.
    go build -tags embed,timetzdata -trimpath \
      -ldflags=\"-s -w -X main.Version=\$V -X main.Commit=$commit -X main.Date=\$D -X main.BuildType=source\" \
      -o /out/sub2api.new ./cmd/server
    mv /out/sub2api.new /out/sub2api
    /out/sub2api --version || true
    ls -l /out/sub2api"
}

step_vet() {
  local pkgs=("$@"); [ ${#pkgs[@]} -gt 0 ] || pkgs=(./...)
  go_run claudex-go-vet --network none -- "go vet $GO_HEAVY_GCFLAGS ${pkgs[*]} && go vet $GO_HEAVY_GCFLAGS -tags=unit ${pkgs[*]}"
}

step_test() {
  local pkgs=("$@"); [ ${#pkgs[@]} -gt 0 ] || pkgs=(./...)
  go_run claudex-go-test --network none -- "go test $GO_HEAVY_GCFLAGS -tags=unit -count=1 ${TEST_FLAGS:-} ${pkgs[*]}"
}

_wire_install() {
  go_run claudex-go-wire-install -- "
    [ -x /go/bin/wire ] && exit 0
    cd /tmp && GOFLAGS=-mod=mod go install github.com/google/wire/cmd/wire@$WIRE_VERSION"
}
step_wire() {
  retry "$RETRIES" 20 _wire_install || return 1
  # No "|| true" here: a failed `wire gen` must fail the step, or a stale
  # wire_gen.go would silently leave new Deps fields nil at runtime.
  go_run claudex-go-wire --network none -- 'cd cmd/server && /go/bin/wire gen . && gofmt -l .'
}
step_wire_check() {
  retry "$RETRIES" 20 _wire_install || return 1
  go_run claudex-go-wire-check --network none -- 'cd cmd/server && /go/bin/wire diff . && echo "wire_gen.go is up to date"' || return 1
  # wire is installed outside the module, so go.mod and go.sum must never change.
  if ! git -C "$REPO_ROOT" diff --quiet HEAD -- backend/backend/go.mod backend/backend/go.sum; then
    log "go.mod or go.sum differ from HEAD"; git -C "$REPO_ROOT" diff --stat HEAD -- backend/backend/go.mod backend/backend/go.sum; return 1
  fi
  echo "go.mod and go.sum are unchanged"
}

step_vet_integration() {
  local pkgs=("$@"); [ ${#pkgs[@]} -gt 0 ] || pkgs=(./internal/claudex/...)
  go_run claudex-go-vet-integration --network none -- "go vet $GO_HEAVY_GCFLAGS -tags=integration ${pkgs[*]}"
}

_lint_install() {
  go_run claudex-go-lint-install -- "
    [ -x /go/bin/golangci-lint ] && /go/bin/golangci-lint version 2>/dev/null | grep -q '${GOLANGCI_LINT_VERSION#v}' && exit 0
    cd /tmp && GOFLAGS=-mod=mod go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@$GOLANGCI_LINT_VERSION
    /go/bin/golangci-lint version"
}
step_lint() {
  local pkgs=("$@"); [ ${#pkgs[@]} -gt 0 ] || pkgs=(./...)
  retry "$RETRIES" 20 _lint_install || return 1
  go_run claudex-go-lint --network none -e GOLANGCI_LINT_CACHE=/root/.cache/go-build/golangci-lint -- \
    "/go/bin/golangci-lint run --timeout=30m ${pkgs[*]}"
}

_it_image() {
  docker image inspect "$IT_IMAGE" >/dev/null 2>&1 && return 0
  # Same recipe as the baseline harness image: reuse it when present (offline).
  if docker image inspect sub2api-baseline-go-it:1.27.0 >/dev/null 2>&1; then
    docker tag sub2api-baseline-go-it:1.27.0 "$IT_IMAGE" && return 0
  fi
  ensure_image "$GO_IMAGE" || return 1
  local ctx="$WORK_DIR/it-image"; mkdir -p "$ctx"
  printf 'FROM %s\nRUN apk add --no-cache docker-cli && docker --version\n' "$GO_IMAGE" > "$ctx/Dockerfile"
  retry "$RETRIES" 15 docker build --pull=false -t "$IT_IMAGE" "$ctx"
}
# _tc_cap <id> <list>: caps a container once and records it in the list.
_tc_cap() {
  grep -q "^$1 " "$2" 2>/dev/null && return 0
  if docker update --cpus "$TC_CPUS" --memory "$TC_MEM" --memory-swap "$TC_MEM" "$1" >/dev/null 2>&1; then
    echo "$1 $(docker inspect -f '{{.Config.Image}}' "$1" 2>/dev/null)" >> "$2"
  fi
}
# While $1 exists: caps the containers labelled for this run (listed in $2)
# and the unlabelled testcontainers that were not there at the start (listed
# in $3; $4 holds the ids present at the start). Containers labelled for
# another run are never touched.
_tc_watch() {
  local flag=$1 ours=$2 foreign=$3 before=$4 id label
  : > "$ours"; : > "$foreign"
  while [ -f "$flag" ]; do
    for id in $(docker ps -q --filter label=org.testcontainers=true --filter "label=claudex.it.run=$IT_RUN_ID" 2>/dev/null); do
      _tc_cap "$id" "$ours"
    done
    docker ps --filter label=org.testcontainers=true --format '{{.ID}} {{.Label "claudex.it.run"}}' 2>/dev/null |
      while read -r id label; do
        [ -z "$label" ] || continue
        grep -qx "$id" "$before" 2>/dev/null && continue
        _tc_cap "$id" "$foreign"
      done
    sleep 1
  done
}
step_test_integration() {
  local pkgs=("$@"); [ ${#pkgs[@]} -gt 0 ] || read -r -a pkgs <<< "$IT_DEFAULT_PKGS"
  _it_image || return 1
  ensure_image "$IT_PG_IMAGE" || return 1
  ensure_image "$IT_REDIS_IMAGE" || return 1
  local flag="$LOG_DIR/.it-running-$IT_RUN_ID" ours="$LOG_DIR/it-containers-$IT_RUN_ID.txt"
  local foreign="$LOG_DIR/it-unlabelled-$IT_RUN_ID.txt" before="$LOG_DIR/it-before-$IT_RUN_ID.txt" rc wpid left
  docker ps -q --filter label=org.testcontainers=true > "$before" 2>/dev/null || : > "$before"
  log "integration run $IT_RUN_ID"
  touch "$flag"; _tc_watch "$flag" "$ours" "$foreign" "$before" & wpid=$!
  GO_IMAGE=$IT_IMAGE go_run claudex-go-test-integration \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -e CI=true -e TESTCONTAINERS_RYUK_DISABLED=true \
    -e CLAUDEX_IT_RUN_ID="$IT_RUN_ID" \
    -e SUB2API_TEST_POSTGRES_IMAGE="$IT_PG_IMAGE" \
    -e CLAUDEX_TEST_REDIS_IMAGE="$IT_REDIS_IMAGE" \
    ${TESTCONTAINERS_HOST_OVERRIDE:+-e TESTCONTAINERS_HOST_OVERRIDE="$TESTCONTAINERS_HOST_OVERRIDE"} \
    -- "go test $GO_HEAVY_GCFLAGS -tags=integration -count=1 ${TEST_FLAGS:-} ${pkgs[*]}"
  rc=$?
  rm -f "$flag"; wait "$wpid" 2>/dev/null
  # Ryuk is disabled: remove what this run labelled, including containers the
  # watcher never saw running.
  left=$(docker ps -aq --filter "label=claudex.it.run=$IT_RUN_ID" 2>/dev/null)
  [ -n "$left" ] && { log "removing this run's test containers: $(echo $left)"; docker rm -f $left >/dev/null; }
  left=$(awk '{print $1}' "$foreign" 2>/dev/null | while read -r id; do docker ps -aq --filter id="$id"; done)
  [ -n "$left" ] && log "unlabelled testcontainers still present (not removed; check whether this run started them): $(echo $left)"
  rm -f "$ours" "$foreign" "$before"
  return $rc
}

ensure_image "$GO_IMAGE" || die "cannot get $GO_IMAGE"
[ $# -gt 0 ] || { sed -n '2,33p' "$0"; exit 2; }
rc_all=0
while [ $# -gt 0 ]; do
  step=$1; shift
  args=()
  while [ $# -gt 0 ] && ! declare -F "step_${1//-/_}" >/dev/null; do args+=("$1"); shift; done
  fn="step_${step//-/_}"
  declare -F "$fn" >/dev/null || die "unknown step: $step"
  timed "go-$step" "$fn" ${args[@]+"${args[@]}"} || { rc_all=1; [ "$step" = download ] && exit 1; }
done
exit $rc_all
