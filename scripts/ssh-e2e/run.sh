#!/usr/bin/env bash
# R9 SSH end to end: this computer's real OpenSSH client against a real
# sshd in Docker, with the real Codex Linux runtime installed on the host by
# Claudex and a real conversation through the remote forward.
#
#   scripts/ssh-e2e/run.sh [--arch arm64|amd64] [--keep] [-- <node --test args>]
#
# What it sets up (all in a temporary folder, never ~/.ssh):
#   - a throwaway ed25519 key (for the "dev" account) and a random password
#     (for the "pw" account, answered through Claudex's askpass);
#   - an ssh_config with the test's aliases, its own known_hosts file (empty,
#     so the first connection asks to trust the host key), no ssh-agent;
#   - an "ssh" wrapper that runs /usr/bin/ssh (or $CLAUDEX_SSH_E2E_CLIENT)
#     with -F <that config>, given to Claudex as the host's SSH program.
# The container listens on 127.0.0.1 only and is removed at the end.
#
# The Codex package for the host is downloaded once (with retries) into
# scripts/ssh-e2e/.cache/ and uploaded from there when the host can't
# download it itself. `--arch amd64` runs an x86_64 host under emulation.
#
# Run heavy Docker work through the machine's queue when there is one, e.g.
#   GOLOCK_WEIGHT=1 golock.sh scripts/ssh-e2e/run.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
arch=""
keep=0
extra=()
while [ $# -gt 0 ]; do
  case "$1" in
    --arch) arch="$2"; shift 2 ;;
    --keep) keep=1; shift ;;
    --) shift; extra=("$@"); break ;;
    *) echo "usage: $0 [--arch arm64|amd64] [--keep] [-- <node --test args>]" >&2; exit 2 ;;
  esac
done
if [ -z "$arch" ]; then
  case "$(docker info --format '{{.Architecture}}')" in
    aarch64|arm64) arch=arm64 ;;
    *) arch=amd64 ;;
  esac
fi
case "$arch" in arm64|amd64) ;; *) echo "--arch must be arm64 or amd64" >&2; exit 2 ;; esac

client="${CLAUDEX_SSH_E2E_CLIENT:-/usr/bin/ssh}"
[ -x "$client" ] || { echo "No OpenSSH client at $client" >&2; exit 2; }

# A short folder: control sockets live under it (104-byte socket paths).
dir="$(mktemp -d "${CLAUDEX_SSH_E2E_TMP:-/tmp}/cxssh.XXXXXX")"
chmod 700 "$dir"
project="claudex-ssh-e2e-$(basename "$dir" | tr 'A-Z.' 'a-z-')"
export E2E_DIR="$dir" E2E_TAG="$arch" E2E_PLATFORM="linux/$arch"
compose() { docker compose -p "$project" -f "$here/docker-compose.yml" "$@"; }

cleanup() {
  status=$?
  if [ "$keep" = 1 ]; then
    echo "Kept: compose project $project, folder $dir" >&2
  else
    compose down --remove-orphans --timeout 5 >/dev/null 2>&1 || true
    rm -rf "$dir"
  fi
  exit $status
}
trap cleanup EXIT INT TERM

# The port: a free loopback port chosen by the OS.
E2E_SSH_PORT="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
closed_port="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
E2E_PASSWORD="$(node -e 'console.log(require("crypto").randomBytes(18).toString("base64url"))')"
export E2E_SSH_PORT E2E_PASSWORD

ssh-keygen -q -t ed25519 -N '' -C claudex-ssh-e2e -f "$dir/id_ed25519"
cp "$dir/id_ed25519.pub" "$dir/authorized_keys"
chmod 644 "$dir/authorized_keys"
# Another key, to stand in for a host whose key changed.
ssh-keygen -q -t ed25519 -N '' -C other-host -f "$dir/other_host_key"
: > "$dir/known_hosts"
printf '[127.0.0.1]:%s %s\n' "$E2E_SSH_PORT" "$(cut -d' ' -f1-2 "$dir/other_host_key.pub")" > "$dir/known_hosts_changed"

cat > "$dir/ssh_config" <<EOF
Host claudex-e2e
  User dev
  IdentityFile $dir/id_ed25519
Host claudex-e2e-pw
  User pw
  PubkeyAuthentication no
  PreferredAuthentications password
  NumberOfPasswordPrompts 1
Host claudex-e2e-changed
  User dev
  IdentityFile $dir/id_ed25519
  UserKnownHostsFile $dir/known_hosts_changed
Host claudex-e2e-closed
  HostName 127.0.0.1
  Port $closed_port
  User dev
Host *
  HostName 127.0.0.1
  Port $E2E_SSH_PORT
  UserKnownHostsFile $dir/known_hosts
  GlobalKnownHostsFile /dev/null
  UpdateHostKeys no
  HashKnownHosts no
  CheckHostIP no
  IdentityAgent none
  IdentitiesOnly yes
EOF
mkdir -p "$dir/bin"
cat > "$dir/bin/ssh" <<EOF
#!/bin/sh
# Every command line, for the test's checks (no secrets are on them).
if [ -n "\${CLAUDEX_SSH_E2E_LOG:-}" ]; then printf '%s\\n' "\$*" >> "\$CLAUDEX_SSH_E2E_LOG"; fi
exec '$client' -F '$dir/ssh_config' "\$@"
EOF
chmod 755 "$dir/bin/ssh"

echo "== Building and starting the SSH host (linux/$arch, 127.0.0.1:$E2E_SSH_PORT)"
for attempt in 1 2 3; do
  if compose build >"$dir/build.log" 2>&1; then break; fi
  if grep -q "exec format error" "$dir/build.log"; then
    echo "This Docker can't run linux/$arch images: turn on emulation (Docker Desktop: Rosetta or QEMU) or run on a $arch machine." >&2
    exit 1
  fi
  tail -20 "$dir/build.log" >&2
  [ "$attempt" = 3 ] && { echo "The host image didn't build." >&2; exit 1; }
  sleep 5
done
compose up -d >/dev/null
for _ in $(seq 1 100); do
  if compose exec -T host test -s /run/host-fingerprint 2>/dev/null; then break; fi
  sleep 0.2
done
fingerprint="$(compose exec -T host cat /run/host-fingerprint | tr -d '\r\n')"
[ -n "$fingerprint" ] || { compose logs >&2; echo "The host didn't start." >&2; exit 1; }

cache="$here/.cache"
mkdir -p "$cache"

echo "== Running tests/ssh/e2e.test.ts"
cd "$repo"
CLAUDEX_SSH_E2E=1 \
CLAUDEX_SSH_E2E_DIR="$dir" \
CLAUDEX_SSH_E2E_SSH="$dir/bin/ssh" \
CLAUDEX_SSH_E2E_PASSWORD="$E2E_PASSWORD" \
CLAUDEX_SSH_E2E_FINGERPRINT="$fingerprint" \
CLAUDEX_SSH_E2E_ARCH="$arch" \
CLAUDEX_SSH_E2E_CACHE="$cache" \
  npx tsx --test --test-concurrency=1 ${extra[@]+"${extra[@]}"} tests/ssh/e2e.test.ts
