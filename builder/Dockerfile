# Builder image for the Rancher Extensions Builder.
#
# Runs as a Kubernetes Job in the local cluster. Clones rancher/dashboard at a
# given PR (or ref), publishes the shell packages to an in-pod Verdaccio, builds
# the requested extensions against them, and assembles a Helm repository that is
# then served to Rancher as a catalog.cattle.io.clusterrepo.
#
# Node version must track rancher/dashboard's .nvmrc (currently 24). nvm is also
# installed so an extension repo pinning a different version can be honoured.

FROM node:24-bookworm

ARG HELM_VERSION=v3.16.3
ARG YQ_VERSION=v4.44.3
ARG NVM_VERSION=v0.40.3

ENV DEBIAN_FRONTEND=noninteractive \
    NVM_DIR=/usr/local/nvm \
    NUXT_TELEMETRY_DISABLED=1 \
    # Verdaccio and the dashboard build are both memory hungry.
    NODE_OPTIONS=--max_old_space_size=4096

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git ca-certificates curl jq tar gzip bash python3 \
      # node-gyp still gets pulled in by some extension dependency trees
      build-essential \
 && rm -rf /var/lib/apt/lists/*

# helm - used to package the ui-plugin-server chart and build the repo index
RUN curl -fsSL "https://get.helm.sh/helm-${HELM_VERSION}-linux-amd64.tar.gz" \
      | tar -xz -C /tmp \
 && mv /tmp/linux-amd64/helm /usr/local/bin/helm \
 && rm -rf /tmp/linux-amd64 \
 && helm version --short

# yq - the upstream chart patch script (shell/scripts/extension/helm/scripts/patch)
# requires the Go implementation, not the python one.
RUN curl -fsSL "https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/yq_linux_amd64" \
      -o /usr/local/bin/yq \
 && chmod +x /usr/local/bin/yq \
 && yq --version

# nvm, so an extension repo with its own .nvmrc can be built on the version it expects
RUN mkdir -p "${NVM_DIR}" \
 && curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh" | bash

RUN npm install -g verdaccio@6 \
 && npm cache clean --force

COPY lib/        /opt/builder/lib/
COPY phases/     /opt/builder/phases/
COPY entrypoint.sh verdaccio.yaml /opt/builder/

RUN chmod +x /opt/builder/entrypoint.sh /opt/builder/phases/*.sh

# /config/build.json  - the build spec, mounted from a ConfigMap
# /srv/repo           - the Helm repo + extension assets, mounted from a PVC
# /work               - scratch (clones, node_modules, verdaccio storage)
VOLUME ["/srv/repo", "/work"]

ENTRYPOINT ["/opt/builder/entrypoint.sh"]
