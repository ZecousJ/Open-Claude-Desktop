#!/usr/bin/env bash
# Blue-green switch of the Claudex server (owner, 2026-10-03: every update
# took the site down while the server restarted and migrated).
#
# Two systemd instances of claudex-server@.service: blue on 127.0.0.1:18080,
# green on 127.0.0.1:18081, each running /opt/claudex/sub2api-<colour>. nginx
# reaches the live one through the upstream claudex_backend
# (/etc/nginx/conf.d/claudex-upstream.conf); /etc/claudex/active-colour
# names it. A switch:
#   1. starts the idle colour on the new binary (migrations, warm-up) and
#      waits until it answers /health and its web page;
#   2. points nginx at it (a graceful reload: open requests carry on);
#   3. stops the old colour, which first closes its runner links and web tabs
#      (they dial again and reach the new one within a second or two, running
#      turns go on) and then lets its HTTP requests finish
#      (CLAUDEX_SHUTDOWN_GRACE).
# A new instance that does not come up is stopped and nothing else changes.
#
# Run as root on the server:
#   ssh <host> 'bash -s' -- <commit> < deploy/claudex-server/bluegreen.sh
set -euo pipefail

COMMIT=${1:?usage: bluegreen.sh <commit>}
BIN=/opt/claudex/releases/sub2api-$COMMIT
[ -x "$BIN" ] || { echo "missing $BIN" >&2; exit 1; }
STATE=/etc/claudex/active-colour
UPSTREAM=/etc/nginx/conf.d/claudex-upstream.conf
port_of() { if [ "$1" = blue ]; then echo 18080; else echo 18081; fi; }

# The template unit and the per-colour settings (the port, and two minutes
# for a stopping instance's requests).
cat > /etc/systemd/system/claudex-server@.service <<'UNIT'
[Unit]
Description=Claudex server, %i (Sub2API fork, LGPL-3.0)
After=network-online.target postgresql.service redis-server.service
Requires=postgresql.service redis-server.service

[Service]
User=claudex
Group=claudex
WorkingDirectory=/opt/claudex
EnvironmentFile=/etc/claudex/claudex.env
EnvironmentFile=/etc/claudex/instance-%i.env
ExecStart=/opt/claudex/sub2api-%i
Restart=on-failure
RestartSec=5
TimeoutStopSec=150
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
for colour in blue green; do
  printf 'SERVER_PORT=%s\nCLAUDEX_SHUTDOWN_GRACE=120s\n' "$(port_of $colour)" > /etc/claudex/instance-$colour.env
  chown root:claudex /etc/claudex/instance-$colour.env
  chmod 640 /etc/claudex/instance-$colour.env
done
systemctl daemon-reload

# The live colour; before the first switch the single claudex-server.service
# on 18080 is live, so green comes first.
active=$(cat "$STATE" 2>/dev/null || true)
case "$active" in
  blue) next=green ;;
  green) next=blue ;;
  *) active=legacy next=green ;;
esac
port=$(port_of $next)

ln -sfn "$BIN" /opt/claudex/sub2api-$next
systemctl stop claudex-server@$next 2>/dev/null || true
systemctl start claudex-server@$next
up=
for _ in $(seq 1 90); do
  if curl -fs -m 3 "http://127.0.0.1:$port/health" >/dev/null &&
    curl -fs -m 5 -o /dev/null "http://127.0.0.1:$port/"; then
    up=1
    break
  fi
  systemctl is-active -q claudex-server@$next || break
  sleep 2
done
if [ -z "$up" ]; then
  echo "claudex-server@$next did not come up; $active stays live" >&2
  journalctl -u claudex-server@$next -n 20 --no-pager >&2 || true
  systemctl stop claudex-server@$next || true
  exit 1
fi

# nginx: the upstream file, and the site pointed at it (once).
cat > "$UPSTREAM.new" <<CONF
# Written by deploy/claudex-server/bluegreen.sh: the live Claudex server ($next).
upstream claudex_backend {
    server 127.0.0.1:$port;
}
CONF
mv "$UPSTREAM.new" "$UPSTREAM"
SITE=${NGINX_SITE:-/etc/nginx/sites-available/claudex.conf}
if [ -f "$SITE" ] && grep -q 'proxy_pass http://127.0.0.1:18080;' "$SITE"; then
  cp -p "$SITE" "$SITE.pre-bluegreen"
  sed -i 's#proxy_pass http://127.0.0.1:18080;#proxy_pass http://claudex_backend;#' "$SITE"
fi
if ! nginx -t 2>/dev/null; then
  nginx -t || true
  echo "nginx refused the new upstream; $active stays live" >&2
  [ -f "$SITE.pre-bluegreen" ] && grep -q claudex_backend "$SITE" && cp -p "$SITE.pre-bluegreen" "$SITE"
  systemctl stop claudex-server@$next || true
  exit 1
fi
systemctl reload nginx
echo "$next" > "$STATE"
ln -sfn "$BIN" /opt/claudex/sub2api
systemctl enable -q claudex-server@$next

# The old instance leaves (runner links and tabs first, requests within the
# grace). Not waited for: it may take up to two minutes.
sleep 1
if [ "$active" = legacy ]; then
  systemctl disable -q claudex-server 2>/dev/null || true
  systemctl stop --no-block claudex-server 2>/dev/null || true
else
  systemctl disable -q claudex-server@$active 2>/dev/null || true
  systemctl stop --no-block claudex-server@$active
fi
echo "live: $next ($port) on $(readlink /opt/claudex/sub2api-$next); $active stopping"
