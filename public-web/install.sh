#!/usr/bin/env bash
# Installs Claudex on Linux:
#   curl -fsSL https://<your service>/install.sh | CLAUDEX_BASE=https://<your service> bash
# Picks the package for this computer (deb for apt, rpm for dnf/yum/zypper,
# otherwise the tar.gz into /opt/claudex), checks its SHA-256 against the
# Claudex service's release information and installs it (sudo asks for
# your password). Claudex then updates itself from the app.
set -euo pipefail

BASE="${CLAUDEX_BASE:?Set CLAUDEX_BASE to your Claudex service, e.g. https://claudex.example.com}"
say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf 'Claudex: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Linux ] || die "this installer is for Linux. Download Claudex for macOS or Windows from $BASE/downloads"
case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "Claudex doesn't support $(uname -m) yet." ;;
esac
command -v curl >/dev/null || die "curl is missing."

if command -v apt-get >/dev/null && command -v dpkg >/dev/null; then PKG=deb
elif command -v dnf >/dev/null || command -v yum >/dev/null || command -v zypper >/dev/null; then PKG=rpm
else PKG=tar
fi

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null || die "run this as root or install sudo."
  SUDO="sudo"
fi

say "Finding the latest Claudex for Linux ($ARCH, $PKG)…"
INFO="$(curl -fsSL "$BASE/api/v1/claudex/release?platform=linux&arch=$ARCH&package=$PKG")" || die "the Claudex service can't be reached."
field() { printf '%s' "$INFO" | grep -o "\"$1\":\"[^\"]*\"" | head -n1 | cut -d'"' -f4; }
URL="$(field download_url)"
SHA="$(field sha256)"
VERSION="$(field latest_version)"
[ -n "$URL" ] && [ -n "$SHA" ] || die "there is no Linux download for $ARCH ($PKG) yet."

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FILE="$TMP/$(basename "${URL%%\?*}")"
say "Downloading Claudex $VERSION…"
curl -fL --retry 3 --progress-bar -o "$FILE" "$URL" || die "the download failed."
if command -v sha256sum >/dev/null; then GOT="$(sha256sum "$FILE" | cut -d' ' -f1)"
else GOT="$(shasum -a 256 "$FILE" | cut -d' ' -f1)"; fi
[ "$GOT" = "$SHA" ] || die "the download doesn't match its checksum; nothing was installed."

say "Installing (your password may be asked for)…"
case "$PKG" in
  deb)
    $SUDO apt-get install -y "$FILE" ;;
  rpm)
    if command -v dnf >/dev/null; then $SUDO dnf install -y "$FILE"
    elif command -v yum >/dev/null; then $SUDO yum install -y "$FILE"
    else $SUDO zypper --non-interactive install --allow-unsigned-rpm "$FILE"; fi ;;
  tar)
    DEST=/opt/claudex
    $SUDO mkdir -p "$DEST.new"
    $SUDO tar -xzf "$FILE" -C "$DEST.new" --strip-components=1
    $SUDO chmod 4755 "$DEST.new/chrome-sandbox"
    $SUDO rm -rf "$DEST.old"
    if [ -d "$DEST" ]; then $SUDO mv "$DEST" "$DEST.old"; fi
    $SUDO mv "$DEST.new" "$DEST"
    $SUDO rm -rf "$DEST.old"
    $SUDO ln -sf "$DEST/claudex" /usr/local/bin/claudex
    $SUDO tee /usr/share/applications/claudex.desktop >/dev/null <<DESKTOP
[Desktop Entry]
Name=Claudex
Comment=Claudex desktop app: chat, Cowork and Code
Exec=$DEST/claudex %U
Icon=$DEST/resources/about-icon.png
Terminal=false
Type=Application
Categories=Development;
StartupWMClass=Claudex
DESKTOP
    ;;
esac

say "Claudex $VERSION is installed. Open it from your applications menu, or run: claudex"
