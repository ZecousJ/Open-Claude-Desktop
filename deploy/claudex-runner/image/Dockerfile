# claudex-sandbox: the root file system of every gVisor sandbox on a runner
# host (W-GVISOR, W-RUN 4.1). Built on a development machine or in CI with
# build.sh, shipped as a rootfs tarball, unpacked read-only on the runner by
# install-image.sh. Not built on the production server.
#
# Contents: Debian 12 slim, git and common build tools, Python 3, Node 24
# (also used by the in-sandbox bridge), and the Linux build of Codex pinned
# to the same version as the desktop app, checked against the npm registry's
# sha512 integrity before it is unpacked. No credentials of any kind.
#
# The file tools a conversation reaches for (README.md lists them): the
# Python data, Office, PDF/OCR, image and web packages of requirements.txt,
# LibreOffice (headless), Poppler, Tesseract (eng, chi_sim, chi_tra),
# Ghostscript, FFmpeg, Pandoc, Playwright's Chromium, and CJK, Latin and
# emoji fonts. smoke.sh checks them at the end of the build.
#
# Mirrors for a build in China (all optional): APT_MIRROR (a Debian mirror
# host, e.g. mirrors.ustc.edu.cn), PIP_INDEX_URL, PLAYWRIGHT_DOWNLOAD_HOST.
#
# /opt/claudex/image.json tells the runner where codex and node are and the
# SHA-256 of the codex executable (RunscDriver.check verifies it).

ARG BASE_IMAGE=debian:bookworm-slim
ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS node

FROM ${BASE_IMAGE} AS codex
ARG TARGETARCH
# Same version as the desktop app (scripts/prepare-runtime.mjs).
ARG CODEX_VERSION=0.144.1
# npm registry dist.integrity of @openai/codex@<version>-linux-<arch>.
ARG CODEX_SRI_AMD64=sha512-HNGVI+BulrOaC/0IzBvd6EL62j7LrlbFKibrhw6hZjjCjAeUYzRB2jB4qDzXN1NfqDi6Xrvniof3kwbwab24lg==
ARG CODEX_SRI_ARM64=sha512-451o15+XtaXCCb35t/KCyyPqXHnTPxPxtdqEYOnE3e4sH5AfnI/uVJwfdjOksMG6vRLy6R+fLvSDOMguRFLmQw==
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl openssl \
 && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) pkg=linux-x64; triple=x86_64-unknown-linux-musl; sri="$CODEX_SRI_AMD64" ;; \
      arm64) pkg=linux-arm64; triple=aarch64-unknown-linux-musl; sri="$CODEX_SRI_ARM64" ;; \
      *) echo "unsupported architecture $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    url="https://registry.npmjs.org/@openai/codex/-/codex-$CODEX_VERSION-$pkg.tgz"; \
    ok=; for i in 1 2 3 4 5 6 7 8; do \
      if curl -fsSL --retry 3 --max-time 900 -o /tmp/codex.tgz "$url"; then ok=1; break; fi; \
      echo "download failed ($i)" >&2; sleep 5; \
    done; [ -n "$ok" ]; \
    got="sha512-$(openssl dgst -sha512 -binary /tmp/codex.tgz | openssl base64 -A)"; \
    if [ "$got" != "$sri" ]; then echo "codex package hash mismatch" >&2; exit 1; fi; \
    mkdir -p /tmp/pkg /opt/claudex/codex; \
    tar -xzf /tmp/codex.tgz -C /tmp/pkg; \
    cp -a "/tmp/pkg/package/vendor/$triple/." /opt/claudex/codex/; \
    test -x /opt/claudex/codex/bin/codex; \
    # Codex answers to apply_patch by its program name. The aliases it puts
    # in its own temporary folder never reach the sandbox's commands, so the
    # image's PATH folder carries them ("apply_patch: command not found").
    mkdir -p /opt/claudex/codex/codex-path; \
    ln -s ../bin/codex /opt/claudex/codex/codex-path/apply_patch; \
    ln -s ../bin/codex /opt/claudex/codex/codex-path/applypatch; \
    echo "$CODEX_VERSION" > /opt/claudex/codex/VERSION; \
    rm -rf /tmp/pkg /tmp/codex.tgz

FROM ${BASE_IMAGE}
ARG IMAGE_VERSION=dev
ARG CODEX_VERSION=0.144.1
ARG APT_MIRROR=
ARG PIP_INDEX_URL=
ARG PLAYWRIGHT_DOWNLOAD_HOST=
ENV DEBIAN_FRONTEND=noninteractive
RUN if [ -n "$APT_MIRROR" ]; then \
      sed -i "s#deb.debian.org#$APT_MIRROR#g" /etc/apt/sources.list.d/debian.sources; \
    fi \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates git curl wget less procps file tree \
      unzip zip xz-utils zstd bzip2 jq patch diffutils \
      build-essential pkg-config \
      python3 python3-pip python3-venv python3-dev python-is-python3 \
      ripgrep sqlite3 tzdata \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*
# Documents, PDF/OCR, media and fonts. The fonts matter as much as the
# programs: without CJK fonts Chinese renders as boxes in charts, PDFs and
# converted documents (Liberation keeps Office layouts metric-compatible).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      fontconfig fonts-noto-cjk fonts-noto-color-emoji fonts-dejavu-core \
      fonts-liberation2 \
      libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui \
      poppler-utils ghostscript \
      tesseract-ocr tesseract-ocr-eng tesseract-ocr-chi-sim tesseract-ocr-chi-tra \
      ffmpeg pandoc librsvg2-bin libcairo2 \
 && fc-cache -f \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*
# Python packages system-wide (requirements.txt); /etc/pip.conf, written
# below, then sends a user's own installs to their home.
COPY requirements.txt /opt/claudex/requirements.txt
RUN set -eu; \
    if [ -n "$PIP_INDEX_URL" ]; then export PIP_INDEX_URL; fi; \
    ok=; for i in 1 2 3; do \
      if python3 -m pip install --no-cache-dir --no-user --break-system-packages \
           --root-user-action=ignore -r /opt/claudex/requirements.txt; then ok=1; break; fi; \
      echo "pip install failed ($i)" >&2; sleep 5; \
    done; [ -n "$ok" ]; \
    python3 -m pip freeze --all > /opt/claudex/python-packages.txt
# Playwright's Chromium (and the libraries it needs), shared read-only by
# every sandbox; /usr/local/bin/chromium points at it for other tools.
RUN set -eu; \
    export PLAYWRIGHT_BROWSERS_PATH=/opt/playwright; \
    apt-get update; \
    python3 -m playwright install-deps chromium; \
    ok=; for host in "$PLAYWRIGHT_DOWNLOAD_HOST" "$PLAYWRIGHT_DOWNLOAD_HOST" ""; do \
      if PLAYWRIGHT_DOWNLOAD_HOST="$host" python3 -m playwright install chromium; then ok=1; break; fi; \
      echo "chromium download failed (${host:-default host})" >&2; sleep 5; \
    done; [ -n "$ok" ]; \
    chrome=$(ls -d /opt/playwright/chromium-*/chrome-linux*/chrome | head -n1); \
    test -x "$chrome"; \
    ln -sf "$chrome" /usr/local/bin/chromium; \
    chmod -R a+rX /opt/playwright; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=codex /opt/claudex/codex /opt/claudex/codex
COPY smoke.sh /opt/claudex/smoke.sh
RUN set -eu; \
    ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm; \
    ln -sf ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx; \
    ln -sf ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack; \
    node --version; npm --version; /opt/claudex/codex/bin/codex --version; \
    # Tool defaults for a HOME under /codex-home: global npm packages and
    # pip installs go to the user's home, git trusts the mounted workspace
    # (its owner is the runner's uid, not a user the image knows).
    mkdir -p /usr/local/etc; \
    printf 'prefix=${HOME}/.npm-global\nupdate-notifier=false\nfund=false\n' > /usr/local/etc/npmrc; \
    # `user` only for installs: under [global] it made `pip list` and
    # `pip freeze` show the user's packages alone, so a conversation found
    # none of the preinstalled ones and installed them again.
    printf '[global]\nbreak-system-packages = true\ndisable-pip-version-check = true\n[install]\nuser = true\n' > /etc/pip.conf; \
    printf '[safe]\n\tdirectory = *\n[init]\n\tdefaultBranch = main\n' > /etc/gitconfig; \
    # Mount points: data, bridge sockets, extra read-only inputs.
    mkdir -p /workspace /codex-home /run/claudex/fwd /mnt/ro; \
    # The sandbox user comes from the runner's synthesized /etc/passwd.
    arch=$(uname -m); \
    sha=$(sha256sum /opt/claudex/codex/bin/codex | cut -d' ' -f1); \
    # env: what the sandbox's processes need to find the image's tools (the
    # runner adds it to their environment; Dockerfile ENV never reaches them).
    printf '{\n  "format": "claudex-sandbox-image/1",\n  "version": "%s",\n  "arch": "%s",\n  "codexVersion": "%s",\n  "codex": "/opt/claudex/codex/bin/codex",\n  "codexSha256": "%s",\n  "node": "/usr/local/bin/node",\n  "pathDirs": ["/opt/claudex/codex/codex-path"],\n  "env": {\n    "PLAYWRIGHT_BROWSERS_PATH": "/opt/playwright",\n    "BROWSER_PATH": "/usr/local/bin/chromium",\n    "MPLBACKEND": "Agg"\n  }\n}\n' \
      "$IMAGE_VERSION" "$arch" "$CODEX_VERSION" "$sha" > /opt/claudex/image.json; \
    cat /opt/claudex/image.json; \
    chmod 755 /opt/claudex/smoke.sh; \
    PLAYWRIGHT_BROWSERS_PATH=/opt/playwright BROWSER_PATH=/usr/local/bin/chromium MPLBACKEND=Agg \
      HOME=/tmp/smoke-home /opt/claudex/smoke.sh; \
    rm -rf /tmp/smoke-home
