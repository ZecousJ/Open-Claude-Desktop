#!/usr/bin/env bash
# Backs up a running Claudex server stack and keeps the newest N backups:
#   claudex-db-<time>.dump     pg_dump -Fc taken inside the postgres container
#                              (consistent while the server runs), checked with
#                              pg_restore --list
#   claudex-data-<time>.tgz    the server's /app/data without logs (config.yaml, install lock)
#
#   deploy/claudex-server/backup.sh [--dir DIR] [--keep N] [--compose-file FILE] [--no-data]
#
# Defaults: DIR=backups/ next to the compose file, N=14, FILE=docker-compose.yml
# next to this script (use -f ../sub2api/docker-compose.yml for that folder).
# Files are mode 600: config.yaml holds the database password and JWT secret.
# Keep .env with the backups (encrypted); Redis holds only caches and windows.
# Restore: README.md, "Backup and restore". Cron example:
#   30 3 * * * /opt/claudex/deploy/claudex-server/backup.sh --keep 30
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd -P)
FILE="$HERE/docker-compose.yml"
DIR=""
KEEP=14
DATA=1
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR=${2:?--dir needs a directory}; shift 2 ;;
    --keep) KEEP=${2:?--keep needs a number}; shift 2 ;;
    -f|--compose-file) FILE=${2:?--compose-file needs a file}; shift 2 ;;
    --no-data) DATA=0; shift ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "Unknown option $1 (see --help)" >&2; exit 2 ;;
  esac
done
case "$KEEP" in '' | *[!0-9]* | 0) echo "--keep must be a positive integer" >&2; exit 2 ;; esac
[ -r "$FILE" ] || { echo "Cannot read compose file $FILE" >&2; exit 2; }
DIR=${DIR:-$(dirname "$FILE")/backups}

umask 077
mkdir -p "$DIR"
compose() { docker compose -f "$FILE" "$@"; }
stamp=$(date -u +%Y%m%dT%H%M%SZ)
db="$DIR/claudex-db-$stamp.dump"
data="$DIR/claudex-data-$stamp.tgz"
cleanup() { rm -f "$db.partial" "$data.partial"; }
trap cleanup EXIT

if [ -z "$(compose ps --status running -q postgres 2>/dev/null)" ]; then
  echo "postgres is not running in $FILE; start the stack first." >&2
  exit 1
fi

echo "Dumping the database"
# shellcheck disable=SC2016 # expanded by the shell inside the postgres container
compose exec -T postgres sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$db.partial"
compose exec -T postgres pg_restore --list < "$db.partial" > /dev/null
mv "$db.partial" "$db"
echo "  $db ($(wc -c < "$db" | tr -d ' ') bytes)"

if [ "$DATA" = 1 ]; then
  echo "Archiving the server data volume"
  if [ -n "$(compose ps --status running -q claudex-server 2>/dev/null)" ]; then
    compose exec -T claudex-server tar czf - -C /app --exclude=data/logs data > "$data.partial"
  else
    compose run --rm --no-deps -T --entrypoint tar claudex-server czf - -C /app --exclude=data/logs data > "$data.partial"
  fi
  tar tzf "$data.partial" > /dev/null
  mv "$data.partial" "$data"
  echo "  $data ($(wc -c < "$data" | tr -d ' ') bytes)"
fi

# Retention: newest $KEEP of each kind.
for pattern in 'claudex-db-*.dump' 'claudex-data-*.tgz'; do
  find "$DIR" -maxdepth 1 -type f -name "$pattern" | sort -r | tail -n +"$((KEEP + 1))" |
    while IFS= read -r old; do
      rm -f "$old"
      echo "  removed $old"
    done
done
