#!/usr/bin/env bash
# Entrypoint for the extensions-builder Job.
#
# Reads the build spec from /config/build.json, runs each phase in order, and
# keeps /srv/repo/status.json up to date so the UI can report progress and,
# afterwards, work out what was actually built.

set -euo pipefail

# shellcheck source=lib/common.sh
. /opt/builder/lib/common.sh

trap 'rc=$?; [ $rc -ne 0 ] && on_failure "$rc"; exit $rc' EXIT

CURRENT_PHASE=""

on_failure() {
  local rc="$1"
  if [ -n "${CURRENT_PHASE}" ] && [ -f "${STATUS_FILE}" ]; then
    phase_fail "${CURRENT_PHASE}" "phase '${CURRENT_PHASE}' exited with status ${rc}"
  fi
  log "build failed during '${CURRENT_PHASE:-startup}' (exit ${rc})"
  log "see the log above for the underlying error"
}

run_phase() {
  local name="$1" script="$2"
  CURRENT_PHASE="${name}"
  phase_start "${name}"
  # shellcheck source=/dev/null
  . "${script}"
  phase_ok "${name}"
  CURRENT_PHASE=""
}

[ -f "${BUILD_CONFIG}" ] || die "no build spec at ${BUILD_CONFIG}"

mkdir -p "${OUT_DIR}" "${WORK_DIR}" "${EXTENSIONS_DIR}"

# A re-run against an existing volume must not inherit the previous attempt's
# half-built repo, or the index would advertise charts that are no longer there.
log "clearing previous output in ${OUT_DIR}"
find "${OUT_DIR}" -mindepth 1 -maxdepth 1 -exec rm -rf {} +

status_init

BUILD_ID="$(cfg '.buildId')"
BUILD_DASHBOARD="$(cfg '.buildDashboard // false')"
EXT_COUNT="$(cfg '.extensions | length')"

log "build id          : ${BUILD_ID}"
log "shell source      : $(cfg '.shell.repo')"
log "shell pr          : $(cfg '.shell.pr // "-"')"
log "shell ref         : $(cfg '.shell.ref // "-"')"
log "build dashboard UI: ${BUILD_DASHBOARD}"
log "extensions        : ${EXT_COUNT}"
log "builder node      : $(node -v), yarn $(yarn -v), helm $(helm version --short)"

[ "${EXT_COUNT}" -gt 0 ] || die "build spec lists no extensions"

run_phase resolve      /opt/builder/phases/10-resolve.sh
run_phase publish-shell /opt/builder/phases/20-publish-shell.sh

if [ "${BUILD_DASHBOARD}" = "true" ]; then
  run_phase build-dashboard /opt/builder/phases/30-build-dashboard.sh
else
  phase_skip build-dashboard "host UI toggle is off"
fi

run_phase build-extensions /opt/builder/phases/40-build-extensions.sh
run_phase package          /opt/builder/phases/50-package.sh

status_set ".state = \"success\" | .phase = null | .finishedAt = \"$(now)\""

log "===== build complete ====="
log "packages:"
jq -r '.packages[] | "  - \(.name) \(.version)"' "${STATUS_FILE}"
log "repo served from ${OUT_DIR}"
