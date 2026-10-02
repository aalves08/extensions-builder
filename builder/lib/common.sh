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

# --- Timing -------------------------------------------------------------------
#
# A build is 20-40 minutes of mostly silent yarn and webpack output. Without
# per-step numbers the only way to answer "what is actually slow here?" is to
# subtract log timestamps by hand, and there is no way at all once the pod is
# gone. So every expensive step is timed, every phase reports its own total,
# and the whole thing is summarised at the end.
#
# SECONDS is a bash builtin counting since the shell started. The phases are
# sourced into this same shell, so it keeps running across all of them - and it
# costs no subprocess, unlike date(1), which would be called hundreds of times.

# Elapsed seconds, as something readable at a glance.
hms() {
  local t="${1:-0}"

  if [ "${t}" -ge 3600 ]; then
    printf '%dh %02dm %02ds' $(( t / 3600 )) $(( t % 3600 / 60 )) $(( t % 60 ))
  elif [ "${t}" -ge 60 ]; then
    printf '%dm %02ds' $(( t / 60 )) $(( t % 60 ))
  else
    printf '%ds' "${t}"
  fi
}

# Run a command, reporting what it is and how long it took - including when it
# fails, which is when the number matters most. Returns the command's own exit
# status, so `timed "..." cmd || die "..."` behaves exactly as `cmd || die` did.
timed() {
  local label="$1"; shift
  local t0="${SECONDS}" rc=0

  log "  > ${label}"
  "$@" || rc=$?

  if [ "${rc}" -eq 0 ]; then
    log "  < ${label} - $(hms $(( SECONDS - t0 )))"
  else
    log "  < ${label} - FAILED after $(hms $(( SECONDS - t0 ))) (exit ${rc})"
  fi

  return "${rc}"
}

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
    | jq -s 'map({
        name: ., state: "pending", startedAt: null, finishedAt: null, durationSeconds: null
      })')"

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
# When the running phase began, in SECONDS. Set by phase_start, read by
# phase_ok and phase_fail to work out how long the phase took.
PHASE_T0=0

phase_start() {
  local name="$1"
  PHASE_T0="${SECONDS}"
  echo "::phase::${name}::start"
  log "===== phase: ${name} ====="
  status_set "
    .phase = \"${name}\"
    | (.phases[] | select(.name == \"${name}\") | .state)     = \"running\"
    | (.phases[] | select(.name == \"${name}\") | .startedAt) = \"$(now)\"
  "
}

phase_ok() {
  local name="$1" elapsed=$(( SECONDS - PHASE_T0 ))
  # The duration is a fourth field on the marker. Parsers that only read the
  # event - including an older UI against a newer image - ignore it.
  echo "::phase::${name}::ok::${elapsed}"
  log "===== phase ${name} done in $(hms "${elapsed}") ====="
  status_set "
    (.phases[] | select(.name == \"${name}\") | .state)      = \"success\"
    | (.phases[] | select(.name == \"${name}\") | .finishedAt) = \"$(now)\"
    | (.phases[] | select(.name == \"${name}\") | .durationSeconds) = ${elapsed}
  "
}

phase_skip() {
  local name="$1" reason="${2:-}"
  echo "::phase::${name}::skip"
  log "skipping ${name}${reason:+ (${reason})}"
  status_set "(.phases[] | select(.name == \"${name}\") | .state) = \"skipped\""
}

phase_fail() {
  local name="$1" message="$2" tmp elapsed=$(( SECONDS - PHASE_T0 ))
  echo "::phase::${name}::fail::${elapsed}"
  log "===== phase ${name} FAILED after $(hms "${elapsed}") ====="
  tmp="$(mktemp)"
  jq \
    --arg name "${name}" \
    --arg msg "${message}" \
    --arg ts "$(now)" \
    --argjson elapsed "${elapsed}" \
    '
      .state      = "failed"
      | .error      = $msg
      | .finishedAt = $ts
      | (.phases[] | select(.name == $name) | .state)      = "failed"
      | (.phases[] | select(.name == $name) | .finishedAt) = $ts
      | (.phases[] | select(.name == $name) | .durationSeconds) = $elapsed
    ' "${STATUS_FILE}" > "${tmp}"
  mv "${tmp}" "${STATUS_FILE}"
}

# The table printed at the end of every build, successful or not.
#
# Reads back what each phase recorded rather than re-deriving it, so what the
# log says and what status.json says can never drift apart.
timing_summary() {
  local total="$1"

  local name state seconds

  log "===== timing ====="
  # Tab-separated so the shell can format it; phase names never contain tabs.
  while IFS=$'\t' read -r name state seconds; do
    case "${state}" in
      skipped) log "$(printf '  %-18s %s' "${name}" 'skipped')" ;;
      *)
        if [ "${seconds}" = "null" ]; then
          log "$(printf '  %-18s %s' "${name}" '-')"
        else
          log "$(printf '  %-18s %s' "${name}" "$(hms "${seconds}")")"
        fi
        ;;
    esac
  done < <(jq -r '.phases[] | [.name, .state, (.durationSeconds // "null")] | @tsv' "${STATUS_FILE}")

  log "  ----------------------------------"
  log "$(printf '  %-18s %s' 'total' "$(hms "${total}")")"
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

# Point both package managers at a registry.
#
# These have to move together. yarn 1 resolves packages through npm's config,
# so `registry=` in ~/.npmrc wins over `registry` in .yarnrc - while
# `yarn config get registry` still reports the yarn one, so the config looks
# right and isn't. Setting only yarn's made the switch to Verdaccio a silent
# no-op: `yarn add @rancher/shell@99.99.99` went to npmjs, which has no such
# version, forty minutes into a build.
use_registry() {
  yarn config set registry "$1" >/dev/null
  npm config set registry "$1" >/dev/null
}

# Rewrite "version" in a package.json. Same sed the upstream scripts use, so the
# same set of pre-release suffixes is recognised.
set_pkg_version() {
  local file="$1" version="$2"
  sed -i -E "s/\"version\": \"[0-9]+\.[0-9]+\.[0-9]+(-alpha\.[0-9]+|-release[0-9]+\.[0-9]+\.[0-9]+|-rc\.[0-9]+)?\",/\"version\": \"${version}\",/" "${file}"
}
