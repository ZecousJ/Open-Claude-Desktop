#!/usr/bin/env bash
# Checks a running Claudex server without changing anything.
#
#   deploy/claudex-server/check.sh [BASE_URL]   (default http://127.0.0.1:8080)
#   deploy/claudex-server/check.sh --dev        (docker-compose.dev.yml stack)
#
# Always: /health, the public settings (reads the database), the public
# GET /api/v1/claudex/release, and that /api/v1/claudex/capabilities needs a
# sign-in. With ADMIN_EMAIL and ADMIN_PASSWORD in the environment (--dev reads
# the one-time password from the server log), it also signs in and reports the
# compliance state: every /api/v1/admin/claudex/* route answers 423 until the
# owner accepts the commitment in the console, 200 afterwards. This script
# never accepts the commitment. Exit code 1 when a check fails.
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd -P)
BASE=""
DEV=0
for arg in "$@"; do
  case "$arg" in
    --dev) DEV=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    -*) echo "Unknown option $arg" >&2; exit 2 ;;
    *) BASE=$arg ;;
  esac
done
if [ "$DEV" = 1 ]; then
  BASE=${BASE:-http://127.0.0.1:${CLAUDEX_DEV_PORT:-8080}}
  ADMIN_EMAIL=${ADMIN_EMAIL:-${CLAUDEX_DEV_ADMIN_EMAIL:-admin@claudex.local}}
  if [ -z "${ADMIN_PASSWORD:-}" ]; then
    ADMIN_PASSWORD=${CLAUDEX_DEV_ADMIN_PASSWORD:-}
  fi
  if [ -z "${ADMIN_PASSWORD:-}" ]; then
    ADMIN_PASSWORD=$(docker compose -f "$HERE/docker-compose.dev.yml" logs --no-color claudex-server 2>/dev/null |
      sed -n 's/.*Generated admin password (one-time): *\([^[:space:]]*\).*/\1/p' | tail -n 1)
  fi
fi
BASE=${BASE:-http://127.0.0.1:8080}
BASE=${BASE%/}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
rc=0
# get <label> <want-status> <path> [curl args...]: body in $tmp/body
get() {
  local label=$1 want=$2 path=$3 got
  shift 3
  got=$(curl -sS -o "$tmp/body" -w '%{http_code}' -m 15 "$@" "$BASE$path" 2>"$tmp/err") || got="000 $(head -c 200 "$tmp/err")"
  if [ "$got" = "$want" ]; then
    echo "ok    $label ($got)"
    return 0
  fi
  echo "FAIL  $label: want $want, got $got: $(head -c 300 "$tmp/body" 2>/dev/null)"
  rc=1
  return 1
}
field() { sed -n "s/.*\"$1\":\([^,}]*\).*/\1/p" "$tmp/body" | head -n 1; }

echo "Claudex server at $BASE"
if get "GET /health" 200 /health; then
  grep -q '"status":"ok"' "$tmp/body" || { echo "FAIL  /health is not ok: $(cat "$tmp/body")"; rc=1; }
fi
# /health does not touch the database; the public settings do.
get "GET /api/v1/settings/public (database)" 200 /api/v1/settings/public &&
  echo "      site_name=$(field site_name) registration_enabled=$(field registration_enabled)"
if get "GET /api/v1/claudex/release (public)" 200 /api/v1/claudex/release; then
  grep -q '"api_version":' "$tmp/body" || { echo "FAIL  release has no api_version: $(head -c 300 "$tmp/body")"; rc=1; }
  echo "      server version=$(field version) build_type=$(field build_type)"
fi
get "GET /api/v1/claudex/capabilities without sign-in" 401 /api/v1/claudex/capabilities

if [ -n "${ADMIN_EMAIL:-}" ] && [ -n "${ADMIN_PASSWORD:-}" ]; then
  json_string() { local s=${1//\\/\\\\}; s=${s//\"/\\\"}; printf '"%s"' "$s"; }
  printf '{"email":%s,"password":%s}' "$(json_string "$ADMIN_EMAIL")" "$(json_string "$ADMIN_PASSWORD")" > "$tmp/login.json"
  if get "POST /api/v1/auth/login (administrator)" 200 /api/v1/auth/login \
    -H 'Content-Type: application/json' --data-binary "@$tmp/login.json"; then
    token=$(sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p' "$tmp/body")
    # The deployment templates set 60 minutes (JWT_ACCESS_TOKEN_EXPIRE_MINUTES).
    echo "      access token expires_in=$(field expires_in)s"
    rm -f "$tmp/login.json"
    if [ -z "$token" ]; then
      echo "skip  administrator checks: no access token (two-factor sign-in?)"
    else
      printf 'Authorization: Bearer %s\n' "$token" > "$tmp/auth"
      get "GET /api/v1/claudex/capabilities (signed in)" 200 /api/v1/claudex/capabilities -H "@$tmp/auth"
      if get "GET /api/v1/admin/compliance" 200 /api/v1/admin/compliance -H "@$tmp/auth"; then
        required=$(field required)
        echo "      compliance commitment required=$required (only the owner accepts it, in the console)"
        want=200
        [ "$required" = true ] && want=423
        get "GET /api/v1/admin/claudex/overview (compliance gate)" "$want" /api/v1/admin/claudex/overview -H "@$tmp/auth"
        code=$(curl -sS -o "$tmp/body" -w '%{http_code}' -m 15 -H "@$tmp/auth" "$BASE/api/v1/admin/claudex/policy")
        case "$code" in
          "$want") echo "ok    GET /api/v1/admin/claudex/policy (compliance gate) ($code)" ;;
          404) echo "note  GET /api/v1/admin/claudex/policy: 404, this build has no policy feature yet" ;;
          *) echo "FAIL  GET /api/v1/admin/claudex/policy: want $want, got $code: $(head -c 300 "$tmp/body")"; rc=1 ;;
        esac
      fi
    fi
  fi
elif [ "$DEV" = 1 ]; then
  echo "skip  administrator checks: no one-time password in the current server log (it is printed"
  echo "      only on the first start of a new stack); set ADMIN_PASSWORD or CLAUDEX_DEV_ADMIN_PASSWORD"
else
  echo "skip  administrator checks (set ADMIN_EMAIL and ADMIN_PASSWORD, or use --dev)"
fi
exit $rc
