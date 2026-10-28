#!/usr/bin/env bash
# Runs the Claudex server binary produced by build-from-source.sh with the same
# .env file the Docker Compose stack uses. PostgreSQL 15+ and Redis 7+ must
# already be running (for example distribution packages); their addresses
# default to 127.0.0.1 and can be overridden with DATABASE_HOST/DATABASE_PORT
# and REDIS_HOST/REDIS_PORT in the env file. A secret can also come from a file:
# <NAME>_FILE=/path (for POSTGRES_PASSWORD, REDIS_PASSWORD, ADMIN_PASSWORD,
# JWT_SECRET, TOTP_ENCRYPTION_KEY).
#
#   deploy/sub2api/run-from-source.sh [--env FILE] [--bin DIR]
#
# Runs in the foreground; use the systemd unit in README.md for a service.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd -P)
ROOT=$(cd "$HERE/../.." && pwd -P)
ENV_FILE="$HERE/.env"
BIN="$ROOT/work/claudex-server"
while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_FILE=${2:?--env needs a file}; shift 2 ;;
    --bin) BIN=${2:?--bin needs a directory}; shift 2 ;;
    *) echo "Usage: $0 [--env FILE] [--bin DIR]" >&2; exit 2 ;;
  esac
done
[ -x "$BIN/sub2api" ] || { echo "No binary at $BIN/sub2api; run build-from-source.sh first." >&2; exit 2; }
[ -r "$ENV_FILE" ] || { echo "Cannot read $ENV_FILE (copy .env.example and fill it in)." >&2; exit 2; }

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

for key in POSTGRES_PASSWORD REDIS_PASSWORD ADMIN_PASSWORD JWT_SECRET TOTP_ENCRYPTION_KEY; do
  file_key="${key}_FILE"
  if [ -n "${!file_key:-}" ]; then
    if [ -n "${!key:-}" ]; then echo "Set $key or $file_key in $ENV_FILE, not both." >&2; exit 2; fi
    [ -r "${!file_key}" ] || { echo "Cannot read $file_key (${!file_key})." >&2; exit 2; }
    printf -v "$key" '%s' "$(cat "${!file_key}")"
    unset "$file_key"
  fi
done
for key in POSTGRES_PASSWORD ADMIN_EMAIL ADMIN_PASSWORD JWT_SECRET TOTP_ENCRYPTION_KEY; do
  value=${!key:-}
  if [ -z "$value" ] || [[ "$value" == change-me* ]]; then
    echo "$key is not set in $ENV_FILE." >&2
    exit 2
  fi
done
# Redis may run without a password on a private host, but never with the placeholder.
if [[ "${REDIS_PASSWORD:-}" == change-me* ]]; then
  echo "REDIS_PASSWORD in $ENV_FILE is still the placeholder (set it, or leave it empty for a password-less local Redis)." >&2
  exit 2
fi

# Same variables the image receives from deploy/claudex-server/docker-compose.yml.
export AUTO_SETUP=true SERVER_MODE=release RUN_MODE=standard
export SERVER_HOST=${BIND_HOST:-127.0.0.1} SERVER_PORT=${CLAUDEX_SERVER_PORT:-8080}
export DATABASE_HOST=${DATABASE_HOST:-127.0.0.1} DATABASE_PORT=${DATABASE_PORT:-5432}
export DATABASE_USER=${POSTGRES_USER:-sub2api} DATABASE_PASSWORD=$POSTGRES_PASSWORD
export DATABASE_DBNAME=${POSTGRES_DB:-sub2api} DATABASE_SSLMODE=${DATABASE_SSLMODE:-disable}
export REDIS_HOST=${REDIS_HOST:-127.0.0.1} REDIS_PORT=${REDIS_PORT:-6379}
export REDIS_PASSWORD=${REDIS_PASSWORD:-} REDIS_DB=${REDIS_DB:-0}
export ADMIN_PASSWORD JWT_SECRET TOTP_ENCRYPTION_KEY
export JWT_ACCESS_TOKEN_EXPIRE_MINUTES=${JWT_ACCESS_TOKEN_EXPIRE_MINUTES:-60}
export DATA_DIR=${DATA_DIR:-$BIN/data} TZ=${TZ:-Asia/Shanghai}
mkdir -p "$DATA_DIR"
chmod 700 "$DATA_DIR"

# resources/ (fallback pricing) is looked up next to the working directory.
cd "$BIN"
exec ./sub2api
