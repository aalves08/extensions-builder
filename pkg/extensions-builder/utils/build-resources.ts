import { CATALOG } from '@shell/config/types';
import {
  ANNOTATION_SPEC,
  BUILDER_IMAGE,
  BUILD_DEADLINE_SECONDS,
  BUILD_RESOURCES,
  COMPONENT_BUILD,
  COMPONENT_REPO,
  LABEL_BUILD_ID,
  LABEL_COMPONENT,
  LABEL_MANAGED_BY,
  LABEL_NAME,
  MANAGED_BY,
  NAMESPACE,
  NGINX_CONFIGMAP,
  NGINX_IMAGE,
  NGINX_PORT,
  REPO_VOLUME_SIZE,
  WORK_VOLUME_SIZE,
  buildName,
  repoName,
  repoPublicPath,
  repoPublicUrl,
  repoServiceUrl
} from '../config/builder';
import {
  BuildSpec, BuildSpecDraft, ExtensionSource, ExternalAccess, ShellSource
} from '../types';

/**
 * Every Kubernetes object a build is made of, as plain data.
 *
 * Kept free of Vuex and of the Steve models so the shapes can be asserted in a
 * unit test - which is the only cheap way to catch a typo in a volume mount or
 * a label selector before it costs someone a 30 minute build.
 */

export const STEVE_TYPES = {
  NAMESPACE:            'namespace',
  CONFIG_MAP:           'configmap',
  PVC:                  'persistentvolumeclaim',
  JOB:                  'batch.job',
  DEPLOYMENT:           'apps.deployment',
  SERVICE:              'service',
  INGRESS:              'networking.k8s.io.ingress',
  POD:                  'pod',
  STORAGE_CLASS:        'storage.k8s.io.storageclass',
  CLUSTER_REPO:         CATALOG.CLUSTER_REPO,
  // Only used when installing the local-path provisioner, in utils/local-path.ts.
  SERVICE_ACCOUNT:      'serviceaccount',
  ROLE:                 'rbac.authorization.k8s.io.role',
  ROLE_BINDING:         'rbac.authorization.k8s.io.rolebinding',
  CLUSTER_ROLE:         'rbac.authorization.k8s.io.clusterrole',
  CLUSTER_ROLE_BINDING: 'rbac.authorization.k8s.io.clusterrolebinding'
};

/** Objects created up front, before the Job starts. */
export interface BuildObjects {
  configMap: Record<string, unknown>;
  pvc: Record<string, unknown>;
  job: Record<string, unknown>;
}

/**
 * Objects created afterwards, to serve what the build produced.
 *
 * No Service: that one is created before the Job, because the packaging phase
 * needs its ClusterIP.
 */
export interface PublishObjects {
  deployment: Record<string, unknown>;
  clusterRepo: Record<string, unknown>;
  ingress?: Record<string, unknown>;
}

const commonLabels = (id: string, component: string) => ({
  [LABEL_NAME]:       MANAGED_BY,
  [LABEL_MANAGED_BY]: MANAGED_BY,
  [LABEL_COMPONENT]:  component,
  [LABEL_BUILD_ID]:   id
});

/**
 * A short, DNS-safe id for a build. Prefixed with the PR or ref so the list is
 * readable at a glance, suffixed with randomness so re-running the same PR does
 * not collide with the build still serving.
 */
export function generateBuildId(shell: ShellSource, random: () => number = Math.random): string {
  const prefix = shell.pr ? `pr${ shell.pr }` : sanitizeForName(shell.ref || 'build');
  const suffix = Math.floor(random() * 0xffff).toString(36).padStart(4, '0').slice(-4);

  // `extensions-builder-repo-<id>` has to stay inside the 63 character limit
  // for a Service name, which leaves 39 characters for the id.
  return `${ prefix.slice(0, 34) }-${ suffix }`;
}

/** Lowercase, strip anything that is not alphanumeric or a dash, trim stray dashes. */
export function sanitizeForName(input: string): string {
  const cleaned = (input || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return cleaned || 'build';
}

/**
 * Assemble the spec the Job reads from /config/build.json, bar the repo URL.
 *
 * The repo URL is added separately by specWithRepo, once the Service exists and
 * its ClusterIP is known. It cannot be left until later than that: the
 * packaging phase writes it into every chart's `plugin.endpoint`, so by the
 * time the build finishes it is already set in stone.
 */
export function buildSpecFor(opts: {
  id: string;
  shell: ShellSource;
  extensions: ExtensionSource[];
  buildDashboard: boolean;
  dashboardPublicUrl?: string;
  dashboardRouterBase?: string;
  external?: ExternalAccess | null;
}): BuildSpecDraft {
  const spec: BuildSpecDraft = {
    buildId:        opts.id,
    shell:          opts.shell,
    buildDashboard: opts.buildDashboard,
    extensions:     opts.extensions
  };

  // Like the dashboard URL below, this is a build-time input and not a publish
  // -time one: the packaging phase turns it into every chart's plugin.endpoint,
  // and a chart cannot be re-pointed after it has been packaged.
  if (opts.external?.host) {
    spec.external = {
      host: opts.external.host.trim(),
      tls:  opts.external.tls,
      ...(opts.external.tlsSecretName ? { tlsSecretName: opts.external.tlsSecretName.trim() } : {})
    };
  }

  if (opts.buildDashboard) {
    spec.dashboard = {
      publicUrl:  (opts.dashboardPublicUrl || '').replace(/\/+$/, ''),
      // Rancher always serves the dashboard at /dashboard, whatever host the
      // bundle itself is fetched from, so the router base is fixed.
      routerBase: opts.dashboardRouterBase || '/dashboard'
    };
  }

  return spec;
}

/**
 * Complete a draft spec with the repo URLs, once the Service has an IP.
 *
 * Two URLs for one directory of files. The Service address is what this
 * Rancher uses and is the proven path, so it stays the ClusterRepo's url on a
 * local publish. The public one is only present when the build was asked for
 * externally, and it is the one baked into the charts - a chart carries a
 * single endpoint, and the Rancher that most needs it to be right is the one
 * that cannot reach a ClusterIP.
 */
export function specWithRepo(draft: BuildSpecDraft, clusterIP: string): BuildSpec {
  const publicUrl = draft.external?.host ? repoPublicUrl(draft.external.host, draft.external.tls, draft.buildId) : '';

  return {
    ...draft,
    repo: {
      serviceUrl: repoServiceUrl(clusterIP),
      ...(publicUrl ? { publicUrl } : {})
    }
  };
}

export function configMapFor(spec: BuildSpec): Record<string, unknown> {
  const json = JSON.stringify(spec, null, 2);

  return {
    type:     STEVE_TYPES.CONFIG_MAP,
    metadata: {
      name:        buildName(spec.buildId),
      namespace:   NAMESPACE,
      labels:      commonLabels(spec.buildId, COMPONENT_BUILD),
      // The same JSON again as an annotation. The builds list reads it to show
      // what each build is without having to pull every ConfigMap's data.
      annotations: { [ANNOTATION_SPEC]: json }
    },
    data: { 'build.json': json }
  };
}

export function pvcFor(id: string): Record<string, unknown> {
  return {
    type:     STEVE_TYPES.PVC,
    metadata: {
      name:      buildName(id),
      namespace: NAMESPACE,
      labels:    commonLabels(id, COMPONENT_BUILD)
    },
    spec: {
      // ReadWriteOnce is all a default StorageClass is guaranteed to offer. It
      // works here only because the Job finishes before nginx mounts the same
      // volume - never run the two at once.
      accessModes: ['ReadWriteOnce'],
      resources:   { requests: { storage: REPO_VOLUME_SIZE } }
    }
  };
}

export function jobFor(spec: BuildSpec): Record<string, unknown> {
  const id = spec.buildId;
  const name = buildName(id);

  return {
    type:     STEVE_TYPES.JOB,
    metadata: {
      name,
      namespace: NAMESPACE,
      labels:    commonLabels(id, COMPONENT_BUILD)
    },
    spec: {
      // One shot. A retry would restart a 30 minute build from scratch against
      // the same inputs and fail the same way; better to surface the failure.
      backoffLimit:          0,
      activeDeadlineSeconds: BUILD_DEADLINE_SECONDS,
      // Deliberately no ttlSecondsAfterFinished: the pod's log is the whole
      // point of a failed build, and the UI deletes the Job itself when the
      // user deletes the build.
      template:              {
        metadata: { labels: commonLabels(id, COMPONENT_BUILD) },
        spec:     {
          restartPolicy:                'Never',
          // The build talks to no Kubernetes API. It clones, builds and writes
          // files, so give it no credentials at all.
          automountServiceAccountToken: false,
          containers:                   [{
            name:            'build',
            image:           BUILDER_IMAGE,
            imagePullPolicy: 'Always',
            resources:       BUILD_RESOURCES,
            volumeMounts:    [
              {
                name: 'config', mountPath: '/config', readOnly: true
              },
              { name: 'repo', mountPath: '/srv/repo' },
              { name: 'work', mountPath: '/work' }
            ]
          }],
          volumes: [
            { name: 'config', configMap: { name } },
            { name: 'repo', persistentVolumeClaim: { claimName: name } },
            // Scratch: clones, node_modules for the dashboard and every
            // extension, and verdaccio's storage. None of it needs to outlive
            // the pod, and putting it on the output PVC would bloat the volume
            // nginx later serves.
            { name: 'work', emptyDir: { sizeLimit: WORK_VOLUME_SIZE } }
          ]
        }
      }
    }
  };
}

export function buildObjectsFor(spec: BuildSpec): BuildObjects {
  return {
    configMap: configMapFor(spec),
    pvc:       pvcFor(spec.buildId),
    job:       jobFor(spec)
  };
}

export function deploymentFor(id: string): Record<string, unknown> {
  const name = repoName(id);
  const labels = commonLabels(id, COMPONENT_REPO);

  return {
    type:     STEVE_TYPES.DEPLOYMENT,
    metadata: {
      name, namespace: NAMESPACE, labels
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: labels },
      // Recreate, not RollingUpdate: the output PVC is ReadWriteOnce, so a
      // second pod would sit Pending forever waiting for the first to let go.
      strategy: { type: 'Recreate' },
      template: {
        metadata: { labels },
        spec:     {
          automountServiceAccountToken: false,
          securityContext:              {
            runAsNonRoot: true,
            runAsUser:    101,
            runAsGroup:   101
          },
          containers: [{
            name:      'nginx',
            image:     NGINX_IMAGE,
            ports:     [{ containerPort: NGINX_PORT, name: 'http' }],
            resources: {
              requests: { cpu: '10m', memory: '32Mi' },
              limits:   { cpu: '200m', memory: '128Mi' }
            },
            readinessProbe: {
              httpGet: { path: '/healthz', port: NGINX_PORT }, initialDelaySeconds: 2, periodSeconds: 5
            },
            volumeMounts: [
              {
                name: 'repo', mountPath: '/srv/repo', readOnly: true
              },
              {
                name: 'nginx-config', mountPath: '/etc/nginx/nginx.conf', subPath: 'nginx.conf', readOnly: true
              },
              // The config puts every writable path under /tmp so the image can
              // run as a non-root user with a read-only data volume.
              { name: 'tmp', mountPath: '/tmp' }
            ]
          }],
          volumes: [
            { name: 'repo', persistentVolumeClaim: { claimName: buildName(id), readOnly: true } },
            { name: 'nginx-config', configMap: { name: NGINX_CONFIGMAP } },
            { name: 'tmp', emptyDir: {} }
          ]
        }
      }
    }
  };
}

export function serviceFor(id: string): Record<string, unknown> {
  const name = repoName(id);
  const labels = commonLabels(id, COMPONENT_REPO);

  return {
    type:     STEVE_TYPES.SERVICE,
    metadata: {
      name, namespace: NAMESPACE, labels
    },
    spec: {
      type:     'ClusterIP',
      selector: labels,
      ports:    [{
        name: 'http', port: NGINX_PORT, targetPort: NGINX_PORT, protocol: 'TCP'
      }]
    }
  };
}

/**
 * `serviceUrl` is the one the build was packaged against, read back from its
 * spec rather than derived again here. The charts this repo serves already
 * carry that exact string in their `plugin.endpoint`; deriving it a second time
 * is how a repo and the charts inside it end up pointing at different places.
 */
export function clusterRepoFor(id: string, serviceUrl: string): Record<string, unknown> {
  return {
    type:     STEVE_TYPES.CLUSTER_REPO,
    metadata: {
      name:   buildName(id),
      labels: commonLabels(id, COMPONENT_REPO)
    },
    // Rancher's Helm controller fetches this server-side, so a cluster-internal
    // URL is fine. The trailing slash matters: index.yaml is resolved against it.
    spec: { url: `${ serviceUrl.replace(/\/+$/, '') }/` }
  };
}

/** One hostname and path the build should answer on from outside the cluster. */
export interface IngressRoute {
  host: string;
  /** Prefix path, no trailing slash. */
  path: string;
}

/**
 * Ingress for the parts of a build that are fetched from outside the cluster.
 *
 * Most of what a build serves never leaves the cluster network: this Rancher
 * fetches the repository index server-side and proxies extension assets through
 * /v1/uiplugins. Two things do need a route in, and both are about somebody
 * else doing the fetching - the dashboard bundle, which the browser loads
 * directly, and the repository itself when another Rancher is going to install
 * from it.
 *
 * Returns null when there is nothing to expose, so the caller does not have to
 * ask twice.
 */
export function ingressFor(id: string, routes: IngressRoute[], tlsSecretName?: string): Record<string, unknown> | null {
  const name = repoName(id);
  const byHost = new Map<string, string[]>();

  for (const route of routes || []) {
    const host = (route?.host || '').trim();

    if (!host || !route.path) {
      continue;
    }

    const paths = byHost.get(host) || [];

    if (!paths.includes(route.path)) {
      paths.push(route.path);
    }

    byHost.set(host, paths);
  }

  if (!byHost.size) {
    return null;
  }

  const ingress: Record<string, unknown> = {
    type:     STEVE_TYPES.INGRESS,
    metadata: {
      name,
      namespace: NAMESPACE,
      labels:    commonLabels(id, COMPONENT_REPO)
    },
    spec: {
      rules: [...byHost.entries()].map(([host, paths]) => ({
        host,
        http: {
          paths: paths.map((path) => ({
            path,
            pathType: 'Prefix',
            backend:  { service: { name, port: { number: NGINX_PORT } } }
          }))
        }
      }))
    }
  };

  // Optional on purpose. The usual host here is the one Rancher already answers
  // on, which means a certificate for it is already loaded and the ingress
  // controller will serve our paths under it without being told twice. Naming a
  // secret is for the case where that is not true - and it has to live in this
  // namespace, which Rancher's own TLS secret does not.
  if (tlsSecretName) {
    (ingress.spec as Record<string, unknown>).tls = [{ hosts: [...byHost.keys()], secretName: tlsSecretName }];
  }

  return ingress;
}

export function publishObjectsFor(
  id: string,
  serviceUrl: string,
  options: {
    external?: ExternalAccess | null;
    dashboard?: { host: string; tlsSecretName?: string } | null;
  } = {}
): PublishObjects {
  const objects: PublishObjects = {
    deployment:  deploymentFor(id),
    clusterRepo: clusterRepoFor(id, serviceUrl)
  };

  const routes: IngressRoute[] = [];

  if (options.external?.host) {
    routes.push({ host: options.external.host, path: repoPublicPath(id) });
  }

  if (options.dashboard?.host) {
    routes.push({ host: options.dashboard.host, path: '/dashboard' });
  }

  const ingress = ingressFor(id, routes, options.external?.tlsSecretName || options.dashboard?.tlsSecretName);

  if (ingress) {
    objects.ingress = ingress;
  }

  return objects;
}

/** Public base URL the dashboard bundle will be served from, given an Ingress host. */
export function dashboardPublicUrl(host: string, tls: boolean): string {
  return `${ tls ? 'https' : 'http' }://${ (host || '').trim().replace(/\/+$/, '') }/dashboard`;
}
