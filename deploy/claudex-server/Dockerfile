# syntax=docker/dockerfile:1.7
# =============================================================================
# Claudex server image: the Sub2API fork in backend/ (LGPL-3.0) with the admin
# console embedded. The build context is backend/:
#
#   docker build -f deploy/claudex-server/Dockerfile backend/
#   deploy/claudex-server/build-image.sh      # same, with version and commit filled in
#
# Built on the steps of backend/Dockerfile (upstream, left unchanged). Claudex
# differences:
#   - version <cmd/server/VERSION>+claudex.<CLAUDEX_REV> (semver build metadata,
#     so plugin checks still see the upstream release), build type "source";
#   - OCI labels and /app/SOURCE.txt name the corresponding source (LGPL-3.0);
#   - network steps retry (Go proxies alternate; npm falls back to a mirror,
#     pnpm still checks every integrity hash of pnpm-lock.yaml);
#   - the runtime runs as the unprivileged user sub2api (uid 1000);
#   - secrets can be given as files: <NAME>_FILE (see claudex-entrypoint.sh below).
# The ignore rules are in Dockerfile.dockerignore next to this file.
# =============================================================================

ARG NODE_IMAGE=node:24-alpine
ARG GOLANG_IMAGE=golang:1.27.0-alpine
ARG ALPINE_IMAGE=alpine:3.21
ARG POSTGRES_IMAGE=postgres:18-alpine

# -----------------------------------------------------------------------------
# Stage 1: admin console (Vue). JS output is architecture-neutral, so it builds
# on the native platform.
# -----------------------------------------------------------------------------
FROM --platform=${BUILDPLATFORM} ${NODE_IMAGE} AS frontend-builder
ARG PNPM_VERSION=9.15.9
# Empty = the official registry, then NPM_MIRROR_REGISTRY from the third attempt on.
ARG NPM_CONFIG_REGISTRY=
ARG NPM_MIRROR_REGISTRY=https://registry.npmmirror.com/
ARG NET_RETRIES=8
ENV CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NODE_OPTIONS=--max-old-space-size=3072 \
    npm_config_fetch_retries=6 \
    npm_config_fetch_retry_mintimeout=10000 \
    npm_config_fetch_retry_maxtimeout=120000

WORKDIR /app/frontend

RUN corepack enable && \
    i=1; until corepack prepare "pnpm@${PNPM_VERSION}" --activate; do \
      [ "$i" -ge "${NET_RETRIES}" ] && exit 1; i=$((i + 1)); sleep 10; \
    done && pnpm --version

COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN --mount=type=cache,id=claudex-server-pnpm-store,target=/pnpm-store \
    i=1; while :; do \
      registry="${NPM_CONFIG_REGISTRY:-https://registry.npmjs.org/}"; \
      if [ -z "${NPM_CONFIG_REGISTRY}" ] && [ -n "${NPM_MIRROR_REGISTRY}" ] && [ "$i" -gt 2 ]; then registry="${NPM_MIRROR_REGISTRY}"; fi; \
      echo "pnpm install attempt $i (registry $registry)"; \
      pnpm install --frozen-lockfile --prefer-offline --store-dir /pnpm-store --registry "$registry" && break; \
      [ "$i" -ge "${NET_RETRIES}" ] && exit 1; i=$((i + 1)); sleep 15; \
    done

# The admin-compliance pages import ../../docs/legal/*.md?raw at build time, so
# docs/legal sits next to frontend/ as in the upstream Dockerfile. Vite writes
# to ../backend/internal/web/dist.
COPY frontend/ ./
COPY docs/legal/ /app/docs/legal/
RUN pnpm run build

# -----------------------------------------------------------------------------
# Stage 2: Go server with the console embedded (pure Go cross-compile).
# -----------------------------------------------------------------------------
FROM --platform=${BUILDPLATFORM} ${GOLANG_IMAGE} AS backend-builder
ARG GOPROXY=https://proxy.golang.org,https://goproxy.cn,direct
# With "," Go only falls through on 404/410, so even attempts swap the order.
ARG GOPROXY_ALT=https://goproxy.cn,https://proxy.golang.org,direct
ARG GOSUMDB=sum.golang.org
# Extra go flags, e.g. -p=2 on a host with little memory.
ARG GOFLAGS=
ARG NET_RETRIES=8
ARG TARGETOS
ARG TARGETARCH
ENV GOPROXY=${GOPROXY} \
    GOSUMDB=${GOSUMDB} \
    GOFLAGS=${GOFLAGS} \
    GOTOOLCHAIN=local \
    CGO_ENABLED=0

WORKDIR /app/backend

COPY backend/go.mod backend/go.sum ./
RUN --mount=type=cache,id=claudex-server-gomod,target=/go/pkg/mod \
    i=1; while :; do \
      proxy="${GOPROXY}"; [ $((i % 2)) -eq 0 ] && proxy="${GOPROXY_ALT}"; \
      echo "go mod download attempt $i (GOPROXY=$proxy)"; \
      GOPROXY="$proxy" GOMAXPROCS=16 timeout 1200 go mod download && break; \
      [ "$i" -ge "${NET_RETRIES}" ] && exit 1; i=$((i + 1)); sleep 15; \
    done

COPY backend/ ./
# After the source copy, so a stale local dist can never mix in.
COPY --from=frontend-builder /app/backend/internal/web/dist ./internal/web/dist

# CLAUDEX_REV: Claudex build number N in <upstream version>+claudex.N. Build
# metadata, not a pre-release ("-claudex.N"): the plugin compatibility check
# (internal/service/plugin_compatibility.go) compares with golang.org/x/mod/semver,
# where v0.2.8-claudex.1 < v0.2.8 would fail every plugin that needs >=0.2.8.
# GIT_COMMIT: commit of the Claudex repository the context comes from.
ARG CLAUDEX_REV=0
ARG GIT_COMMIT=unknown
ARG BUILD_DATE=
ARG SOURCE_URL=https://github.com/ZecousJ/Open-Claude-Desktop
RUN --mount=type=cache,id=claudex-server-gomod,target=/go/pkg/mod \
    --mount=type=cache,id=claudex-server-gobuild,target=/root/.cache/go-build \
    set -eu; \
    base="$(tr -d '\r\n' < cmd/server/VERSION)"; \
    version="${base}+claudex.${CLAUDEX_REV}"; \
    date="${BUILD_DATE:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"; \
    upstream="$(sed -n 's/^[[:space:]]*UpstreamCommit[[:space:]]*=[[:space:]]*"\([0-9a-f]*\)".*/\1/p' internal/claudex/module.go)"; \
    GOOS="${TARGETOS:-linux}" GOARCH="${TARGETARCH}" go build \
      -tags embed \
      -trimpath \
      -ldflags="-s -w -X main.Version=${version} -X main.Commit=${GIT_COMMIT} -X main.Date=${date} -X main.BuildType=source" \
      -o /out/sub2api \
      ./cmd/server; \
    mkdir -p /out/meta; \
    { \
      echo "Claudex server ${version}"; \
      echo "Built ${date} from ${SOURCE_URL}, commit ${GIT_COMMIT}."; \
      echo ""; \
      echo "This program is a modified version of Sub2API (https://github.com/Wei-Shaw/sub2api,"; \
      echo "commit ${upstream:-unknown}), licensed under the GNU Lesser General Public License v3.0;"; \
      echo "the license texts are /app/LICENSE (LGPL-3.0) and /app/COPYING (GPL-3.0)."; \
      echo "/app/CLAUDEX_CHANGES.md lists the changes."; \
      echo ""; \
      echo "Corresponding source: the backend/ directory of ${SOURCE_URL}"; \
      echo "at commit ${GIT_COMMIT}; this image was built from it with"; \
      echo "  docker build -f deploy/claudex-server/Dockerfile backend/"; \
      echo "(deploy/claudex-server/build-image.sh in the same commit)."; \
      case "${GIT_COMMIT}" in \
        *-dirty|unknown|"") echo ""; \
          echo "WARNING: built from uncommitted changes or an unknown commit. There is no exact"; \
          echo "corresponding source commit for this image: do not distribute it." ;; \
      esac; \
    } > /out/meta/SOURCE.txt; \
    cat /out/meta/SOURCE.txt

# -----------------------------------------------------------------------------
# Stage 3: PostgreSQL client tools matching the database major version.
# -----------------------------------------------------------------------------
FROM ${POSTGRES_IMAGE} AS pg-client

# -----------------------------------------------------------------------------
# Stage 4: runtime.
# -----------------------------------------------------------------------------
FROM ${ALPINE_IMAGE}

ARG GIT_COMMIT=unknown
ARG SOURCE_URL=https://github.com/ZecousJ/Open-Claude-Desktop
LABEL org.opencontainers.image.title="Claudex server" \
      org.opencontainers.image.description="Claudex server: a modified version of Sub2API with the Claudex extensions (LGPL-3.0). Source: backend/ of the source repository at the revision below." \
      org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.revision="${GIT_COMMIT}" \
      org.opencontainers.image.licenses="LGPL-3.0-only"

RUN apk add --no-cache \
    ca-certificates \
    tzdata \
    su-exec \
    libpq \
    zstd-libs \
    lz4-libs \
    krb5-libs \
    libldap \
    libedit \
    && rm -rf /var/cache/apk/*

# pg_dump/psql for the built-in backup feature, same major version as the database.
COPY --from=pg-client /usr/local/bin/pg_dump /usr/local/bin/pg_dump
COPY --from=pg-client /usr/local/bin/psql /usr/local/bin/psql
COPY --from=pg-client /usr/local/lib/libpq.so.5* /usr/local/lib/

RUN addgroup -g 1000 sub2api && \
    adduser -u 1000 -G sub2api -s /bin/sh -D sub2api

WORKDIR /app

COPY --from=backend-builder --chown=sub2api:sub2api /out/sub2api /app/sub2api
COPY --from=backend-builder --chown=sub2api:sub2api /app/backend/resources /app/resources
COPY --from=backend-builder /out/meta/SOURCE.txt /app/SOURCE.txt
COPY LICENSE COPYING CLAUDEX_CHANGES.md /app/
# Upstream entrypoint: fixes /app/data ownership when started as root, then
# runs the server as sub2api.
COPY --chmod=755 deploy/docker-entrypoint.sh /app/docker-entrypoint.sh

# Reads <NAME>_FILE secrets (Docker/Kubernetes secrets, files outside the
# environment), refuses the change-me placeholders of .env.example, then hands
# over to the upstream entrypoint.
COPY --chmod=755 <<'EOF' /app/claudex-entrypoint.sh
#!/bin/sh
set -eu
for name in DATABASE_PASSWORD REDIS_PASSWORD JWT_SECRET TOTP_ENCRYPTION_KEY ADMIN_PASSWORD; do
  file_var="${name}_FILE"
  eval "file=\${${file_var}:-}"
  eval "value=\${${name}:-}"
  if [ -n "$file" ]; then
    if [ -n "$value" ]; then
      echo "claudex-entrypoint: set $name or $file_var, not both" >&2
      exit 64
    fi
    if [ ! -r "$file" ]; then
      echo "claudex-entrypoint: cannot read $file_var ($file)" >&2
      exit 64
    fi
    value=$(cat "$file")
    export "$name=$value"
    unset "$file_var"
  fi
  case "$value" in
    change-me*)
      echo "claudex-entrypoint: $name is still the change-me placeholder; set a real value" >&2
      exit 64
      ;;
  esac
done
exec /app/docker-entrypoint.sh "$@"
EOF

RUN mkdir -p /app/data && chown sub2api:sub2api /app/data

USER 1000:1000

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD wget -q -T 5 -O /dev/null http://localhost:${SERVER_PORT:-8080}/health || exit 1

ENTRYPOINT ["/app/claudex-entrypoint.sh"]
CMD ["/app/sub2api"]
