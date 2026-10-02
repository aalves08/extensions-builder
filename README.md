# Extensions Builder

A Rancher UI Extension that builds `@rancher/shell` from a `rancher/dashboard`
pull request, builds a set of extensions against it, and serves the result as a
repository you can install from — all from inside Rancher, in a few clicks.

## Why

Breaking changes to the extensions architecture (`@rancher/shell`,
`@rancher/components`, `creators`) are expensive to validate. Today the signal
is `shell/scripts/test-plugins-build.sh` and the `extension-compatibility-test`
workflow: both CI-only, and both answer *"does it still compile?"* rather than
*"does it still work?"*.

A developer who wants to actually click around an extension built against their
shell change has to reproduce that whole Verdaccio dance by hand. This turns it
into a form: give it a PR number, pick some extensions, wait, install.

## What it does

1. You submit a build from **Extensions Builder → New build**: a dashboard PR
   (or branch, or fork), and the extensions to build against it.
2. The extension writes the build spec to a ConfigMap and creates a Kubernetes
   Job running the [builder image](builder/README.md). Nothing is built in the
   browser.
3. The Job clones the dashboard at that revision, publishes the shell packages
   to a Verdaccio registry inside its own pod as `99.99.99`, then clones each
   extension, points it at Verdaccio and runs `yarn build-pkg`.
4. The output is assembled into a Helm repository on a volume, which an nginx
   Deployment then serves.
5. **Publish catalog** registers that as a `catalog.cattle.io.clusterrepo`, so
   the extensions show up under Apps → Extensions like any others.

Expect 20–40 minutes for a build. The UI is built around that: nothing has to
stay open, and the build log is reachable at any point from the build's page.

## Requirements

- Rancher 2.12 or newer, and an administrator account — builds create
  cluster-scoped resources.
- A default StorageClass in the local cluster. Without one the build pod waits
  on its volume forever, so the New Build form blocks on this and offers to fix
  it (it can create `local-path`, or mark an existing class as default).
- Egress from the cluster to github.com and registry.npmjs.org. Airgapped
  clusters are out of scope.

Everything else — the `cattle-extensions-builder` namespace and the nginx
config the repo pod mounts — is created by the extension itself the first time
it needs it.

## Installing it

Cut a GitHub release, and `.github/workflows/build-extension-charts.yml`
publishes the chart to the `gh-pages` branch. Add
`https://aalves08.github.io/extensions-builder` as a repository under Apps →
Repositories, and the extension appears under Extensions.

To run it without releasing anything:

```bash
yarn install
yarn dev
```

Then open the dev server against your Rancher as usual — see
[the extension developer docs](https://extensions.rancher.io/extensions/next/extensions-getting-started)
for the `API` environment variable and the rest of the setup.

## Testing against an older Rancher

This is the case the builder exists for, and it needs two Ranchers: the one with
your change in it, and an older one without.

Tick **External access** on the New Build form. The hostname is pre-filled from
this Rancher's `server-url` — the address it tells its agents to call back on,
so it routes in by definition. When the build is published, the repository is
exposed at `https://<host>/extensions-builder/<build id>/` through an Ingress,
alongside the cluster-internal route the local install uses.

Copy that URL off the build's page and add it as a repository on any other
Rancher, 2.12 or 2.15, local or remuda-provisioned. The same build, installed
in both places.

Two things to know:

- The address is **baked into the packaged charts** at build time, not at
  publish time — each chart carries a single `plugin.endpoint`, and whichever
  Rancher installs it fetches the extension from there. So it cannot be changed
  after the build starts. If the hostname turns out to be wrong, start another
  build.
- The option is disabled, with the reason shown, when this Rancher has no
  address that could work: a `localhost` address, or one on a port other than
  80/443 (an ingress controller serves those two and nothing else, and an
  Ingress rule cannot carry a port in its hostname). A Rancher started with
  `docker run rancher/rancher` is the common case — it publishes a port straight
  off the container, and nothing an Ingress inside its embedded k3s does will
  ever be seen.

An older Rancher will also refuse to install an extension whose
`catalog.cattle.io/rancher-version` annotation excludes its own version. That
annotation comes from the extension's own `package.json` and is copied through
verbatim, so a chart that shows up but will not install is usually this.

## Host UI

A build can optionally include the dashboard UI itself, and the build's page
can point `ui-dashboard-index` at it. An extension compiled against a brand-new
shell API can still fail at runtime inside a stock host, which is the gap this
closes.

It is off by default and currently hidden behind `DASHBOARD_BUILD_ENABLED` in
[`config/builder.ts`](pkg/extensions-builder/config/builder.ts). It also
rewrites a global setting, so it is on its own card with its own revert.

## Layout

| Path | What |
|---|---|
| `pkg/extensions-builder/` | the UI extension |
| `pkg/extensions-builder/pages/` | the two screens: build list, new build |
| `pkg/extensions-builder/utils/` | everything with logic in it, and where the unit tests point |
| `pkg/extensions-builder/config/builder.ts` | names, labels, image, phase list — the constants both halves agree on |
| `pkg/extensions-builder/types.ts` | the `BuildSpec` the UI writes and the builder reads |
| `builder/` | the container that does the work — [see its README](builder/README.md) |
| `.github/workflows/` | builder image on every push to `main`; extension chart and catalog on release |

`types.ts` and the phase scripts under `builder/phases/` are two halves of one
contract. The scripts read the spec with `jq`, so renaming a field on one side
without the other produces a build that silently does the wrong thing.

## Development

```bash
yarn test          # jest, over utils/
yarn check-types   # tsc --noEmit
yarn lint          # eslint, zero warnings tolerated
yarn build-pkg extensions-builder
```

All four have to pass. The fastest loop for anything inside the container is to
run the image directly rather than through Rancher — `builder/README.md` has the
docker invocation, including how to re-run a single phase against an existing
`/work`.
