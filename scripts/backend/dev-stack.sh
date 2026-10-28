#!/usr/bin/env bash
# Local development stack for the Sub2API fork, all in Docker:
#   $DEV_NAME-postgres  postgres:18-alpine
#   $DEV_NAME-redis     redis:8-alpine (falls back to a local redis:8.4-alpine)
#   $DEV_NAME-mock      mock OpenAI-compatible upstream (scripts/backend/mock-upstream),
#                       synthetic answers only, never a real provider
#   $DEV_NAME-server    the fork (work/backend/out/sub2api from build.sh) on alpine:3.21
#
# Usage: scripts/backend/dev-stack.sh up | down [-v] | status | logs <name> | smoke
#   up      builds the fork when work/backend/out/sub2api is missing (BUILD=1 forces it),
#           builds the mock, starts everything and waits for /health
#   down    stops and removes the containers; -v also deletes the database and data volumes
#   smoke   read-only checks: health, public Claudex routes (release, client-header
#           validation), admin login, capabilities, that the admin Claudex route answers
#           423 until the compliance commitment is accepted, and that the gateway chain
#           (Claudex hooks included) still rejects a bad API key
#
# DEV_SERVER_ENV_FILE: a docker --env-file with more variables for the server
# (e.g. the IQ check's CLAUDEX_STATUS_IQ_* on a test stack).
# Ports (127.0.0.1 only): server DEV_PORT (18080), mock DEV_MOCK_PORT (18090).
# DEV_NAME (default claudex-dev-<checkout id>) prefixes the container, volume and network
# names; to run two stacks at once give the second one other ports (DEV_PORT=18081
# DEV_MOCK_PORT=18091).
# Development secrets (admin password, JWT and TOTP keys) are generated once into
# work/backend/dev-stack/dev.env (mode 600). The admin compliance commitment is
# never accepted by this script: accept it yourself in the console if you need
# the admin pages.
set -uo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

# Prefix of the container, volume and network names. It is per checkout by default:
# work/backend/dev-stack/dev.env (and so the database password) is per checkout too,
# and a database volume created by another worktree would reject this one's password.
DEV=${DEV_NAME:-claudex-dev-$CONTAINER_SUFFIX}
NET=${DEV}-net
PG_IMAGE=${PG_IMAGE:-postgres:18-alpine}
DEV_PORT=${DEV_PORT:-18080}
DEV_MOCK_PORT=${DEV_MOCK_PORT:-18090}
STACK_DIR=$WORK_DIR/dev-stack
ENV_FILE=$STACK_DIR/dev.env
SERVER_BIN=$OUT_DIR/sub2api
MOCK_BIN=$OUT_DIR/mock-upstream
CONTAINERS=(${DEV}-server ${DEV}-mock ${DEV}-redis ${DEV}-postgres)
VOLUMES=(${DEV}-pgdata ${DEV}-redisdata ${DEV}-data)
mkdir -p "$STACK_DIR"

ensure_env() {
  [ -s "$ENV_FILE" ] && return 0
  umask 077
  cat > "$ENV_FILE" <<EOF
# Development-only secrets for scripts/backend/dev-stack.sh (never use in production).
POSTGRES_PASSWORD=$(openssl rand -hex 16)
ADMIN_EMAIL=admin@claudex.local
ADMIN_PASSWORD=$(openssl rand -hex 12)
JWT_SECRET=$(openssl rand -hex 32)
TOTP_ENCRYPTION_KEY=$(openssl rand -hex 32)
MOCK_API_KEY=sk-mock-$(openssl rand -hex 8)
EOF
  log "generated development secrets in $ENV_FILE"
}
env_value() { sed -n "s/^$1=//p" "$ENV_FILE" | head -1; }

pick_redis_image() {
  if [ -n "${REDIS_IMAGE:-}" ]; then echo "$REDIS_IMAGE"; return; fi
  local img
  for img in redis:8-alpine redis:8.4-alpine; do
    docker image inspect "$img" >/dev/null 2>&1 && { echo "$img"; return; }
  done
  echo redis:8-alpine
}

build_mock() {
  if [ -x "$MOCK_BIN" ] && [ -z "$(find "$REPO_ROOT/scripts/backend/mock-upstream" -newer "$MOCK_BIN" -type f -print -quit)" ]; then return 0; fi
  ensure_image "$GO_IMAGE" || return 1
  docker run --rm --network none --cpus "$CPUS" --memory "$MEM" \
    -v "$REPO_ROOT/scripts/backend/mock-upstream":/src:ro -w /src -v "$OUT_DIR":/out \
    -v "$GO_BUILDCACHE_VOLUME":/root/.cache/go-build \
    -e CGO_ENABLED=0 -e GOTOOLCHAIN=local -e GOFLAGS=-buildvcs=false \
    "$GO_IMAGE" go build -trimpath -o /out/mock-upstream .
}

wait_http() {  # wait_http <url> <seconds>
  local i
  for i in $(seq 1 "$2"); do
    curl -fs -o /dev/null --max-time 3 "$1" && return 0
    sleep 1
  done
  return 1
}

cmd_up() {
  ensure_env
  if [ "${BUILD:-0}" = 1 ] || [ ! -x "$SERVER_BIN" ]; then
    "$REPO_ROOT/scripts/backend/build.sh" || die "build failed"
  fi
  build_mock || die "mock upstream build failed"
  local redis_image; redis_image=$(pick_redis_image)
  for img in "$PG_IMAGE" "$redis_image" "$ALPINE_IMAGE"; do ensure_image "$img" || die "cannot get $img"; done
  docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null
  ensure_volume "${VOLUMES[@]}"

  local pg_password; pg_password=$(env_value POSTGRES_PASSWORD)
  if ! docker container inspect ${DEV}-postgres >/dev/null 2>&1; then
    docker run -d --name ${DEV}-postgres --network "$NET" --memory 1g \
      -e POSTGRES_USER=sub2api -e POSTGRES_PASSWORD="$pg_password" -e POSTGRES_DB=sub2api \
      -e PGDATA=/var/lib/postgresql/data \
      -v ${DEV}-pgdata:/var/lib/postgresql/data "$PG_IMAGE" >/dev/null || die "postgres failed to start"
  fi
  docker start ${DEV}-postgres >/dev/null
  if ! docker container inspect ${DEV}-redis >/dev/null 2>&1; then
    docker run -d --name ${DEV}-redis --network "$NET" --memory 512m \
      -v ${DEV}-redisdata:/data "$redis_image" redis-server --appendonly yes >/dev/null || die "redis failed to start"
  fi
  docker start ${DEV}-redis >/dev/null
  docker rm -f ${DEV}-mock >/dev/null 2>&1 || true
  docker run -d --name ${DEV}-mock --network "$NET" --memory 256m \
    -p "127.0.0.1:$DEV_MOCK_PORT:8090" \
    -v "$MOCK_BIN":/usr/local/bin/mock-upstream:ro \
    -v "$GO_SRC/resources/model-pricing":/data:ro \
    -e PORT=8090 -e MOCK_API_KEY="$(env_value MOCK_API_KEY)" \
    "$ALPINE_IMAGE" /usr/local/bin/mock-upstream >/dev/null || die "mock upstream failed to start"

  local i
  for i in $(seq 1 60); do
    docker exec ${DEV}-postgres pg_isready -U sub2api -d sub2api >/dev/null 2>&1 && break
    [ "$i" = 60 ] && die "postgres not ready"
    sleep 1
  done

  # The server is recreated on every `up` so a new build is picked up; its data
  # (config.yaml written by AUTO_SETUP) stays in the ${DEV}-data volume.
  docker rm -f ${DEV}-server >/dev/null 2>&1 || true
  docker run -d --name ${DEV}-server --network "$NET" --memory 1g \
    -p "127.0.0.1:$DEV_PORT:8080" \
    -v "$SERVER_BIN":/app/sub2api:ro \
    -v "$GO_SRC/resources":/app/resources:ro \
    -v ${DEV}-data:/app/data \
    -w /app \
    -e AUTO_SETUP=true -e DATA_DIR=/app/data \
    -e SERVER_HOST=0.0.0.0 -e SERVER_PORT=8080 -e SERVER_MODE=release -e RUN_MODE=standard \
    -e DATABASE_HOST=${DEV}-postgres -e DATABASE_PORT=5432 \
    -e DATABASE_USER=sub2api -e DATABASE_PASSWORD="$pg_password" -e DATABASE_DBNAME=sub2api \
    -e DATABASE_SSLMODE=disable \
    -e REDIS_HOST=${DEV}-redis -e REDIS_PORT=6379 \
    -e ADMIN_EMAIL="$(env_value ADMIN_EMAIL)" -e ADMIN_PASSWORD="$(env_value ADMIN_PASSWORD)" \
    -e JWT_SECRET="$(env_value JWT_SECRET)" -e TOTP_ENCRYPTION_KEY="$(env_value TOTP_ENCRYPTION_KEY)" \
    -e TZ=UTC \
    ${DEV_SERVER_ENV_FILE:+--env-file "$DEV_SERVER_ENV_FILE"} \
    -e PRICING_REMOTE_URL=http://${DEV}-mock:8090/pricing/model_prices_and_context_window.json \
    -e PRICING_HASH_URL=http://${DEV}-mock:8090/pricing/model_prices_and_context_window.sha256 \
    "$ALPINE_IMAGE" /app/sub2api >/dev/null || die "server failed to start"

  if ! wait_http "http://127.0.0.1:$DEV_PORT/health" 180; then
    docker logs --tail 80 ${DEV}-server >&2
    die "server did not become healthy"
  fi
  wait_http "http://127.0.0.1:$DEV_MOCK_PORT/health" 30 || die "mock upstream did not become healthy"
  cmd_status
}

cmd_down() {
  docker rm -f "${CONTAINERS[@]}" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  if [ "${1:-}" = -v ]; then
    docker volume rm "${VOLUMES[@]}" >/dev/null 2>&1 || true
    rm -f "$ENV_FILE"
    log "removed containers, volumes and development secrets"
  else
    log "removed containers (volumes kept; use down -v to delete data)"
  fi
}

cmd_status() {
  docker ps -a --filter name=${DEV}- --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
  if [ -s "$ENV_FILE" ]; then
    echo
    echo "Console:  http://127.0.0.1:$DEV_PORT  (admin $(env_value ADMIN_EMAIL); password in $ENV_FILE)"
    echo "Mock:     http://127.0.0.1:$DEV_MOCK_PORT/v1  (API key MOCK_API_KEY in $ENV_FILE)"
    echo "          from the server container: http://${DEV}-mock:8090/v1"
  fi
}

cmd_logs() { docker logs --tail "${TAIL:-200}" "${1:-${DEV}-server}"; }

# expect <label> <want-status> <curl args...>
expect() {
  local label=$1 want=$2 got; shift 2
  got=$(curl -sS -o "$STACK_DIR/smoke.body" -w '%{http_code}' --max-time 10 "$@")
  if [ "$got" = "$want" ]; then echo "ok    $label ($got)"; return 0; fi
  echo "FAIL  $label: want $want, got $got: $(head -c 300 "$STACK_DIR/smoke.body")"; return 1
}

cmd_smoke() {
  [ -s "$ENV_FILE" ] || die "stack not set up; run: $0 up"
  local base="http://127.0.0.1:$DEV_PORT" rc=0 token
  expect "GET /health" 200 "$base/health" || rc=1
  expect "GET /api/v1/claudex/release (public)" 200 -H 'X-Claudex-Platform: darwin' -H 'X-Claudex-Version: 1.0.0' "$base/api/v1/claudex/release" || rc=1
  grep -q '"api_version":1' "$STACK_DIR/smoke.body" || { echo "FAIL  release body: $(cat "$STACK_DIR/smoke.body")"; rc=1; }
  grep -q '"state":"' "$STACK_DIR/smoke.body" || { echo "FAIL  release has no state (release peer not merged): $(cat "$STACK_DIR/smoke.body")"; rc=1; }
  expect "GET /api/v1/claudex/release with a bad client header" 400 -H 'X-Claudex-Platform: beos' "$base/api/v1/claudex/release" || rc=1
  grep -q 'CLAUDEX_INVALID_CLIENT_HEADER' "$STACK_DIR/smoke.body" || { echo "FAIL  bad header body: $(cat "$STACK_DIR/smoke.body")"; rc=1; }
  expect "GET /api/v1/claudex/capabilities without token" 401 "$base/api/v1/claudex/capabilities" || rc=1
  expect "POST /v1/messages with a bad API key (gateway chain)" 401 -H 'Authorization: Bearer sk-claudex-smoke-invalid' \
    -H 'Content-Type: application/json' -d '{"model":"gpt-5","messages":[]}' "$base/v1/messages" || rc=1
  expect "GET /v1/audio/realtime/transcriptions without a key (dictation route registered)" 401 "$base/v1/audio/realtime/transcriptions" || rc=1
  expect "POST /api/v1/auth/login (admin)" 200 -H 'Content-Type: application/json' \
    -d "{\"email\":\"$(env_value ADMIN_EMAIL)\",\"password\":\"$(env_value ADMIN_PASSWORD)\"}" "$base/api/v1/auth/login" || rc=1
  token=$(sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p' "$STACK_DIR/smoke.body")
  if [ -n "$token" ]; then
    expect "GET /api/v1/claudex/capabilities (admin token)" 200 -H "Authorization: Bearer $token" "$base/api/v1/claudex/capabilities" || rc=1
    grep -q '"devices"' "$STACK_DIR/smoke.body" || { echo "FAIL  capabilities lacks the components: $(cat "$STACK_DIR/smoke.body")"; rc=1; }
    # 423 until the owner accepts the compliance commitment in the console; 200 afterwards.
    expect "GET /api/v1/admin/claudex/overview (compliance gate)" "${EXPECT_OVERVIEW:-423}" -H "Authorization: Bearer $token" "$base/api/v1/admin/claudex/overview" || rc=1
  else
    echo "FAIL  no access_token in the login answer"; rc=1
  fi
  expect "mock upstream /v1/models" 200 -H "Authorization: Bearer $(env_value MOCK_API_KEY)" "http://127.0.0.1:$DEV_MOCK_PORT/v1/models" || rc=1
  return $rc
}

case "${1:-}" in
  up) cmd_up ;;
  down) shift; cmd_down "$@" ;;
  status) cmd_status ;;
  logs) shift; cmd_logs "$@" ;;
  smoke) cmd_smoke ;;
  *) sed -n '2,20p' "$0"; exit 2 ;;
esac
