/**
 * Shared types for the extensions builder.
 *
 * `BuildSpec` is a contract, not just a convenience type: it is serialised
 * verbatim into the ConfigMap the build Job mounts at /config/build.json, and
 * the builder's phase scripts read exactly these fields with jq. Renaming a
 * field here means changing builder/phases/*.sh too.
 *
 * `BuildStatus` is the other half of that contract: the builder writes it to
 * /srv/repo/status.json (see builder/lib/common.sh) and the UI reads it back
 * through the repo Service once the build is serving.
 */

/** Where the shell under test comes from. Exactly one of `pr` / `ref` is set. */
export interface ShellSource {
  /** Clone URL. Normally rancher/dashboard, but a fork is allowed. */
  repo: string;
  /** PR number on `repo`. Fetched as refs/pull/<n>/head, so fork PRs work too. */
  pr: number | null;
  /** Branch or tag on `repo`, used when no PR number is given. */
  ref: string | null;
}

/** One extension to build against the shell under test. */
export interface ExtensionSource {
  /** Unique within a build. Also the clone directory name inside the Job. */
  name: string;
  /** Git clone URL. */
  repo: string;
  /** Branch or tag. Empty means the repo's default branch. */
  ref: string;
  /** Folder name under `pkg/` in that repo. */
  pkg: string;
  /** Came from ui-plugin-charts/manifest.json rather than being typed in by hand. */
  official: boolean;
}

/**
 * How a build's repository is reached from outside the cluster.
 *
 * Set when the build should be installable from a Rancher other than this one.
 * It has to be decided before the build starts, not at publish time: the
 * packaging phase writes the resulting URL into every chart's plugin.endpoint,
 * and whichever Rancher installs that chart fetches the extension from there.
 */
export interface ExternalAccess {
  /** Hostname that already routes to this cluster's ingress controller. */
  host: string;
  tls: boolean;
  /** Only needed when the host has no certificate served for it already. */
  tlsSecretName?: string;
}

/** Written to the ConfigMap as /config/build.json. */
export interface BuildSpec {
  buildId: string;
  shell: ShellSource;
  buildDashboard: boolean;
  dashboard?: {
    /** Browser-reachable URL the bundle is served from. Becomes RESOURCE_BASE. */
    publicUrl: string;
    /** Becomes ROUTER_BASE. */
    routerBase: string;
  };
  external?: ExternalAccess;
  extensions: ExtensionSource[];
  repo: {
    /** Cluster-internal base URL of the repo Service, no trailing slash. */
    serviceUrl: string;
    /**
     * Externally reachable base URL of the same repository, no trailing slash.
     * Derived from `external`. Absent when the build is local-only.
     */
    publicUrl?: string;
  };
}

/**
 * A build spec before its repo URL is known.
 *
 * The URL contains the Service's ClusterIP, which Kubernetes only allocates on
 * create, so the spec is assembled in two steps: everything the form knows,
 * then the repo once the Service exists.
 */
export type BuildSpecDraft = Omit<BuildSpec, 'repo'>;

export type PhaseState = 'pending' | 'running' | 'success' | 'failed' | 'skipped';

export interface BuildPhase {
  name: string;
  state: PhaseState;
  startedAt: string | null;
  finishedAt: string | null;
  /** How long the phase took, once it is over. Reported by the builder. */
  durationSeconds: number | null;
}

export interface BuiltPackage {
  /** Package name, i.e. the folder under pkg/. Also the chart name. */
  name: string;
  version: string;
  repo: string;
  /** Paths inside the Job's filesystem. Only useful for debugging. */
  dist: string;
  source: string;
}

/** Read back from /srv/repo/status.json. */
export interface BuildStatus {
  buildId: string;
  state: 'running' | 'success' | 'failed';
  phase: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  shellSha: string | null;
  shellRef: string | null;
  dashboard: boolean;
  dashboardIndex?: string | null;
  packages: BuiltPackage[];
  error: string | null;
  phases: BuildPhase[];
}

/** Lifecycle of a build as the UI presents it, derived from the Job + status.json. */
export type BuildState = 'pending' | 'running' | 'success' | 'failed' | 'unknown';

/** One row on the builds list: a Job plus whatever we could learn about it. */
export interface BuildSummary {
  id: string;
  spec: BuildSpec | null;
  state: BuildState;
  phase: string | null;
  createdAt: string;
  /** True once the repo Deployment/Service/ClusterRepo exist for this build. */
  published: boolean;
}

/** A row in the extension picker, whether from the manifest or hand-entered. */
export interface PickerRow extends ExtensionSource {
  selected: boolean;
  /** Published chart versions, from the manifest. Display only - we build from source. */
  versions: string[];
}

/** Result of the checks that run before the New Build form will submit. */
export interface PreflightResult {
  id: string;
  ok: boolean;
  /** `false` blocks the build; `true` is a warning the user can proceed past. */
  warningOnly: boolean;
  /** i18n key for the message shown when `ok` is false. */
  messageKey: string;
  /** Interpolation args for `messageKey`. */
  messageArgs?: Record<string, string>;
  /**
   * Names a remedy the UI can carry out itself, for NewBuild.vue to dispatch
   * on. Absent when the check needs a human - no permission, or an ambiguous
   * cluster we should not guess about.
   */
  fixable?: string;
  /**
   * Overrides the button label, when one remedy covers actions of different
   * weight. Defaults to `extensionsBuilder.preflight.fix.<fixable>`.
   */
  fixLabelKey?: string;
  /**
   * The remedy can be applied to a cluster other than local, so the banner
   * offers a cluster to target alongside the button.
   */
  fixCluster?: boolean;
}
