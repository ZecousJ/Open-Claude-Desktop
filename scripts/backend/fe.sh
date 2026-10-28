#!/usr/bin/env bash
# Vue side of the Sub2API fork (backend/frontend) in node:24-alpine with pnpm 9.
#
# Usage: scripts/backend/fe.sh <step> [args...] [<step> [args...]]...
#   install            pnpm install --frozen-lockfile with retries (the only network step)
#   typecheck          vue-tsc --noEmit
#   i18n               pnpm run check:i18n (en/zh locale key completeness)
#   test [files...]    vitest run (default: every spec); JSON report in work/backend/logs/vitest.json
#   lint               eslint, report only (never fails)
#   build              pnpm run build (check:i18n + vue-tsc -b + vite build) into
#                      backend/backend/internal/web/dist/admin, which go.sh build-embed embeds
# node_modules lives in a Docker volume, so the source tree only gains ignored
# build output. Example: scripts/backend/fe.sh install typecheck i18n test
set -uo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

STATE_DIR=$WORK_DIR/fe-state
mkdir -p "$STATE_DIR"
# Reuse the registry of the last successful install unless one is forced.
if [ -z "${FE_NPM_REGISTRY:-}" ] && [ -s "$STATE_DIR/registry" ]; then FE_REGISTRY=$(cat "$STATE_DIR/registry"); fi

_install_attempt=0
_install_once() {
  _install_attempt=$((_install_attempt + 1))
  if [ -z "${FE_NPM_REGISTRY:-}" ] && [ "$_install_attempt" -gt "$FE_OFFICIAL_ATTEMPTS" ]; then FE_REGISTRY=$FE_NPM_MIRROR; fi
  log "pnpm install attempt $_install_attempt (registry ${FE_REGISTRY:-${FE_NPM_REGISTRY:-$FE_OFFICIAL_REGISTRY}})"
  fe_run claudex-fe-install '
    echo "node $(node -v) / pnpm $(pnpm -v) / registry $npm_config_registry"
    pnpm install --frozen-lockfile --prefer-offline
    pnpm list --depth 0 >/dev/null' || return 1
  echo "${FE_REGISTRY:-${FE_NPM_REGISTRY:-$FE_OFFICIAL_REGISTRY}}" > "$STATE_DIR/registry"
}
step_install() { retry "${INSTALL_RETRIES:-10}" 20 _install_once; }

step_typecheck() { fe_run claudex-fe-typecheck 'pnpm run typecheck'; }

step_i18n() { fe_run claudex-fe-i18n 'pnpm run check:i18n'; }

step_test() {
  fe_run claudex-fe-test "pnpm exec vitest run --maxWorkers=${VITEST_WORKERS:-3} --minWorkers=1 \
    --reporter=default --reporter=json --outputFile.json=/work/logs/vitest.json $*"
}

step_lint() {
  fe_run claudex-fe-lint 'pnpm run lint:check; echo "eslint exit code: $? (report only)"; true'
}

step_build() {
  fe_run claudex-fe-build '
    pnpm run build
    ls -la /app/backend/internal/web/dist | head -20
    du -sh /app/backend/internal/web/dist'
}

ensure_image "$NODE_IMAGE" || die "cannot get $NODE_IMAGE"
[ $# -gt 0 ] || { sed -n '2,15p' "$0"; exit 2; }
rc_all=0
while [ $# -gt 0 ]; do
  step=$1; shift
  args=()
  while [ $# -gt 0 ] && ! declare -F "step_${1//-/_}" >/dev/null; do args+=("$1"); shift; done
  fn="step_${step//-/_}"
  declare -F "$fn" >/dev/null || die "unknown step: $step"
  timed "fe-$step" "$fn" ${args[@]+"${args[@]}"} || { rc_all=1; [ "$step" = install ] && exit 1; }
done
exit $rc_all
