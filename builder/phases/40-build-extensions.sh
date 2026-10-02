#!/usr/bin/env bash
# Phase: build-extensions
#
# For each requested extension: clone, install on the public registry, swap
# @rancher/shell for the 99.99.99 build from the PR, then build-pkg.
#
# The two-registry dance matters. Installing the whole dependency tree through
# Verdaccio is slow and flaky (it proxies every single package), so we resolve
# everything from npmjs first and only switch to Verdaccio for the one
# `yarn add @rancher/shell` that has to come from the local build. This is what
# test-plugins-build.sh does too.

set -euo pipefail

EXT_COUNT="$(cfg '.extensions | length')"

for i in $(seq 0 $((EXT_COUNT - 1))); do
  name="$(cfg ".extensions[${i}].name")"
  repo="$(cfg ".extensions[${i}].repo")"
  ref="$(cfg ".extensions[${i}].ref // empty")"
  pkg="$(cfg ".extensions[${i}].pkg")"

  [ -n "${repo}" ] || die "extension '${name}' has no repo"
  [ -n "${pkg}" ]  || die "extension '${name}' has no pkg (the folder name under pkg/)"

  dir="${EXTENSIONS_DIR}/${name}"

  log "--- ${name} (${repo}${ref:+ @ ${ref}}, pkg/${pkg}) ---"

  ext_t0="${SECONDS}"

  rm -rf "${dir}"
  if [ -n "${ref}" ]; then
    timed "clone ${name}" \
      git clone --filter=blob:none --branch "${ref}" "${repo}" "${dir}" \
      || die "could not clone ${repo} at ref '${ref}'"
  else
    timed "clone ${name}" \
      git clone --filter=blob:none "${repo}" "${dir}" \
      || die "could not clone ${repo}"
  fi

  cd "${dir}"
  log "${name} at $(git rev-parse HEAD)"

  [ -d "pkg/${pkg}" ] \
    || die "'${repo}' has no pkg/${pkg} - check the package name for ${name}"

  use_node_for_dir "${dir}"

  # Some extensions carry a pre-release suffix on the package version. The chart
  # version has to be valid semver for `helm package`, and upstream's
  # compatibility workflow strips it here too.
  if [ -f "pkg/${pkg}/package.json" ]; then
    sed -i -E 's/("version": "[0-9]+\.[0-9]+\.[0-9]+)-[^"]*"/\1"/' "pkg/${pkg}/package.json"
  fi

  use_registry "${DEFAULT_NPM_REGISTRY}"
  if [ -f yarn.lock ]; then
    timed "${name} yarn install" \
      yarn install --frozen-lockfile --ignore-engines \
      || die "yarn install failed for ${name}"
  else
    timed "${name} yarn install (no lockfile)" \
      yarn install --ignore-engines \
      || die "yarn install failed for ${name}"
  fi

  use_registry "${VERDACCIO_REGISTRY}"
  sed -i -E "s|(\"@rancher/shell\": \")[^\"]+(\")|\1${SHELL_VERSION}\2|" package.json
  timed "${name} swap in @rancher/shell@${SHELL_VERSION} from the PR build" \
    yarn add "@rancher/shell@${SHELL_VERSION}" -W --ignore-engines \
    || die "could not install @rancher/shell@${SHELL_VERSION} into ${name}"
  use_registry "${DEFAULT_NPM_REGISTRY}"

  # From node_modules, not package.json: the sed above rewrote package.json, so
  # reading it back only ever confirms our own edit. This is the check that
  # catches the PR build silently not being used at all.
  installed="$(jq -r '.version' "${dir}/node_modules/@rancher/shell/package.json" 2>/dev/null || echo '?')"
  [ "${installed}" = "${SHELL_VERSION}" ] \
    || die "${name} resolved @rancher/shell@${installed}, not ${SHELL_VERSION} - the PR build was not used"
  log "${name} is building against @rancher/shell@${installed}"

  timed "${name} build-pkg ${pkg}" \
    env FORCE_COLOR=0 yarn build-pkg "${pkg}" \
    || die "build-pkg failed for ${name} (pkg/${pkg}) - this is the signal you are looking for"

  version="$(jq -r '.version' "pkg/${pkg}/package.json")"
  dist="${dir}/dist-pkg/${pkg}-${version}"
  [ -d "${dist}" ] || die "expected build output at ${dist}, but it is not there"

  log "built ${pkg}-${version} - ${name} took $(hms $(( SECONDS - ext_t0 ))) end to end"

  # Read out of the pod log by the UI, which cannot reach status.json.
  echo "::package::${pkg}::${version}"

  tmp="$(mktemp)"
  jq \
    --arg name "${pkg}" \
    --arg version "${version}" \
    --arg repo "${repo}" \
    --arg dist "${dist}" \
    --arg dir "${dir}" \
    '.packages += [{
       name: $name, version: $version, repo: $repo, dist: $dist, source: $dir
     }]' "${STATUS_FILE}" > "${tmp}"
  mv "${tmp}" "${STATUS_FILE}"
done

log "all ${EXT_COUNT} extension(s) built"
