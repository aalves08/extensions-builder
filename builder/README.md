# The builder image

This is the container that does the actual work. The UI extension in
`pkg/extensions-builder` never builds anything itself — it writes a build spec
into a ConfigMap, creates a Job that runs this image, and then watches the pod
log.

Published as `ghcr.io/aalves08/extensions-builder-image:head` by
`.github/workflows/build-builder-image.yml`, on every push to `main` that
touches `builder/`.

## What it does

Given a `rancher/dashboard` PR number (or any branch/tag/fork), it:

1. clones the dashboard at that revision,
2. publishes `@rancher/shell`, `@rancher/components` and the extension creator
   to a Verdaccio registry running inside the same pod, all as version
   `99.99.99`,
3. optionally builds the dashboard UI itself from the same source,
4. clones each requested extension, points it at Verdaccio, pulls in
   `@rancher/shell@99.99.99`, and runs `yarn build-pkg`,
5. assembles everything into a Helm repository on `/srv/repo`.

Step 5 is the point of the whole thing: that directory is then mounted by an
nginx Deployment and registered with Rancher as a `catalog.cattle.io.clusterrepo`,
so the extensions can be installed from Apps → Extensions like any other.

This mirrors what `extension-compatibility-test.yml` does in dashboard CI, with
one difference that matters: CI only asks "does it still compile?", whereas this
gets you an installable extension you can click around in.

## Mount points

| Path | What | Source in-cluster |
|---|---|---|
| `/config/build.json` | the build spec | ConfigMap `extensions-builder-<id>` |
| `/srv/repo` | the Helm repo and extension assets | PVC `extensions-builder-<id>` |
| `/work` | scratch: clones, `node_modules`, Verdaccio storage | `emptyDir`, 30Gi limit |

`/work` gets large — a dashboard checkout plus a `node_modules` per extension —
which is why its `sizeLimit` is set so much higher than the 5Gi output PVC.

## The build spec

`/config/build.json` is a serialised `BuildSpec` from
[`pkg/extensions-builder/types.ts`](../pkg/extensions-builder/types.ts). The
phase scripts read these fields with `jq`, so **the two have to be kept in step** —
renaming a field in the TypeScript interface without changing the scripts will
produce a build that silently does the wrong thing.

```json
{
  "buildId": "pr13579-a1b2",
  "shell": {
    "repo": "https://github.com/rancher/dashboard.git",
    "pr": 13579,
    "ref": null
  },
  "buildDashboard": false,
  "extensions": [
    {
      "name": "kubewarden",
      "repo": "https://github.com/rancher/kubewarden-ui.git",
      "ref": "",
      "pkg": "kubewarden",
      "official": true
    }
  ],
  "repo": {
    "serviceUrl": "http://10.43.1.74:8080"
  }
}
```

A few notes on the fields that are easy to get wrong:

- `shell.pr` is fetched as `refs/pull/<n>/head`, which works for PRs from forks
  too. Set either `pr` or `ref`, not both — `pr` wins if you set both.
- `extensions[].ref` empty means "the repo's default branch". The `branch` field
  in `ui-plugin-charts/manifest.json` is `gh-pages`, which holds the published
  charts rather than source, so it is deliberately *not* used here.
- `extensions[].name` doubles as the clone directory name, so it has to be
  unique within a build.
- `repo.serviceUrl` is baked into each chart's `plugin.endpoint`, and the
  builder treats it as an opaque string — whatever you pass is what ends up in
  the charts. Cluster-internal is fine here: the browser never fetches this,
  Rancher proxies extension assets server-side through `/v1/uiplugins/...`.
  The UI passes the repo Service's **ClusterIP** rather than its
  `<svc>.<ns>.svc` name, because the thing doing the fetching is the Rancher
  process, and a Rancher running outside the cluster — `docker run
  rancher/rancher`, as every local dev setup does — resolves names against its
  container's DNS, which knows nothing about cluster services. It can still
  route to the service network, so an IP works where the name does not. If you
  run the image by hand, any URL your Rancher can reach will do.
- `dashboard.publicUrl` (only when `buildDashboard` is true) is the opposite
  case — the dashboard bundle *is* fetched by the browser, so this must be a URL
  the browser can actually reach, which is why the UI asks for an Ingress host.

## Log markers

`status.json` on the output volume is the richer record, but the browser cannot
reach it — it is served by an in-cluster nginx. So the pod log is the UI's only
live channel, and the phase scripts echo single-line markers into it that
[`utils/build-log.ts`](../pkg/extensions-builder/utils/build-log.ts) parses.

| Marker | Emitted by | Meaning |
|---|---|---|
| `::phase::<name>::start` | `lib/common.sh` | phase began |
| `::phase::<name>::ok` | `lib/common.sh` | phase finished |
| `::phase::<name>::skip` | `lib/common.sh` | phase deliberately not run |
| `::phase::<name>::fail` | `lib/common.sh` | phase failed |
| `::shell::<sha>::<ref>` | `phases/10-resolve.sh` | the dashboard revision actually built |
| `::package::<pkg>::<version>` | `phases/40-build-extensions.sh` | one extension built |
| `::dashboard::<index url>` | `phases/30-build-dashboard.sh` | where the host UI bundle is served |

`<name>` is one of `resolve`, `publish-shell`, `build-dashboard`,
`build-extensions`, `package` — the `PHASE_NAMES` array in `lib/common.sh`, in
that order. The UI renders its stepper from the same list, hard-coded as
`PHASES` in `config/builder.ts`.

The parser ignores markers it does not recognise, so adding a new one here will
not break an older extension build. Removing or renaming one will.

## Testing it standalone

By far the fastest loop. No cluster, no Rancher, no extension — just docker:

```bash
cd builder
docker build -t extensions-builder-image:dev .

cd /tmp && mkdir -p out && cat > spec.json <<'EOF'
{
  "buildId": "local-test",
  "shell": { "repo": "https://github.com/rancher/dashboard.git", "pr": null, "ref": "master" },
  "buildDashboard": false,
  "extensions": [
    { "name": "kubewarden", "repo": "https://github.com/rancher/kubewarden-ui.git", "ref": "", "pkg": "kubewarden", "official": true }
  ],
  "repo": { "serviceUrl": "http://localhost:8080" }
}
EOF

docker run --rm \
  -v "$PWD/out:/srv/repo" \
  -v "$PWD/spec.json:/config/build.json:ro" \
  extensions-builder-image:dev
```

Expect this to take 20–40 minutes. When it finishes:

```bash
jq '.state, .packages' out/status.json      # should be "success" and a non-empty list
cat out/index.yaml                          # should list each built chart
ls out/plugin/kubewarden-*/files.txt        # should exist
```

Then prove the repo is actually valid Helm before involving Rancher at all:

```bash
docker run --rm -d -p 8080:80 -v "$PWD/out:/usr/share/nginx/html:ro" --name eb-test nginx
helm repo add eb-test http://localhost:8080 && helm search repo eb-test
docker rm -f eb-test
```

To iterate on a single phase without re-running everything, mount the scripts
over the baked-in copies and reuse `/work`:

```bash
docker run --rm -it \
  -v "$PWD/out:/srv/repo" -v "$PWD/work:/work" \
  -v "$PWD/spec.json:/config/build.json:ro" \
  -v "$(git rev-parse --show-toplevel)/builder/phases:/opt/builder/phases:ro" \
  -v "$(git rev-parse --show-toplevel)/builder/lib:/opt/builder/lib:ro" \
  --entrypoint bash extensions-builder-image:dev
```

Inside the container, source the helpers and run a phase directly:

```bash
. /opt/builder/lib/common.sh && . /opt/builder/phases/50-package.sh
```

Note that `entrypoint.sh` wipes `/srv/repo` on every start — a re-run against a
dirty volume would otherwise leave an index advertising charts that are no
longer there.

## Upstream coupling, and two upstream bugs

`50-package.sh` reproduces the artifact layout defined by
`shell/scripts/extension/bundle` and `shell/scripts/extension/helmpatch` in
dashboard master. If that layout changes upstream, this breaks. The script names
the files it mirrors in a comment at the top.

Two upstream scripts could not be called directly, and the workarounds are worth
knowing about if you are debugging a failure here:

- **`shell/scripts/publish-shell.sh`** tests `[ ${DRY_RUN} == "true" ]` unquoted
  under `set -eo pipefail`. With `DRY_RUN` unset that expands to `[ == "true" ]`,
  a bash syntax error that aborts the script. `20-publish-shell.sh` works around
  it by exporting `DRY_RUN=false` explicitly.
- **`shell/scripts/extension/publish`** uses `md5 -q`, which only exists on
  macOS. This is the main reason `50-package.sh` does its own packaging rather
  than calling `publish` wholesale.

If either is fixed upstream, the corresponding workaround can go.

## Known constraints

- **Egress required.** The Job needs github.com and registry.npmjs.org.
  Airgapped clusters are out of scope.
- **Memory.** `NODE_OPTIONS=--max_old_space_size=4096` is set in the image, and
  the Job requests 2 CPU / 6Gi with a limit of 4 CPU / 10Gi. Building the
  dashboard UI on top of the extensions is what pushes it; an OOM kill shows up
  as a Job failure with no `::phase::fail` marker, which the UI handles by
  trusting the Job status over the log.
- **Node version.** The image is on Node 24, tracking dashboard's `.nvmrc`. nvm
  is installed as well, so an extension repo that pins a different version gets
  switched to it for its own build (`use_node_for_dir` in `lib/common.sh`).
