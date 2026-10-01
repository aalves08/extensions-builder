#!/usr/bin/env bash
# Phase: package
#
# Turn the built extensions into a Helm repository that Rancher can consume as
# a catalog.cattle.io.clusterrepo.
#
# ---------------------------------------------------------------------------
# UPSTREAM COUPLING - read this before changing anything here.
#
# This reproduces the directory layout that rancher/dashboard builds in
#   shell/scripts/extension/publish   (chart generation, index)
#   shell/scripts/extension/bundle    (the served directory layout)
#   shell/scripts/extension/helmpatch (Chart.yaml annotations + endpoints)
#
# We do not just call `publish -c` because:
#   - it ends with `rm -rf ${TMP}`, destroying the assembled directory we want;
#   - it uses `md5 -q`, which is macOS-only and not present on Linux;
#   - we need the UIPlugin endpoint to point at this build's Service, which
#     helmpatch derives from a container image name we never build.
#
# Layout produced in ${OUT_DIR}:
#   index.yaml                      helm index, chart urls relative: plugin/<pkg>/<pkg>-<ver>.tgz
#   plugin/index.yaml               same index
#   plugin/<pkg>/<pkg>-<ver>.tgz    the helm chart
#   plugin/<pkg>-<ver>.tgz          compressed extension, contains <ver>/plugin/...
#   plugin/<pkg>-<ver>/files.txt    paths relative to this dir, i.e. "plugin/..."
#   plugin/<pkg>-<ver>/plugin/...   the built extension
#
# ClusterRepo url      -> <serviceUrl>/
# UIPlugin endpoint    -> <serviceUrl>/plugin/<pkg>-<ver>
# ---------------------------------------------------------------------------

set -euo pipefail

SERVICE_URL="$(cfg '.repo.serviceUrl')"
[ -n "${SERVICE_URL}" ] || die "spec is missing .repo.serviceUrl"
SERVICE_URL="${SERVICE_URL%/}"

STAGE="${WORK_DIR}/stage"
rm -rf "${STAGE}"
mkdir -p "${STAGE}/assets" "${STAGE}/charts" "${STAGE}/extensions"

PKG_COUNT="$(jq '.packages | length' "${STATUS_FILE}")"
[ "${PKG_COUNT}" -gt 0 ] || die "nothing was built, refusing to publish an empty repo"

for i in $(seq 0 $((PKG_COUNT - 1))); do
  pkg="$(jq -r ".packages[${i}].name"    "${STATUS_FILE}")"
  version="$(jq -r ".packages[${i}].version" "${STATUS_FILE}")"
  dist="$(jq -r ".packages[${i}].dist"    "${STATUS_FILE}")"
  source_dir="$(jq -r ".packages[${i}].source" "${STATUS_FILE}")"

  pkg_json="${source_dir}/pkg/${pkg}/package.json"
  endpoint="${SERVICE_URL}/plugin/${pkg}-${version}"

  log "--- packaging ${pkg}-${version} ---"

  # -- extension payload ------------------------------------------------------
  # Staged as extensions/<pkg>/<ver>/plugin/... so the tarball's top-level entry
  # is the bare version, exactly as `publish` produces it.
  ext_stage="${STAGE}/extensions/${pkg}/${version}"
  mkdir -p "${ext_stage}/plugin"
  cp -R "${dist}/." "${ext_stage}/plugin/"
  rm -f "${ext_stage}/plugin/report.html"

  ( cd "${ext_stage}" && find plugin -type f | sort > files.txt )
  log "  $(wc -l < "${ext_stage}/files.txt") file(s) in the plugin payload"

  tar -czf "${STAGE}/extensions/${pkg}/${version}.tgz" \
      -C "${STAGE}/extensions/${pkg}" "${version}"

  # -- helm chart -------------------------------------------------------------
  # The chart template ships inside the @rancher/shell we just built, so the
  # chart always matches the shell under test.
  template="${source_dir}/node_modules/@rancher/shell/scripts/extension/helm"
  [ -d "${template}/charts/ui-plugin-server" ] \
    || die "no ui-plugin-server chart template at ${template} - did the shell install succeed?"

  chart_dir="${STAGE}/charts/${pkg}/${version}"
  mkdir -p "${chart_dir}"
  cp -R "${template}/charts/ui-plugin-server/." "${chart_dir}/"

  # Upstream's patch script: name/version/description/icon/keywords/home onto
  # Chart.yaml and rancher.annotations onto values.yaml .plugin.metadata.
  log "  patching chart from ${pkg}/package.json"
  CHART="${chart_dir}" \
  PACKAGE_JSON="${pkg_json}" \
  REGISTRY="" \
  ORG="rancher" \
    "${template}/scripts/patch"

  # helmpatch's job, done with yq so we don't depend on resolving js-yaml, and
  # so we control the endpoint rather than letting it derive an image-based one.
  if jq -e '.rancher.annotations | objects' "${pkg_json}" >/dev/null 2>&1; then
    while IFS= read -r entry; do
      key="$(jq -r '.key'   <<< "${entry}")"
      value="$(jq -r '.value' <<< "${entry}")"
      yq -i ".annotations[\"${key}\"] = \"${value}\"" "${chart_dir}/Chart.yaml"
    done < <(jq -c '.rancher.annotations | to_entries[]' "${pkg_json}")
    log "  carried over $(jq '.rancher.annotations | length' "${pkg_json}") rancher annotation(s)"
  fi

  yq -i ".plugin.endpoint = \"${endpoint}\"" "${chart_dir}/values.yaml"
  yq -i ".plugin.compressedEndpoint = \"${endpoint}.tgz\"" "${chart_dir}/values.yaml"
  # This build is throwaway and gets rebuilt under the same name, so never let
  # Rancher serve a stale cached copy of the extension.
  yq -i '.plugin.noCache = true' "${chart_dir}/values.yaml"

  if [ -f "${source_dir}/pkg/${pkg}/README.md" ]; then
    cp "${source_dir}/pkg/${pkg}/README.md" "${chart_dir}/README.md"
  fi

  mkdir -p "${STAGE}/assets/${pkg}"
  helm package "${chart_dir}" -d "${STAGE}/assets/${pkg}" >/dev/null \
    || die "helm package failed for ${pkg}-${version}"
  log "  chart packaged, endpoint ${endpoint}"
done

# -- repo index ----------------------------------------------------------------
# --url plugin/ makes the chart urls relative to the served root, matching where
# we copy the assets below.
log "building helm repo index"
helm repo index "${STAGE}/assets" --url plugin/

# -- assemble the served directory ---------------------------------------------
log "assembling ${OUT_DIR}"
mkdir -p "${OUT_DIR}/plugin"

cp -R "${STAGE}/assets/." "${OUT_DIR}/plugin/"
cp "${STAGE}/assets/index.yaml" "${OUT_DIR}/index.yaml"

for i in $(seq 0 $((PKG_COUNT - 1))); do
  pkg="$(jq -r ".packages[${i}].name"    "${STATUS_FILE}")"
  version="$(jq -r ".packages[${i}].version" "${STATUS_FILE}")"

  cp "${STAGE}/extensions/${pkg}/${version}.tgz" "${OUT_DIR}/plugin/${pkg}-${version}.tgz"
  cp -R "${STAGE}/extensions/${pkg}/${version}" "${OUT_DIR}/plugin/${pkg}-${version}"
done

# -- verify --------------------------------------------------------------------
# Cheap, but it catches a silently empty index, which otherwise shows up much
# later as a ClusterRepo that syncs fine and offers nothing.
log "verifying the repository"
entries="$(yq '.entries | keys | .[]' "${OUT_DIR}/index.yaml" | tr -d '"')"
for i in $(seq 0 $((PKG_COUNT - 1))); do
  pkg="$(jq -r ".packages[${i}].name"    "${STATUS_FILE}")"
  version="$(jq -r ".packages[${i}].version" "${STATUS_FILE}")"

  grep -qx "${pkg}" <<< "${entries}" \
    || die "index.yaml has no entry for ${pkg}"
  [ -f "${OUT_DIR}/plugin/${pkg}/${pkg}-${version}.tgz" ] \
    || die "missing chart archive plugin/${pkg}/${pkg}-${version}.tgz"
  [ -f "${OUT_DIR}/plugin/${pkg}-${version}/files.txt" ] \
    || die "missing plugin/${pkg}-${version}/files.txt"
  log "  ok ${pkg}-${version}"
done

log "repository ready: $(yq '.entries | length' "${OUT_DIR}/index.yaml") chart(s)"
