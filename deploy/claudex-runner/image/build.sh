#!/usr/bin/env bash
# Builds the claudex-sandbox image and packs its root file system for runner
# hosts (W-GVISOR). Run on a development machine or in CI, not on the production server:
#
#   deploy/claudex-runner/image/build.sh [amd64|arm64] [out-dir]
#
# Output (default out-dir work/runner-image, gitignored):
#   claudex-sandbox-<version>-<arch>.rootfs.tar.zst   the root file system
#   claudex-sandbox-<version>-<arch>.rootfs.tar.zst.sha256
#   claudex-sandbox-<version>-<arch>.image.json       copy of /opt/claudex/image.json
# Install on the runner host with install-image.sh (as root).
#
# Heavy (Docker build).
# Knobs: IMAGE_VERSION (default <date>-<git short hash>), BASE_IMAGE, NODE_IMAGE,
# and the mirrors APT_MIRROR, PIP_INDEX_URL, PLAYWRIGHT_DOWNLOAD_HOST (Dockerfile).
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
REPO=$(cd "$HERE/../../.." && pwd -P)
ARCH=${1:-$(docker version --format '{{.Server.Arch}}')}
case "$ARCH" in
  amd64 | x86_64) ARCH=amd64 ;;
  arm64 | aarch64) ARCH=arm64 ;;
  *)
    echo "unsupported architecture: $ARCH" >&2
    exit 1
    ;;
esac
OUT=${2:-$REPO/work/runner-image}
VERSION=${IMAGE_VERSION:-$(date -u +%Y.%m.%d)-$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo local)}
case "$VERSION" in
  *[!A-Za-z0-9._-]*)
    echo "IMAGE_VERSION may only contain letters, digits, '.', '_' and '-'" >&2
    exit 1
    ;;
esac
TAG=claudex-sandbox:$VERSION-$ARCH
NAME=claudex-sandbox-$VERSION-$ARCH
mkdir -p "$OUT"

build_args=(--build-arg "IMAGE_VERSION=$VERSION")
[ -n "${BASE_IMAGE:-}" ] && build_args+=(--build-arg "BASE_IMAGE=$BASE_IMAGE")
[ -n "${NODE_IMAGE:-}" ] && build_args+=(--build-arg "NODE_IMAGE=$NODE_IMAGE")
for knob in APT_MIRROR PIP_INDEX_URL PLAYWRIGHT_DOWNLOAD_HOST; do
  [ -n "${!knob:-}" ] && build_args+=(--build-arg "$knob=${!knob}")
done

# The network is flaky: retry the whole build (layers are cached).
for i in 1 2 3 4 5; do
  if docker build --platform "linux/$ARCH" "${build_args[@]}" -t "$TAG" "$HERE"; then
    break
  fi
  if [ "$i" = 5 ]; then
    echo "image build failed" >&2
    exit 1
  fi
  echo "build failed ($i), retrying" >&2
  sleep 10
done

cid=$(docker create --platform "linux/$ARCH" "$TAG" /bin/true)
trap 'docker rm -f "$cid" >/dev/null 2>&1 || true' EXIT

# Repack inside the image itself (it has GNU tar and zstd): fixed /etc/hosts
# (Docker leaves an empty bind-mount target), no resolv.conf entries (the
# sandbox resolves nothing; the egress proxy does), deterministic order.
docker export "$cid" | docker run --rm -i --network none --platform "linux/$ARCH" \
  -v "$OUT:/out" --entrypoint /bin/sh "$TAG" -c '
    set -eu
    mkdir /tmp/r
    tar -x -C /tmp/r --numeric-owner -f -
    printf "127.0.0.1\tlocalhost sandbox\n::1\tlocalhost ip6-localhost ip6-loopback\n" > /tmp/r/etc/hosts
    : > /tmp/r/etc/resolv.conf
    echo sandbox > /tmp/r/etc/hostname
    rm -f /tmp/r/.dockerenv
    tar -C /tmp/r --numeric-owner --sort=name -cf - . | zstd -q -10 -T0 -o "/out/'"$NAME"'.rootfs.tar.zst" -f
    cp /tmp/r/opt/claudex/image.json "/out/'"$NAME"'.image.json"
  '
(cd "$OUT" && shasum -a 256 "$NAME.rootfs.tar.zst" > "$NAME.rootfs.tar.zst.sha256")
ls -l "$OUT/$NAME".*
cat "$OUT/$NAME.image.json"
