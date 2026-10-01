/**
 * Constants shared across the extension.
 *
 * Anything here that also appears in builder/ is marked as such - those are the
 * values that have to be changed in two places at once.
 */

export const PRODUCT_NAME = 'extensions-builder';

/**
 * Rancher strips dashes out of a top-level product's name when it builds route
 * names (`plugin-products-top-level.ts`: `prodName.replaceAll('-', '')`), so the
 * routes are `extensionsbuilder-c-cluster-*`, not `extensions-builder-c-cluster-*`.
 * Deriving it rather than hard-coding it keeps the two in step.
 */
export const ROUTE_PRODUCT = PRODUCT_NAME.replace(/-/g, '');

export const ROUTE_BUILDS = `${ ROUTE_PRODUCT }-c-cluster-builds`;
export const ROUTE_NEW_BUILD = `${ ROUTE_PRODUCT }-c-cluster-new`;

/** Every build object lives here. Created from the New Build form when missing. */
export const NAMESPACE = 'cattle-extensions-builder';

/** Built and published by .github/workflows/build-builder-image.yml. */
export const BUILDER_IMAGE = 'ghcr.io/aalves08/extensions-builder-image:head';

/** Serves a finished build's output volume. Only has to serve static files. */
export const NGINX_IMAGE = 'nginx:1.27-alpine';
export const NGINX_PORT = 8080;
/** Shared by every build's repo pod. Created from the New Build form when missing. */
export const NGINX_CONFIGMAP = 'extensions-builder-nginx';

export const LABEL_BUILD_ID = 'extensions-builder.cattle.io/build-id';
export const LABEL_COMPONENT = 'app.kubernetes.io/component';
export const LABEL_MANAGED_BY = 'app.kubernetes.io/managed-by';
export const LABEL_NAME = 'app.kubernetes.io/name';
export const MANAGED_BY = 'extensions-builder';

export const COMPONENT_BUILD = 'build';
export const COMPONENT_REPO = 'repo';

/** The spec is stored on the ConfigMap so a build can be re-run or inspected later. */
export const ANNOTATION_SPEC = 'extensions-builder.cattle.io/spec';
/** Stashed before the host-UI swap so the revert can put the old value back. */
export const ANNOTATION_PREVIOUS_UI_INDEX = 'extensions-builder.cattle.io/previous-ui-dashboard-index';
export const ANNOTATION_PREVIOUS_UI_OFFLINE = 'extensions-builder.cattle.io/previous-ui-offline-preferred';

export const DASHBOARD_REPO = 'https://github.com/rancher/dashboard';
export const GITHUB_API = 'https://api.github.com';
export const MANIFEST_URL = 'https://raw.githubusercontent.com/rancher/ui-plugin-charts/main/manifest.json';

/**
 * Generous on purpose. A dashboard `yarn install` plus `yarn build`, plus a
 * `yarn install` per extension, realistically lands at 20-40 minutes; the host
 * UI toggle pushes that further. 90 minutes is "something is wrong", not "slow".
 */
export const BUILD_DEADLINE_SECONDS = 5400;

/** Resource requests/limits for the build pod. The dashboard build is the hungry part. */
export const BUILD_RESOURCES = {
  requests: { cpu: '2', memory: '6Gi' },
  limits:   { cpu: '4', memory: '10Gi' }
};

/** Size of the output PVC. Mostly the dashboard bundle plus a chart per extension. */
export const REPO_VOLUME_SIZE = '5Gi';
/** Scratch volume: clones, node_modules for the dashboard and every extension, verdaccio storage. */
export const WORK_VOLUME_SIZE = '30Gi';

/** Ordered to match PHASE_NAMES in builder/lib/common.sh. The stepper renders in this order. */
export const PHASES = [
  'resolve',
  'publish-shell',
  'build-dashboard',
  'build-extensions',
  'package'
] as const;

export const buildName = (id: string): string => `extensions-builder-${ id }`;
export const repoName = (id: string): string => `extensions-builder-repo-${ id }`;

/**
 * Cluster-internal base URL for a build's repo Service, with no trailing slash.
 *
 * Internal is fine for both consumers: Rancher's Helm controller fetches the
 * ClusterRepo server-side, and extension assets are proxied through
 * /v1/uiplugins rather than fetched by the browser. The one thing that cannot
 * use this is the dashboard bundle, which the browser does fetch - that needs
 * the Ingress URL instead.
 */
export const repoServiceUrl = (id: string): string => `http://${ repoName(id) }.${ NAMESPACE }.svc:${ NGINX_PORT }`;
