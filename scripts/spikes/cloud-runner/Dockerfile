# Spike image only (W-SPIKE / RUN-0): a Linux userland with the tools the
# probe needs. Codex and runsc are bind-mounted by run.sh, not baked in.
FROM node:24-alpine
RUN apk add --no-cache bubblewrap su-exec git python3 py3-pip curl tar procps-ng ca-certificates
