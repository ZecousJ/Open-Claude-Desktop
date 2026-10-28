#!/usr/bin/env bash
# Resumable Docker Hub image fetch for flaky networks, then `docker load`.
# `docker pull` can stall forever when the connection drops mid-layer; this
# downloads each blob with curl (resume, retries, parallel byte ranges for large
# blobs, sha256 verification) into a cache directory, builds a docker-archive
# tar and loads it. lib.sh's ensure_image falls back to it automatically.
# Usage: scripts/backend/fetch-image.sh <repo> <tag> [arch]
#   e.g. scripts/backend/fetch-image.sh library/postgres 18-alpine
# Cache: $IMAGE_CACHE (default work/backend/image-cache); retries: FETCH_RETRIES (60).
set -uo pipefail
REPO="$1"; TAG="$2"
case "$(uname -m)" in arm64|aarch64) DEFAULT_ARCH=arm64 ;; *) DEFAULT_ARCH=amd64 ;; esac
ARCH="${3:-$DEFAULT_ARCH}"
NAME="${REPO#library/}:$TAG"
ROOT=$(cd "$(dirname "$0")/../.." && pwd -P)
CACHE="${IMAGE_CACHE:-$ROOT/work/backend/image-cache}/$(echo "$REPO-$TAG-$ARCH" | tr '/:' '__')"
MAX="${FETCH_RETRIES:-60}"
mkdir -p "$CACHE/blobs"; cd "$CACHE" || exit 1
fsize() { stat -c %s "$1" 2>/dev/null || stat -f %z "$1" 2>/dev/null || echo 0; }
log() { echo "[fetch-image $(date '+%T')] $*" >&2; }

token() {
  curl -fsS --max-time 30 "https://auth.docker.io/token?service=registry.docker.io&scope=repository:$REPO:pull" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])'
}
# get_json <ref> <accept> <out>
get_json() {
  local i
  for i in $(seq 1 "$MAX"); do
    local t; t=$(token 2>/dev/null) || { sleep 3; continue; }
    if curl -fsS --max-time 60 -H "Authorization: Bearer $t" -H "Accept: $2" \
        "https://registry-1.docker.io/v2/$REPO/manifests/$1" -o "$3.tmp" \
       && python3 -c 'import json,sys;json.load(open(sys.argv[1]))' "$3.tmp" 2>/dev/null; then
      mv "$3.tmp" "$3"; return 0
    fi
    log "manifest $1 attempt $i failed"; sleep 3
  done; return 1
}
# get_part <url-digest> <file> <start> <end> : resumable byte-range download (appends).
get_part() {
  local d="$1" f="$2" a="$3" b="$4" need=$(( $4 - $3 + 1 )) i
  for i in $(seq 1 "$MAX"); do
    local have; have=$(fsize "$f")
    [ "$have" -eq "$need" ] && return 0
    [ "$have" -gt "$need" ] && { rm -f "$f"; have=0; }
    local t; t=$(token 2>/dev/null) || { sleep 3; continue; }
    curl -fsSL --connect-timeout 20 --speed-limit 2048 --speed-time 20 --max-time 300 \
      -r "$((a + have))-$b" -H "Authorization: Bearer $t" \
      "https://registry-1.docker.io/v2/$REPO/blobs/$d" >> "$f" 2>/dev/null || sleep 2
  done; return 1
}
# get_blob <digest> <size>: blobs > 8 MiB are fetched as PARTS parallel ranges.
get_blob() {
  local d="$1" size="$2" f="blobs/${1#sha256:}"
  if [ "$size" -gt 8388608 ] && ! [ -f "$f" -a "$(fsize "$f")" = "$size" ]; then
    local parts="${PARTS:-8}" dir="$f.parts" p pids=()
    local chunk=$(( (size + parts - 1) / parts ))
    mkdir -p "$dir"
    for p in $(seq 0 $((parts - 1))); do
      local a=$(( p * chunk )) b=$(( (p + 1) * chunk - 1 )); [ "$b" -ge "$size" ] && b=$((size - 1))
      get_part "$d" "$dir/$p" "$a" "$b" & pids+=($!)
    done
    ( while sleep 30; do log "  ${d:7:12}: $(cat "$dir"/* 2>/dev/null | wc -c | tr -d ' ')/$size bytes"; done ) & local mon=$!
    local ok=1; for p in "${pids[@]}"; do wait "$p" || ok=0; done
    kill "$mon" 2>/dev/null
    [ "$ok" = 1 ] || return 1
    rm -f "$f"; for p in $(seq 0 $((parts - 1))); do cat "$dir/$p" >> "$f"; done; rm -rf "$dir"
  fi
  get_blob_single "$d" "$size"
}
get_blob_single() {
  local d="$1" size="$2" f="blobs/${1#sha256:}" i
  for i in $(seq 1 "$MAX"); do
    if [ -f "$f" ] && [ "$(fsize "$f")" = "$size" ]; then
      [ "sha256:$(shasum -a 256 "$f" | cut -d' ' -f1)" = "$d" ] && return 0
      log "digest mismatch for $d, restarting"; rm -f "$f"
    fi
    local t; t=$(token 2>/dev/null) || { sleep 3; continue; }
    curl -fsSL -C - --connect-timeout 20 --speed-limit 1024 --speed-time 30 --max-time 600 \
      -H "Authorization: Bearer $t" "https://registry-1.docker.io/v2/$REPO/blobs/$d" -o "$f" \
      || log "blob ${d:7:12} attempt $i: curl rc=$? have $(fsize "$f")/$size bytes"
  done; return 1
}

if docker image inspect "$NAME" >/dev/null 2>&1; then log "$NAME already present"; exit 0; fi
get_json "$TAG" 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json' index.json || exit 2
MDIGEST=$(python3 -c '
import json,sys
for m in json.load(open("index.json"))["manifests"]:
    p=m.get("platform",{})
    if p.get("os")=="linux" and p.get("architecture")==sys.argv[1]: print(m["digest"]); break' "$ARCH")
[ -n "$MDIGEST" ] || { log "no linux/$ARCH manifest"; exit 3; }
get_json "$MDIGEST" 'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' manifest.json || exit 4
log "$NAME linux/$ARCH manifest $MDIGEST"
python3 -c '
import json;m=json.load(open("manifest.json"))
print(m["config"]["digest"],m["config"]["size"])
for l in m["layers"]: print(l["digest"],l["size"])' > blobs.txt
while read -r d s; do
  log "blob ${d:7:12} ($s bytes)"; get_blob "$d" "$s" || { log "blob $d failed"; exit 5; }
done < blobs.txt
# docker-archive layout: manifest.json + config + (compressed) layer files.
rm -rf archive; mkdir archive
cfg=$(head -1 blobs.txt | cut -d' ' -f1); cp "blobs/${cfg#sha256:}" "archive/${cfg#sha256:}.json"
layers=()
while read -r d s; do cp "blobs/${d#sha256:}" "archive/${d#sha256:}.tar.gz"; layers+=("\"${d#sha256:}.tar.gz\""); done < <(tail -n +2 blobs.txt)
printf '[{"Config":"%s.json","RepoTags":["%s"],"Layers":[%s]}]\n' "${cfg#sha256:}" "$NAME" "$(IFS=,; echo "${layers[*]}")" > archive/manifest.json
tar -C archive -cf image.tar . && docker load -i image.tar && rm -rf archive image.tar
docker image inspect "$NAME" --format "loaded {{.RepoTags}} {{.Id}} {{.Architecture}}"
