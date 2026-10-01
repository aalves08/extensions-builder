#!/usr/bin/env bash
# Shared helpers for the extensions-builder phases.
#
# Sourced by entrypoint.sh and by each phase script. Owns logging, the
# ::phase:: log markers the UI parses, and status.json.

set -euo pipefail

: "${BUILD_CONFIG:=/config/build.json}"
: "${OUT_DIR:=/srv/repo}"
: "${WORK_DIR:=/work}"

export SHELL_VERSION="99.99.99"
export VERDACCIO_REGISTRY="http://localhost:4873"
export DEFAULT_NPM_REGISTRY="https://registry.npmjs.org/"

export DASHBOARD_DIR="${WORK_DIR}/dashboard"
export EXTENSIONS_DIR="${WORK_DIR}/extensions"
export STATUS_FILE="${OUT_DIR}/status.json"

# Ordered; entrypoint runs them in this sequence and the UI renders a stepper
# in the same order. build-dashboard is skipped unless the host-UI toggle is on.
export PHASE_NAMES=(resolve publish-shell build-dashboard build-extensions package)

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

log()  { echo "[$(now)] $*"; }
warn() { echo "[$(now)] WARN: $*" >&2; }
die()  { echo "[$(now)] ERROR: $*" >&2; exit 1; }

# Read a jq expression out of the build spec.
cfg() { jq -r "$1" "${BUILD_CONFIG}"; }

# Apply a jq filter to status.json in place.
status_set() {
  local filter="$1" tmp
  tmp="$(mktemp)"
  jq "${filter}" "${STATUS_FILE}" > "${tmp}"
  mv "${tmp}" "${STATUS_FILE}"
}

status_init() {
  local phases_json
  phases_json="$(printf '%s\n' "${PHASE_NAMES[@]}" \
    | jq -R . \
    | jq -s 'map({ name: ., state: "pending", startedAt: null, finishedAt: null })')"

  mkdir -p "${OUT_DIR}"
  jq -n \
    --arg buildId "$(cfg '.buildId')" \
    --arg startedAt "$(now)" \
    --argjson phases "${phases_json}" \
    '{
       buildId:   $buildId,
       state:     "running",
       phase:     null,
       startedAt: $startedAt,
       finishedAt: null,
       shellSha:  null,
       shellRef:  null,
       dashboard: false,
       packages:  [],
       error:     null,
       phases:    $phases
     }' > "${STATUS_FILE}"
}

# The UI tails the pod log and parses these markers. That is its ONLY channel:
# status.json lives on the output volume, which is reachable from inside the
# cluster but never from the browser. Alongside ::phase:: the phases also emit
# ::shell::, ::package:: and ::dashboard:: - see builder/README.md.
#
# status.json is still written, for anyone debugging the volume directly and
# as the record the packaging phase reads back.
phase_start() {
  local name="$1"
  echo "::phase::${name}::start"
  log "===== phase: ${name} ====="
  status_set "
    .phase = \"${name}\"
    | (.phases[] | select(.name == \"${name}\") | .state)     = \"running\"
    | (.phases[] | select(.name == \"${name}\") | .startedAt) = \"$(now)\"
  "
}

phase_ok() {
  local name="$1"
  echo "::phase::${name}::ok"
  status_set "
    (.phases[] | select(.name == \"${name}\") | .state)      = \"success\"
    | (.phases[] | select(.name == \"${name}\") | .finishedAt) = \"$(now)\"
  "
}

phase_skip() {
  local name="$1" reason="${2:-}"
  echo "::phase::${name}::skip"
  log "skipping ${name}${reason:+ (${reason})}"
  status_set "(.phases[] | select(.name == \"${name}\") | .state) = \"skipped\""
}

phase_fail() {
  local name="$1" message="$2" tmp
  echo "::phase::${name}::fail"
  tmp="$(mktemp)"
  jq \
    --arg name "${name}" \
    --arg msg "${message}" \
    --arg ts "$(now)" \
    '
      .state      = "failed"
      | .error      = $msg
      | .finishedAt = $ts
      | (.phases[] | select(.name == $name) | .state)      = "failed"
      | (.phases[] | select(.name == $name) | .finishedAt) = $ts
    ' "${STATUS_FILE}" > "${tmp}"
  mv "${tmp}" "${STATUS_FILE}"
}

# Switch to the Node version an extension repo pins, if it pins one we don't
# already have. Mirrors what extension-compatibility-test.yml does per repo.
use_node_for_dir() {
  local dir="$1"

  if [ ! -f "${dir}/.nvmrc" ]; then
    log "no .nvmrc in $(basename "${dir}"), staying on node $(node -v)"
    return 0
  fi

  local want current
  want="$(tr -d ' \tv\r\n' < "${dir}/.nvmrc")"
  current="$(node -v | tr -d 'v')"

  if [[ "${current}" == "${want}"* ]]; then
    log "node $(node -v) already satisfies .nvmrc (${want})"
    return 0
  fi

  log "extension pins node ${want}, current is $(node -v) - switching via nvm"
  # shellcheck disable=SC1091
  . "${NVM_DIR}/nvm.sh"
  (cd "${dir}" && nvm install && nvm use)
  log "now on node $(node -v)"
}

yarn_registry() { yarn config set registry "$1" >/dev/null; }
npm_registry()  { npm config set registry "$1" >/dev/null; }

# Rewrite "version" in a package.json. Same sed the upstream scripts use, so the
# same set of pre-release suffixes is recognised.
set_pkg_version() {
  local file="$1" version="$2"
  sed -i -E "s/\"version\": \"[0-9]+\.[0-9]+\.[0-9]+(-alpha\.[0-9]+|-release[0-9]+\.[0-9]+\.[0-9]+|-rc\.[0-9]+)?\",/\"version\": \"${version}\",/" "${file}"
}
