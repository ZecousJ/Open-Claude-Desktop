#!/usr/bin/env bash
# W-SPIKE / RUN-0: runs probe.mjs in a privileged Linux container (the Docker
# Desktop VM) with the pinned Codex 0.144.1 Linux build and gVisor runsc.
# Heavy: run it through the Docker queue, e.g.
#   GOLOCK_WEIGHT=2 SCRATCH/golock.sh scripts/spikes/cloud-runner/run.sh
# Knobs: SPIKE_LAUNCHERS=direct,bwrap,runsc  SPIKE_SKIP_NETWORK=1
#        SPIKE_DENSITY=2  RUNSC_PLATFORM=systrap|ptrace  RUNSC_FLAGS="--overlay2=none"
#        SPIKE_MEM=3g  SPIKE_CPUS=3  SPIKE_KEEP=1  SPIKE_ENTRY=probe.mjs
#        SPIKE_CACHE=<dir> (default work/spikes/cloud-runner/cache)
# Downloads are cached in work/spikes/cloud-runner (gitignored) and verified
# against the pinned hashes below. No credentials are used.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
REPO=$(cd "$HERE/../../.." && pwd -P)
CACHE=${SPIKE_CACHE:-$REPO/work/spikes/cloud-runner/cache}
IMAGE=claudex-spike-cloud-runner:1
CODEX_VERSION=0.144.1
GVISOR_RELEASE=20260921
case "$(docker version --format '{{.Server.Arch}}')" in
  arm64 | aarch64)
    CODEX_ARCH=linux-arm64 CODEX_TARGET=aarch64-unknown-linux-musl GV_ARCH=aarch64
    CODEX_SRI=sha512-451o15+XtaXCCb35t/KCyyPqXHnTPxPxtdqEYOnE3e4sH5AfnI/uVJwfdjOksMG6vRLy6R+fLvSDOMguRFLmQw==
    GVISOR_SHA512=bac6a20f57b71c66538f9d33fb71e05c025bd1a420ed0c3afef58e0cde14273604a67411b886a1aae468de268dff66021ab7373f977a5715c6ab6f5ab62331fe
    ;;
  amd64 | x86_64)
    # Not pinned here yet: taken from the npm registry and the release .sha512
    # (same origin as the download, so this only catches corruption). Pin both
    # hashes before relying on an x86_64 run.
    CODEX_ARCH=linux-x64 CODEX_TARGET=x86_64-unknown-linux-musl GV_ARCH=x86_64
    CODEX_SRI='' GVISOR_SHA512=''
    ;;
  *)
    echo "unsupported Docker arch" >&2
    exit 1
    ;;
esac
mkdir -p "$CACHE"

fetch() { # url file
  local i
  for i in $(seq 1 10); do
    curl -fsSL -C - --retry 3 --max-time 900 -o "$2" "$1" && return 0
    echo "download failed ($i): $1" >&2
    sleep 3
  done
  return 1
}

CODEX_TGZ=$CACHE/codex-$CODEX_VERSION-$CODEX_ARCH.tgz
[ -s "$CODEX_TGZ" ] || fetch "https://registry.npmjs.org/@openai/codex/-/codex-$CODEX_VERSION-$CODEX_ARCH.tgz" "$CODEX_TGZ"
[ -n "$CODEX_SRI" ] || CODEX_SRI=$(npm view "@openai/codex@$CODEX_VERSION-$CODEX_ARCH" dist.integrity)
got="sha512-$(openssl dgst -sha512 -binary "$CODEX_TGZ" | base64 | tr -d '\n')"
if [ "$got" != "$CODEX_SRI" ]; then
  echo "codex tarball hash mismatch" >&2
  rm -f "$CODEX_TGZ"
  exit 1
fi

GV=$CACHE/gvisor-$GVISOR_RELEASE-$GV_ARCH.tar.zstd
GV_URL=https://storage.googleapis.com/gvisor/releases/release/$GVISOR_RELEASE/$GV_ARCH/gvisor.tar.zstd
[ -s "$GV" ] || fetch "$GV_URL" "$GV"
if [ -z "$GVISOR_SHA512" ]; then
  fetch "$GV_URL.sha512" "$GV.sha512"
  GVISOR_SHA512=$(cut -d' ' -f1 "$GV.sha512")
fi
got=$(shasum -a 512 "$GV" | cut -d' ' -f1)
if [ "$got" != "$GVISOR_SHA512" ]; then
  echo "gVisor archive hash mismatch" >&2
  rm -f "$GV"
  exit 1
fi

EX=$CACHE/extract-$CODEX_ARCH
if [ ! -x "$EX/gvisor/gvisor-bin/gvisor_sentry" ] || [ ! -x "$EX/codex/bin/codex" ]; then
  rm -rf "$EX"
  mkdir -p "$EX/pkg" "$EX/gvisor"
  tar -xzf "$CODEX_TGZ" -C "$EX/pkg"
  mv "$EX/pkg/package/vendor/$CODEX_TARGET" "$EX/codex"
  rm -rf "$EX/pkg"
  # runsc 2026+ starts its sentry from the gvisor-bin/ sidecar next to it.
  zstd -dc "$GV" | tar -xf - -C "$EX/gvisor" runsc gvisor-bin
fi

for i in 1 2 3 4 5; do
  docker build -q -t "$IMAGE" "$HERE" >/dev/null && break
  if [ "$i" = 5 ]; then
    echo "image build failed" >&2
    exit 1
  fi
  sleep 5
done

mkdir -p "$HERE/results"
# --privileged: runsc needs to create namespaces and set up its syscall traps,
# and Docker's default seccomp profile blocks the unprivileged user namespaces
# bwrap uses. A production runner host runs neither under Docker.
docker run --rm --privileged --cgroupns=private \
  --memory "${SPIKE_MEM:-3g}" --cpus "${SPIKE_CPUS:-3}" \
  -e SPIKE_LAUNCHERS -e SPIKE_SKIP_NETWORK -e SPIKE_DENSITY -e SPIKE_KEEP \
  -e RUNSC_PLATFORM -e RUNSC_FLAGS \
  -v "$EX/codex:/opt/codex:ro" \
  -e PATH=/opt/gvisor:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  -v "$EX/gvisor:/opt/gvisor:ro" \
  -v "$HERE:/opt/spike:ro" \
  -v "$HERE/results:/out" \
  "$IMAGE" node "/opt/spike/${SPIKE_ENTRY:-probe.mjs}"
