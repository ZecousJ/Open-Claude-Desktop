#!/usr/bin/env bash
# Installs a claudex-sandbox root file system on a runner host (W-GVISOR).
# Run as root on the runner host (W-RDEPLOY's install.sh calls it):
#
#   install-image.sh <claudex-sandbox-…rootfs.tar.zst> [images-dir]
#
# Checks the archive against its .sha256 file, unpacks it into
# <images-dir>/<version>-<arch>/rootfs (default images-dir
# /var/lib/claudex-runner/images), checks the codex executable against the
# checksum in the image manifest, makes the tree root-owned and read-only,
# and points <images-dir>/current at it. Older versions are kept (sandboxes
# still running on them); remove them by hand once idle.
# Needs: tar, zstd, sha256sum, node (reads the manifest).
set -euo pipefail
ARCHIVE=${1:?usage: install-image.sh <rootfs.tar.zst> [images-dir]}
IMAGES=${2:-/var/lib/claudex-runner/images}
if [ "$(id -u)" != 0 ]; then
  echo "install-image.sh must run as root" >&2
  exit 1
fi
[ -f "$ARCHIVE.sha256" ] || {
  echo "missing $ARCHIVE.sha256" >&2
  exit 1
}
want=$(cut -d' ' -f1 "$ARCHIVE.sha256")
got=$(sha256sum "$ARCHIVE" | cut -d' ' -f1)
if [ "$want" != "$got" ]; then
  echo "archive checksum mismatch" >&2
  exit 1
fi

mkdir -p "$IMAGES"
chmod 755 "$IMAGES"
tmp=$(mktemp -d "$IMAGES/.install-XXXXXX")
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/rootfs"
zstd -dc "$ARCHIVE" | tar -x -C "$tmp/rootfs" --numeric-owner --no-same-permissions -f -

manifest="$tmp/rootfs/opt/claudex/image.json"
# A bad manifest must stop the install (set -e does not see a failed <(…)).
meta=$(node -e '
  const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (m.format !== "claudex-sandbox-image/1") process.exit(2);
  for (const v of [m.version, m.arch]) if (!/^[A-Za-z0-9._-]+$/.test(v)) process.exit(3);
  if (!/^\/opt\/[A-Za-z0-9._\/-]+$/.test(m.codex) || !/^[0-9a-f]{64}$/.test(m.codexSha256)) process.exit(4);
  console.log(m.version, m.arch, m.codex, m.codexSha256);
' "$manifest") || {
  echo "the image manifest is missing or invalid" >&2
  exit 1
}
read -r version arch codex sha <<<"$meta"
csum=$(sha256sum "$tmp/rootfs$codex" | cut -d' ' -f1)
if [ "$csum" != "$sha" ]; then
  echo "codex checksum in the image does not match its manifest" >&2
  exit 1
fi

dest="$IMAGES/$version-$arch"
if [ -e "$dest" ]; then
  echo "$dest already exists; leaving it in place" >&2
else
  chown -R 0:0 "$tmp/rootfs"
  chmod -R go-w "$tmp/rootfs"
  chmod 755 "$tmp"
  mv "$tmp" "$dest"
  trap - EXIT
fi
ln -sfn "$version-$arch" "$IMAGES/current.new"
mv -T "$IMAGES/current.new" "$IMAGES/current"
echo "installed $dest (current -> $version-$arch)"
