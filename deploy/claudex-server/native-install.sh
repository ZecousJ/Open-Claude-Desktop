#!/usr/bin/env bash
# Claudex server without Docker, for a small host that already runs other
# services (Docker would rewrite iptables and can break VPN forwarding).
# PostgreSQL and Redis come from the distribution; the server runs under
# systemd as the user "claudex" and listens on 127.0.0.1 only, so nothing is
# exposed until a reverse proxy site is added.
#
# Run as root on the server, after copying the files:
#   /opt/claudex/releases/sub2api-<commit>   linux/amd64 binary with the console embedded
#   /opt/claudex/resources/                  backend/backend/resources
#   /opt/claudex/{LICENSE,COPYING,CLAUDEX_CHANGES.md}
#
#   ssh <host> 'bash -s' -- <commit> < deploy/claudex-server/native-install.sh
#
# Secrets are generated on the server into /etc/claudex/claudex.env (0640
# root:claudex) and never printed. The first administrator is ADMIN_EMAIL with
# the generated ADMIN_PASSWORD from that file; that person accepts the
# compliance commitment in the console. Re-running keeps existing secrets and
# data and only switches the binary.
set -euo pipefail

COMMIT=${1:?usage: native-install.sh <commit>}
ADMIN_EMAIL=${ADMIN_EMAIL:?set ADMIN_EMAIL to the first administrator address}
PORT=${PORT:-18080}
BIN=/opt/claudex/releases/sub2api-$COMMIT
[ -x "$BIN" ] || { echo "missing $BIN" >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive
find /opt/claudex -name '._*' -delete
apt-get update -qq
apt-get install -y -qq postgresql redis-server >/dev/null

id claudex >/dev/null 2>&1 || useradd --system --home /opt/claudex --shell /usr/sbin/nologin claudex
mkdir -p /opt/claudex/data /etc/claudex
chown -R root:root /opt/claudex
chown -R claudex:claudex /opt/claudex/data

umask 077
if [ ! -f /etc/claudex/claudex.env ]; then
  pg_pw=$(openssl rand -hex 24)
  redis_pw=$(openssl rand -hex 24)
  cat > /etc/claudex/claudex.env <<ENV
AUTO_SETUP=true
DATA_DIR=/opt/claudex/data
SERVER_HOST=127.0.0.1
SERVER_PORT=$PORT
SERVER_MODE=release
RUN_MODE=standard
TZ=Asia/Shanghai
DATABASE_HOST=127.0.0.1
DATABASE_PORT=5432
DATABASE_USER=claudex
DATABASE_PASSWORD=$pg_pw
DATABASE_DBNAME=claudex
DATABASE_SSLMODE=disable
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=$redis_pw
REDIS_DB=0
ADMIN_EMAIL=$ADMIN_EMAIL
ADMIN_PASSWORD=$(openssl rand -base64 18 | tr -d '/+=')
JWT_SECRET=$(openssl rand -hex 32)
TOTP_ENCRYPTION_KEY=$(openssl rand -hex 32)
JWT_ACCESS_TOKEN_EXPIRE_MINUTES=60
JWT_EXPIRE_HOUR=24
SECURITY_URL_ALLOWLIST_ENABLED=false
ENV
  chown root:claudex /etc/claudex/claudex.env
  chmod 640 /etc/claudex/claudex.env
  sudo -u postgres psql -qc "CREATE ROLE claudex LOGIN PASSWORD '$pg_pw'"
  sudo -u postgres psql -qc "CREATE DATABASE claudex OWNER claudex"
  sed -i -E "s/^#? *requirepass .*/requirepass $redis_pw/" /etc/redis/redis.conf
  grep -q '^requirepass ' /etc/redis/redis.conf || echo "requirepass $redis_pw" >> /etc/redis/redis.conf
fi

# Once blue-green is set up (bluegreen.sh), updates go through it: this
# script would restart PostgreSQL and Redis and the old single unit.
if [ -f /etc/claudex/active-colour ]; then
  echo "blue-green is set up: run bluegreen.sh $COMMIT instead" >&2
  exit 1
fi

# Small-host limits: Redis 128 MB, PostgreSQL 128 MB shared buffers.
grep -q '^# claudex' /etc/redis/redis.conf ||
  printf '\n# claudex\nmaxmemory 128mb\nmaxmemory-policy noeviction\nappendonly yes\n' >> /etc/redis/redis.conf
for conf in /etc/postgresql/*/main/postgresql.conf; do
  grep -q '^# claudex' "$conf" ||
    printf '\n# claudex (2 GB host)\nshared_buffers = 128MB\nmax_connections = 60\nwork_mem = 4MB\n' >> "$conf"
done
systemctl restart postgresql redis-server

ln -sfn "$BIN" /opt/claudex/sub2api
cat > /etc/systemd/system/claudex-server.service <<'UNIT'
[Unit]
Description=Claudex server (Sub2API fork, LGPL-3.0)
After=network-online.target postgresql.service redis-server.service
Requires=postgresql.service redis-server.service

[Service]
User=claudex
Group=claudex
WorkingDirectory=/opt/claudex
EnvironmentFile=/etc/claudex/claudex.env
ExecStart=/opt/claudex/sub2api
Restart=on-failure
RestartSec=5
MemoryMax=700M
LimitNOFILE=100000
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/opt/claudex/data

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable claudex-server >/dev/null
systemctl restart claudex-server

for _ in $(seq 1 30); do
  curl -fs -m 3 "http://127.0.0.1:$PORT/health" >/dev/null && break
  sleep 2
done
systemctl is-active claudex-server postgresql redis-server
curl -s -m 5 "http://127.0.0.1:$PORT/health"; echo
