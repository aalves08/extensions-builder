#!/usr/bin/env bash
# Phase: publish-shell
#
# Stand up Verdaccio and publish @rancher/shell, @rancher/components and the
# extension creator from the checked-out PR, all as version 99.99.99.
#
# This mirrors shell/scripts/test-plugins-build.sh and the "Publish shell to
# Verdaccio" step of .github/workflows/extension-compatibility-test.yml in
# rancher/dashboard. Two differences, both deliberate:
#
#   1. Auth. Upstream creates an htpasswd admin and exchanges a real token. Our
#      registry is pod-local and open, so we just write a dummy _authToken -
#      npm refuses to publish without *some* auth config, even to an open registry.
#   2. DRY_RUN. publish-shell.sh evaluates `[ ${DRY_RUN} == "true" ]` unquoted
#      under `set -eo pipefail`. With DRY_RUN unset that expands to
#      `[ == "true" ]`, which is a bash syntax error and kills the script. It
#      MUST be exported, even just to "false".

set -euo pipefail

cd "${DASHBOARD_DIR}"

# --- Verdaccio ----------------------------------------------------------------
mkdir -p "${WORK_DIR}/verdaccio/storage"

log "starting verdaccio"
verdaccio --config /opt/builder/verdaccio.yaml > "${WORK_DIR}/verdaccio.log" 2>&1 &
VERDACCIO_PID=$!

for i in $(seq 1 60); do
  if curl -sf "${VERDACCIO_REGISTRY}/-/ping" >/dev/null 2>&1; then
    log "verdaccio is up (pid ${VERDACCIO_PID})"
    break
  fi
  if ! kill -0 "${VERDACCIO_PID}" 2>/dev/null; then
    cat "${WORK_DIR}/verdaccio.log" >&2
    die "verdaccio exited during startup"
  fi
  [ "${i}" -eq 60 ] && { cat "${WORK_DIR}/verdaccio.log" >&2; die "verdaccio did not become ready"; }
  sleep 1
done

cat > "${HOME}/.npmrc" <<EOF
//localhost:4873/:_authToken="extensions-builder"
//127.0.0.1:4873/:_authToken="extensions-builder"
EOF

# --- Version bump -------------------------------------------------------------
# Upstream's comment explains why: Verdaccio is a read-through cache, so
# publishing a version that already exists on npmjs fails. 99.99.99 never will.
log "pinning shell packages to ${SHELL_VERSION}"
set_pkg_version "${DASHBOARD_DIR}/shell/package.json"                  "${SHELL_VERSION}"
set_pkg_version "${DASHBOARD_DIR}/pkg/rancher-components/package.json" "${SHELL_VERSION}"
set_pkg_version "${DASHBOARD_DIR}/creators/extension/package.json"     "${SHELL_VERSION}"

# --- Dependencies -------------------------------------------------------------
log "installing dashboard dependencies (this is the slow one)"
yarn_registry "${DEFAULT_NPM_REGISTRY}"
yarn install --frozen-lockfile --ignore-engines

# --- Publish ------------------------------------------------------------------
export NPM_REGISTRY="${VERDACCIO_REGISTRY}"
export DRY_RUN="false"   # see header - not optional

log "publishing @rancher/shell@${SHELL_VERSION}"
TAG="shell-pkg-v${SHELL_VERSION}" ./shell/scripts/publish-shell.sh

log "publishing @rancher/create-extension@${SHELL_VERSION}"
TAG="creators-pkg-v${SHELL_VERSION}" ./shell/scripts/publish-shell.sh

log "building and publishing @rancher/components@${SHELL_VERSION}"
yarn build:lib
npm_registry "${VERDACCIO_REGISTRY}"
yarn_registry "${VERDACCIO_REGISTRY}"
yarn publish:lib

# Leave the default registry in place for the extension installs that follow;
# 40-build-extensions.sh flips to Verdaccio only for the shell upgrade itself.
yarn_registry "${DEFAULT_NPM_REGISTRY}"
npm_registry "${DEFAULT_NPM_REGISTRY}"

log "verifying the registry serves the published versions"
for pkg in "@rancher/shell" "@rancher/components"; do
  if curl -sf "${VERDACCIO_REGISTRY}/${pkg//\//%2f}/${SHELL_VERSION}" >/dev/null; then
    log "  ok ${pkg}@${SHELL_VERSION}"
  else
    die "${pkg}@${SHELL_VERSION} was not published - check the verdaccio log above"
  fi
done
