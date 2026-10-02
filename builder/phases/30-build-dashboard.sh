#!/usr/bin/env bash
# Phase: build-dashboard  (only when the host-UI toggle is on)
#
# Builds the dashboard itself from the same PR, so the extension under test runs
# inside a host that actually has the new shell APIs. Output goes to
# /srv/repo/dashboard and the UI points the `ui-dashboard-index` setting at it.
#
# Unlike the Helm repo and the UIPlugin endpoint - both fetched server-side by
# Rancher - the dashboard bundle is fetched by the BROWSER. A cluster-internal
# .svc URL will not work, so the spec carries a separate, externally reachable
# publicUrl (backed by an Ingress) and we bake it in as RESOURCE_BASE.
#
# ROUTER_BASE / RESOURCE_BASE / OUTPUT_DIR are read by shell/vue.config.js.

set -euo pipefail

PUBLIC_URL="$(cfg '.dashboard.publicUrl // empty')"
ROUTER_BASE_CFG="$(cfg '.dashboard.routerBase // "/dashboard"')"

[ -n "${PUBLIC_URL}" ] \
  || die "building the dashboard UI requires .dashboard.publicUrl (the browser-reachable URL the bundle will be served from)"

# RESOURCE_BASE becomes webpack's publicPath, which must end in a slash or the
# emitted asset URLs lose a path segment.
RESOURCE_BASE_URL="${PUBLIC_URL%/}/"

cd "${DASHBOARD_DIR}"

log "building dashboard UI"
log "  router base  : ${ROUTER_BASE_CFG}"
log "  resource base: ${RESOURCE_BASE_URL}"

timed "dashboard yarn build" \
  env ROUTER_BASE="${ROUTER_BASE_CFG}" \
      RESOURCE_BASE="${RESOURCE_BASE_URL}" \
      OUTPUT_DIR="dist" \
      NODE_OPTIONS="--max_old_space_size=4096" \
      yarn build

[ -f "${DASHBOARD_DIR}/dist/index.html" ] \
  || die "dashboard build produced no dist/index.html"

rm -rf "${OUT_DIR}/dashboard"
mkdir -p "${OUT_DIR}/dashboard"
timed "copy dashboard bundle into the repo volume" \
  cp -R "${DASHBOARD_DIR}/dist/." "${OUT_DIR}/dashboard/"

tmp="$(mktemp)"
jq --arg url "${RESOURCE_BASE_URL}index.html" \
  '.dashboard = true | .dashboardIndex = $url' "${STATUS_FILE}" > "${tmp}"
mv "${tmp}" "${STATUS_FILE}"

log "dashboard index will be served at ${RESOURCE_BASE_URL}index.html"

# Read out of the pod log by the UI, which cannot reach status.json.
echo "::dashboard::${RESOURCE_BASE_URL}index.html"
