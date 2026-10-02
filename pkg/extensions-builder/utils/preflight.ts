import { NAMESPACE } from '../config/builder';
import { PreflightResult } from '../types';
import { StorageRemedy, storageRemedyFixable } from './bootstrap';

/**
 * The checks that run before the New Build form will submit.
 *
 * Every one of these exists because getting it wrong fails late and
 * confusingly: a missing default StorageClass leaves the build pod Pending with
 * no log at all, a missing nginx ConfigMap only bites 30 minutes later when the
 * repo Deployment cannot mount it, and a missing ClusterRepo schema bites at
 * the same point. Cheap to check up front, expensive to discover.
 *
 * Where the UI can repair the cluster itself it says so via `fixable`, which
 * names the remedy for NewBuild.vue to dispatch on.
 */

export interface PreflightInput {
  /** The build creates cluster-scoped objects and edits settings. */
  isAdmin: boolean;
  /** `catalog.cattle.io.clusterrepo` visible in the management store. */
  hasClusterRepoSchema: boolean;
  /** `batch.job` visible in the management store. */
  hasJobSchema: boolean;
  /** How many StorageClasses carry the default-class annotation. */
  defaultStorageClasses: number;
  /** What can be done about it when that count is zero. */
  storage: StorageRemedy;
  /** The namespace every build object goes in. */
  namespaceExists: boolean;
  /**
   * The nginx config the repo Deployment mounts when a build is published, and
   * whether it is still the one this extension ships.
   */
  nginxConfigCurrent: boolean;
}

function storageCheck(input: PreflightInput): PreflightResult {
  const { defaultStorageClasses: count, storage } = input;

  if (count > 1) {
    // Kubernetes picks one and the build still runs, it just may not land on
    // the class the user intended. Worth saying, not worth blocking.
    return {
      id:          'storageClass',
      ok:          false,
      warningOnly: true,
      messageKey:  'extensionsBuilder.preflight.multipleStorageClasses'
    };
  }

  if (count === 1) {
    return {
      id: 'storageClass', ok: true, warningOnly: false, messageKey: 'extensionsBuilder.preflight.noStorageClass'
    };
  }

  const messageKey = {
    create:      'extensionsBuilder.preflight.storageClassCreatable',
    install:     'extensionsBuilder.preflight.storageClassInstallable',
    markDefault: 'extensionsBuilder.preflight.storageClassNotDefault',
    manual:      'extensionsBuilder.preflight.noStorageClass',
    // Unreachable: `ok` means at least one default, so count would not be zero.
    ok:          'extensionsBuilder.preflight.noStorageClass'
  }[storage.kind];

  return {
    id:          'storageClass',
    ok:          false,
    warningOnly: false,
    messageKey,
    messageArgs: { name: storage.target || '' },
    fixable:     storageRemedyFixable(storage) ? 'storageClass' : undefined,
    // Installing a provisioner puts a Deployment and a ClusterRole in the
    // cluster. That deserves a label that says so, not a vague "fix storage".
    fixLabelKey: storage.kind === 'install' ? 'extensionsBuilder.preflight.fix.storageProvisioner' : undefined,
    // Storage is the one remedy that makes sense anywhere, so let the user say
    // where. The check itself is always about the local cluster.
    fixCluster:  storageRemedyFixable(storage)
  };
}

export function runPreflight(input: PreflightInput): PreflightResult[] {
  return [
    {
      id:          'admin',
      ok:          input.isAdmin,
      warningOnly: false,
      messageKey:  'extensionsBuilder.preflight.admin'
    },
    {
      id:          'namespace',
      ok:          input.namespaceExists,
      warningOnly: false,
      messageKey:  'extensionsBuilder.preflight.namespace',
      messageArgs: { namespace: NAMESPACE },
      // Only offer the shortcut to someone who could actually carry it out.
      fixable:     input.isAdmin ? 'namespace' : undefined
    },
    {
      id:          'nginxConfig',
      ok:          input.nginxConfigCurrent,
      warningOnly: false,
      messageKey:  'extensionsBuilder.preflight.nginxConfig',
      messageArgs: { namespace: NAMESPACE },
      fixable:     input.isAdmin ? 'nginxConfig' : undefined
    },
    {
      id:          'jobSchema',
      ok:          input.hasJobSchema,
      warningOnly: false,
      messageKey:  'extensionsBuilder.preflight.jobSchema'
    },
    {
      id:          'clusterRepoSchema',
      ok:          input.hasClusterRepoSchema,
      warningOnly: false,
      messageKey:  'extensionsBuilder.preflight.clusterRepoSchema'
    },
    storageCheck(input)
  ];
}

/** True when something failed that the user cannot proceed past. */
export function preflightBlocked(results: PreflightResult[]): boolean {
  return results.some((result) => !result.ok && !result.warningOnly);
}

export function preflightWarnings(results: PreflightResult[]): PreflightResult[] {
  return results.filter((result) => !result.ok && result.warningOnly);
}

export function preflightFailures(results: PreflightResult[]): PreflightResult[] {
  return results.filter((result) => !result.ok && !result.warningOnly);
}

const DEFAULT_CLASS_ANNOTATIONS = [
  'storageclass.kubernetes.io/is-default-class',
  // Pre-1.6 spelling. Still set by some older storage addons.
  'storageclass.beta.kubernetes.io/is-default-class'
];

/** Count the StorageClasses Kubernetes would treat as the default. */
export function countDefaultStorageClasses(
  storageClasses: { metadata?: { annotations?: Record<string, string> } }[]
): number {
  return (storageClasses || []).filter((sc) => {
    const annotations = sc?.metadata?.annotations || {};

    return DEFAULT_CLASS_ANNOTATIONS.some((key) => annotations[key] === 'true');
  }).length;
}
