#!/usr/bin/env bash
# Phase: resolve
#
# Clone rancher/dashboard and check out the PR (or ref) under test.
#
# We deliberately do NOT use --depth here: a shallow clone cannot fetch
# refs/pull/<n>/head afterwards. --filter=blob:none gives us the same "don't
# download the history" win while keeping every ref reachable.

set -euo pipefail

SHELL_REPO="$(cfg '.shell.repo')"
SHELL_PR="$(cfg '.shell.pr // empty')"
SHELL_REF="$(cfg '.shell.ref // empty')"

[ -n "${SHELL_REPO}" ] || die "spec is missing .shell.repo"

rm -rf "${DASHBOARD_DIR}"
log "cloning ${SHELL_REPO}"
git clone --filter=blob:none --no-checkout "${SHELL_REPO}" "${DASHBOARD_DIR}"

cd "${DASHBOARD_DIR}"

if [ -n "${SHELL_PR}" ]; then
  log "fetching pull request #${SHELL_PR}"
  git fetch origin "pull/${SHELL_PR}/head:pr-${SHELL_PR}" \
    || die "could not fetch PR #${SHELL_PR} from ${SHELL_REPO} - does it exist and is the repo public?"
  git checkout "pr-${SHELL_PR}"
  RESOLVED_REF="pull/${SHELL_PR}/head"
elif [ -n "${SHELL_REF}" ]; then
  log "checking out ref ${SHELL_REF}"
  git fetch origin "${SHELL_REF}" || true
  git checkout "${SHELL_REF}" \
    || die "could not check out '${SHELL_REF}' in ${SHELL_REPO}"
  RESOLVED_REF="${SHELL_REF}"
else
  die "spec must set either .shell.pr or .shell.ref"
fi

SHELL_SHA="$(git rev-parse HEAD)"
log "resolved to ${SHELL_SHA}"
log "  $(git log -1 --pretty='%s')"

# The UI reads this from the pod log. status.json lives on the output volume,
# which only nginx inside the cluster can see - the browser cannot.
echo "::shell::${SHELL_SHA}::${RESOLVED_REF}"

# The shell must be built on the Node version the dashboard expects. The image
# tracks that version, but a PR could move .nvmrc out from under us.
if [ -f .nvmrc ]; then
  want="$(tr -d ' \tv\r\n' < .nvmrc)"
  have="$(node -v | tr -d 'v')"
  if [[ "${have}" != "${want}"* ]]; then
    warn "dashboard .nvmrc wants node ${want} but the image has ${have}"
    warn "switching via nvm - rebuild the builder image to make this permanent"
    use_node_for_dir "${DASHBOARD_DIR}"
  fi
fi

tmp="$(mktemp)"
jq --arg sha "${SHELL_SHA}" --arg ref "${RESOLVED_REF}" \
  '.shellSha = $sha | .shellRef = $ref' "${STATUS_FILE}" > "${tmp}"
mv "${tmp}" "${STATUS_FILE}"
