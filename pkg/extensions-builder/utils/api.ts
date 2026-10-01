import { addParams } from '@shell/utils/url';
import {
  COMPONENT_BUILD,
  LABEL_BUILD_ID,
  LABEL_COMPONENT,
  LABEL_MANAGED_BY,
  MANAGED_BY,
  NAMESPACE,
  NGINX_CONFIGMAP,
  buildName,
  repoName
} from '../config/builder';
import { BuildSpec } from '../types';
import { STEVE_TYPES, buildObjectsFor, publishObjectsFor } from './build-resources';
import {
  DEFAULT_CLASS_ANNOTATION,
  LOCAL_PATH_CLASS,
  StorageRemedy,
  localPathStorageClassObject,
  namespaceObject,
  nginxConfigMapObject,
  storageRemedy
} from './bootstrap';
import { LOCAL_PATH_DEPLOYMENTS, localPathObjects } from './local-path';
import { ClusterClient, LOCAL_CLUSTER, clusterClient } from './steve-proxy';
import { HelmIndex, indexCharts } from './verify-repo';

/**
 * Every call into Rancher the extension makes, in one place.
 *
 * The product runs against the `management` store, which is Steve on `/v1` -
 * the local cluster. That is where the builds run and where the ClusterRepo has
 * to exist, so there is no cluster context to thread through anything here.
 *
 * These functions do I/O and are not unit tested; the logic they operate on
 * lives in the neighbouring pure modules so it can be.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Store = any;
type SteveResource = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

const STORE = 'management';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const buildSelector = (id: string): string => `${ LABEL_BUILD_ID }=${ id }`;
export const managedSelector = (): string => `${ LABEL_MANAGED_BY }=${ MANAGED_BY }`;

export function schemaFor(store: Store, type: string): unknown {
  return store.getters[`${ STORE }/schemaFor`](type);
}

/** Find a resource, or null if it is not there. Steve 404s are expected here. */
export async function findOrNull(store: Store, type: string, id: string): Promise<SteveResource | null> {
  if (!schemaFor(store, type)) {
    return null;
  }

  try {
    return await store.dispatch(`${ STORE }/find`, {
      type, id, opt: { force: true }
    });
  } catch {
    return null;
  }
}

async function listOrEmpty(store: Store, type: string, opts: { selector?: string; namespace?: string } = {}): Promise<SteveResource[]> {
  if (!schemaFor(store, type)) {
    return [];
  }

  try {
    if (opts.selector) {
      return await store.dispatch(`${ STORE }/findMatching`, {
        type,
        selector:  opts.selector,
        namespace: opts.namespace,
        opt:       { force: true }
      }) || [];
    }

    return await store.dispatch(`${ STORE }/findAll`, { type, opt: { force: true } }) || [];
  } catch {
    return [];
  }
}

export function listJobs(store: Store): Promise<SteveResource[]> {
  return listOrEmpty(store, STEVE_TYPES.JOB, { selector: managedSelector(), namespace: NAMESPACE });
}

export function listConfigMaps(store: Store): Promise<SteveResource[]> {
  return listOrEmpty(store, STEVE_TYPES.CONFIG_MAP, { selector: managedSelector(), namespace: NAMESPACE });
}

export function listClusterRepos(store: Store): Promise<SteveResource[]> {
  return listOrEmpty(store, STEVE_TYPES.CLUSTER_REPO, { selector: managedSelector() });
}

export function listStorageClasses(store: Store): Promise<SteveResource[]> {
  return listOrEmpty(store, STEVE_TYPES.STORAGE_CLASS);
}

/** Is the chart's namespace there? Without it nothing can be created at all. */
export async function namespaceExists(store: Store): Promise<boolean> {
  return !!await findOrNull(store, STEVE_TYPES.NAMESPACE, NAMESPACE);
}

/** Is the nginx config there? Without it a published build's repo pod cannot start. */
export async function nginxConfigExists(store: Store): Promise<boolean> {
  return !!await findOrNull(store, STEVE_TYPES.CONFIG_MAP, `${ NAMESPACE }/${ NGINX_CONFIGMAP }`);
}

/**
 * Is a local-path provisioner already deployed?
 *
 * Checks both the place k3s and RKE2 put theirs and the place upstream's
 * manifest puts it, which is also where we would install one. Decides whether
 * a StorageClass can just be created or needs something behind it first.
 */
export async function localPathProvisionerPresent(store: Store): Promise<boolean> {
  const found = await Promise.all(
    LOCAL_PATH_DEPLOYMENTS.map((id) => findOrNull(store, STEVE_TYPES.DEPLOYMENT, id))
  );

  return found.some((deployment) => !!deployment);
}

/** The build pod for a build, or null if the Job has not produced one yet. */
export async function findBuildPod(store: Store, id: string): Promise<SteveResource | null> {
  const pods = await listOrEmpty(store, STEVE_TYPES.POD, {
    selector:  `${ buildSelector(id) },${ LABEL_COMPONENT }=${ COMPONENT_BUILD }`,
    namespace: NAMESPACE
  });

  // A backoffLimit of 0 means there is at most one, but sort anyway so a
  // lingering pod from a previous run never wins over the current one.
  return pods.sort((a: SteveResource, b: SteveResource) => (
    String(b.metadata?.creationTimestamp || '').localeCompare(String(a.metadata?.creationTimestamp || ''))
  ))[0] || null;
}

/**
 * The build pod's log, as text.
 *
 * Steve exposes it as a `log` sub-resource on the pod's view link - the same
 * endpoint ContainerLogs streams over a websocket. We poll it instead, because
 * all the UI wants is the markers; the live stream is what the "View log"
 * button opens.
 */
export async function fetchBuildLog(store: Store, pod: SteveResource, tailLines = 4000): Promise<string> {
  const viewLink = pod?.links?.view;

  if (!viewLink) {
    return '';
  }

  // addParams takes strings - these go straight onto the query string.
  const url = addParams(`${ viewLink }/log`, {
    container:  'build',
    timestamps: 'false',
    tailLines:  String(tailLines)
  });

  try {
    const res = await store.dispatch(`${ STORE }/request`, { url, responseType: 'text' });

    return typeof res === 'string' ? res : (res?.data || '');
  } catch {
    // Kubernetes answers 400, not 404, for a container that has not started
    // yet - ContainerCreating, PodInitializing, ImagePullBackOff all land here.
    // That is the normal first minute of every build, and a permanent state
    // when the image cannot be pulled, so it must not take the rest of the
    // poll down with it. podBlockedReason() is what tells the two apart.
    return '';
  }
}

/** Open the streaming log window, the same one the Workloads pages use. */
export function openLogWindow(store: Store, pod: SteveResource): void {
  store.dispatch('wm/open', {
    id:        `${ pod.id }-logs`,
    label:     pod.nameDisplay || pod.metadata?.name,
    icon:      'file',
    component: 'ContainerLogs',
    attrs:     { pod, initialContainer: 'build' }
  }, { root: true });
}

async function createResource(store: Store, obj: Record<string, unknown>): Promise<SteveResource> {
  const model = await store.dispatch(`${ STORE }/create`, obj);

  await model.save();

  return model;
}

/**
 * Create the namespace, if it is not already there.
 *
 * Every `ensure*` below checks before it creates rather than creating and
 * swallowing the 409. A blind create would race two clicks of the same button
 * into a confusing error, and would also quietly adopt an object someone else
 * owns. Each returns whether it actually changed anything.
 */
export async function ensureNamespace(store: Store): Promise<boolean> {
  if (await findOrNull(store, STEVE_TYPES.NAMESPACE, NAMESPACE)) {
    return false;
  }

  await createResource(store, namespaceObject());

  return true;
}

/** Create the nginx config the repo Deployment mounts, and the namespace it lives in. */
export async function ensureNginxConfig(store: Store): Promise<boolean> {
  await ensureNamespace(store);

  if (await findOrNull(store, STEVE_TYPES.CONFIG_MAP, `${ NAMESPACE }/${ NGINX_CONFIGMAP }`)) {
    return false;
  }

  await createResource(store, nginxConfigMapObject());

  return true;
}

/** Poll a Deployment until it reports a ready replica, or give up. */
async function waitForDeployment(client: ClusterClient, id: string, timeoutMs = 180000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const deployment = await client.get(STEVE_TYPES.DEPLOYMENT, id);

    if ((deployment?.status?.readyReplicas || 0) >= 1) {
      return true;
    }

    await delay(3000);
  }

  return false;
}

async function provisionerPresentIn(client: ClusterClient): Promise<boolean> {
  const found = await Promise.all(
    LOCAL_PATH_DEPLOYMENTS.map((id) => client.get(STEVE_TYPES.DEPLOYMENT, id))
  );

  return found.some((deployment) => !!deployment);
}

/**
 * Install the local-path provisioner into a cluster, unless one is already
 * running there.
 *
 * Objects are created one at a time, in dependency order, so a failure part way
 * through leaves a half-install that the next attempt completes rather than
 * trips over. Resolves once the Deployment is actually serving - creating the
 * objects is not the same as having a provisioner, and the difference shows up
 * later as a PVC that never binds.
 */
export async function ensureLocalPathProvisioner(store: Store, clusterId = LOCAL_CLUSTER): Promise<boolean> {
  const client = clusterClient(store, clusterId);

  if (await provisionerPresentIn(client)) {
    return false;
  }

  for (const object of localPathObjects()) {
    const metadata = object.metadata as { name: string; namespace?: string };
    const id = metadata.namespace ? `${ metadata.namespace }/${ metadata.name }` : metadata.name;

    if (!await client.get(object.type as string, id)) {
      await client.create(object.type as string, object);
    }
  }

  await waitForDeployment(client, LOCAL_PATH_DEPLOYMENTS[1]);

  return true;
}

const markDefault = (storageClass: SteveResource) => {
  storageClass.metadata = storageClass.metadata || {};
  storageClass.metadata.annotations = { ...storageClass.metadata.annotations, [DEFAULT_CLASS_ANNOTATION]: 'true' };
};

/**
 * Give a cluster a default StorageClass, installing a provisioner first if
 * there is nothing to put behind one.
 *
 * Defaults to the local cluster, which is the one that matters: it is where
 * build pods run, so it is the only cluster preflight blocks on. Another can be
 * passed because a developer standing in front of this form is often the person
 * who also needs storage sorted on a downstream cluster, and the wiring is
 * identical.
 *
 * Re-derives the remedy from live data in the target cluster rather than
 * trusting what preflight decided about the local one, so neither a cluster
 * that changed underneath an open form nor a different target can make us
 * annotate the wrong class.
 */
export async function ensureDefaultStorageClass(store: Store, clusterId = LOCAL_CLUSTER): Promise<StorageRemedy> {
  const client = clusterClient(store, clusterId);
  const remedy = storageRemedy(
    await client.list(STEVE_TYPES.STORAGE_CLASS),
    await provisionerPresentIn(client)
  );

  if (remedy.kind === 'markDefault' && remedy.target) {
    const updated = await client.update(STEVE_TYPES.STORAGE_CLASS, remedy.target, markDefault);

    return updated ? remedy : { kind: 'manual' };
  }

  if (remedy.kind === 'install' || remedy.kind === 'create') {
    if (remedy.kind === 'install') {
      await ensureLocalPathProvisioner(store, clusterId);
    }

    // Upstream's manifest carries a `local-path` class of its own, and the
    // install above may well have created it, so check rather than assume the
    // create is ours to make. Marking it default is then the remaining job.
    if (await client.get(STEVE_TYPES.STORAGE_CLASS, LOCAL_PATH_CLASS)) {
      await client.update(STEVE_TYPES.STORAGE_CLASS, LOCAL_PATH_CLASS, markDefault);
    } else {
      await client.create(STEVE_TYPES.STORAGE_CLASS, localPathStorageClassObject());
    }

    return remedy;
  }

  return remedy;
}

/** Create the ConfigMap, PVC and Job for a build, in that order. */
export async function createBuild(store: Store, spec: BuildSpec): Promise<void> {
  const objects = buildObjectsFor(spec);

  // Order matters: the Job mounts both of the others, and a Job created first
  // would sit unschedulable while Kubernetes waits for them.
  await createResource(store, objects.configMap);
  await createResource(store, objects.pvc);
  await createResource(store, objects.job);
}

async function removeIfPresent(store: Store, type: string, id: string): Promise<void> {
  const resource = await findOrNull(store, type, id);

  if (resource) {
    await resource.remove();
  }
}

/**
 * Delete everything a build owns.
 *
 * Reverse creation order, with the ClusterRepo first: leaving a repo pointing
 * at a Service that no longer exists puts a permanently erroring entry in
 * Apps -> Repositories, which is worse than a leftover PVC.
 */
export async function deleteBuild(store: Store, id: string): Promise<void> {
  const name = buildName(id);
  const repo = repoName(id);
  const namespaced = (resourceName: string) => `${ NAMESPACE }/${ resourceName }`;

  await removeIfPresent(store, STEVE_TYPES.CLUSTER_REPO, name);
  await removeIfPresent(store, STEVE_TYPES.INGRESS, namespaced(repo));
  await removeIfPresent(store, STEVE_TYPES.SERVICE, namespaced(repo));
  await removeIfPresent(store, STEVE_TYPES.DEPLOYMENT, namespaced(repo));
  await removeIfPresent(store, STEVE_TYPES.JOB, namespaced(name));
  await removeIfPresent(store, STEVE_TYPES.PVC, namespaced(name));
  await removeIfPresent(store, STEVE_TYPES.CONFIG_MAP, namespaced(name));
}

/** Has this build's output already been published? */
export async function isPublished(store: Store, id: string): Promise<boolean> {
  return !!await findOrNull(store, STEVE_TYPES.CLUSTER_REPO, buildName(id));
}

export interface PublishOptions {
  dashboardHost?: string;
  dashboardTlsSecret?: string;
}

/** Stand up nginx over the build's volume and register it as a ClusterRepo. */
export async function publishBuild(store: Store, id: string, options: PublishOptions = {}): Promise<void> {
  // Cheap and idempotent. Covers a build that was queued before the config
  // existed, which would otherwise fail here with a pod stuck on a missing
  // volume - 30 minutes after the mistake was made.
  await ensureNginxConfig(store);

  const objects = publishObjectsFor(
    id,
    options.dashboardHost ? { host: options.dashboardHost, tlsSecretName: options.dashboardTlsSecret } : undefined
  );

  await createResource(store, objects.deployment);
  await createResource(store, objects.service);

  if (objects.ingress) {
    await createResource(store, objects.ingress);
  }

  await createResource(store, objects.clusterRepo);
}

/**
 * Nudge the ClusterRepo until it serves charts, then hand back the index.
 *
 * The first few attempts are expected to fail: nginx has to start, and Rancher
 * only retries a repo fetch on its own schedule. This is the same force-update
 * and retry loop InstallHelmCharts uses after adding a repo, except we read the
 * index ourselves rather than going through the catalog store, so that what we
 * verify is exactly what Rancher fetched.
 */
export async function syncClusterRepo(
  store: Store,
  id: string,
  attempts = 20,
  waitMs = 3000
): Promise<HelmIndex | null> {
  const name = buildName(id);
  let lastIndex: HelmIndex | null = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const repo = await findOrNull(store, STEVE_TYPES.CLUSTER_REPO, name);

    if (repo) {
      try {
        repo.spec = { ...repo.spec, forceUpdate: new Date().toISOString().replace(/\.\d+Z$/, 'Z') };
        await repo.save();
        await repo.waitForState('active', 20000, 1000);

        lastIndex = await repo.followLink('index') as HelmIndex;

        if (indexCharts(lastIndex).length > 0) {
          // The catalog store is what Apps -> Extensions reads, so make sure it
          // sees the new repo too rather than a cached empty one.
          await store.dispatch('catalog/load', { force: true, repoKeys: [repo._key] }, { root: true });

          return lastIndex;
        }
      } catch {
        // Expected while the repo is still syncing. Keep going; the loop
        // running out of attempts is the real failure.
      }
    }

    await delay(waitMs);
  }

  return lastIndex;
}
