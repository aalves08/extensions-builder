import {
  LABEL_MANAGED_BY, LABEL_NAME, MANAGED_BY, NAMESPACE, NGINX_CONFIGMAP, NGINX_PORT
} from '../config/builder';
import { STEVE_TYPES } from './build-resources';

/**
 * The cluster-side prerequisites, as plain objects the UI creates itself.
 *
 * There is nothing to install before using this extension: installing the
 * extension is the install. Everything a build needs that is not per-build -
 * the namespace, the nginx config the repo pod mounts, and a default
 * StorageClass - is created from the New Build form when it is missing.
 *
 * Shapes only; the idempotent create/patch calls live in utils/api.ts, matching
 * how build-resources.ts and api.ts are split.
 */

const bootstrapLabels = () => ({
  [LABEL_NAME]:       MANAGED_BY,
  [LABEL_MANAGED_BY]: MANAGED_BY
});

export function namespaceObject(): Record<string, unknown> {
  return {
    type:     STEVE_TYPES.NAMESPACE,
    metadata: { name: NAMESPACE, labels: bootstrapLabels() }
  };
}

/**
 * Mirrors shell/scripts/extension/helm/package/nginx.conf in rancher/dashboard,
 * with the addition of CORS for the dashboard bundle - that one IS fetched by
 * the browser, from the Rancher origin, unlike everything else served here.
 */
export const NGINX_CONF = `worker_processes 1;
error_log /dev/stderr warn;
pid /tmp/nginx.pid;

events {
  worker_connections 1024;
}

http {
  include       /etc/nginx/mime.types;
  default_type  application/octet-stream;
  access_log    /dev/stdout;
  sendfile      on;

  # Running as non-root, so every writable path has to be under /tmp.
  client_body_temp_path /tmp/client_temp;
  proxy_temp_path       /tmp/proxy_temp;
  fastcgi_temp_path     /tmp/fastcgi_temp;
  uwsgi_temp_path       /tmp/uwsgi_temp;
  scgi_temp_path        /tmp/scgi_temp;

  # index.yaml must never be cached: a rebuild reuses the same URL, and a stale
  # index is the difference between seeing the new charts and not.
  #
  # Keyed off the URI rather than written as a location block, because the same
  # file is served from two places - at the root for anything inside the
  # cluster, and under a path prefix for anything outside it - and one rule
  # that covers both cannot go wrong on only one of them. An empty value adds
  # no header at all.
  map $uri $repo_cache_control {
    default       "";
    ~index\\.yaml$ "no-store";
  }

  server {
    listen      ${ NGINX_PORT };
    listen      [::]:${ NGINX_PORT };
    server_name _;
    server_tokens off;
    autoindex   on;

    root /srv/repo;
    gzip_static on;

    # Keep the redirect nginx issues for a directory without a trailing slash
    # relative. Left absolute it is built from this server block, so a request
    # that arrived through an Ingress on https://rancher.example.com/... is
    # answered with http://rancher.example.com:8080/..., which resolves to
    # nothing. Relative, the proxy's own scheme, host and port are kept.
    absolute_redirect off;

    add_header Cache-Control $repo_cache_control always;

    # The same repository again, under a path prefix.
    #
    # Installing a build from another Rancher means reaching it from outside
    # this cluster, and the only hostname we can count on routing here is the
    # one Rancher already answers on - so the repo cannot own \`/\` there without
    # swallowing Rancher's own UI. The build id in the prefix is what routes the
    # Ingress to this build's Service; by the time the request arrives there is
    # only one repository to serve, so it is matched and thrown away.
    #
    # \`alias\` rather than an ingress rewrite: rewrite-target is an annotation
    # each ingress controller spells differently, and k3s ships Traefik rather
    # than ingress-nginx. Doing it here works behind any of them.
    #
    # The trailing slash is optional so that a URL pasted into another Rancher's
    # "Add repository" field works whether or not it was copied with one.
    location ~ ^/extensions-builder/[^/]+(/(?<repo_path>.*))?$ {
      alias /srv/repo/$repo_path;
    }

    location /dashboard/ {
      add_header Access-Control-Allow-Origin  "*";
      add_header Access-Control-Allow-Headers "*";
      try_files $uri $uri/ /dashboard/index.html;
    }

    location /healthz {
      access_log off;
      return 200 "ok\\n";
    }
  }
}
`;

export function nginxConfigMapObject(): Record<string, unknown> {
  return {
    type:     STEVE_TYPES.CONFIG_MAP,
    metadata: {
      name: NGINX_CONFIGMAP, namespace: NAMESPACE, labels: bootstrapLabels()
    },
    data: { 'nginx.conf': NGINX_CONF }
  };
}

export const DEFAULT_CLASS_ANNOTATION = 'storageclass.kubernetes.io/is-default-class';
/** Shipped with k3s and RKE2, and the one provisioner the UI knows how to install. */
export const LOCAL_PATH_PROVISIONER = 'rancher.io/local-path';
export const LOCAL_PATH_CLASS = 'local-path';

export function localPathStorageClassObject(): Record<string, unknown> {
  return {
    type:     STEVE_TYPES.STORAGE_CLASS,
    metadata: {
      name:        LOCAL_PATH_CLASS,
      labels:      bootstrapLabels(),
      annotations: { [DEFAULT_CLASS_ANNOTATION]: 'true' }
    },
    provisioner:       LOCAL_PATH_PROVISIONER,
    reclaimPolicy:     'Delete',
    // The build Job and the nginx Deployment mount the same ReadWriteOnce
    // volume one after the other. Binding late pins the PV to whichever node
    // the build landed on, and the PV's node affinity then pulls nginx to the
    // same place. Immediate binding can put the volume on the wrong node and
    // leave nginx Pending forever.
    volumeBindingMode: 'WaitForFirstConsumer'
  };
}

interface StorageClassLike {
  metadata?: { name?: string; annotations?: Record<string, string> };
  provisioner?: string;
}

export type StorageRemedyKind =
  /** At least one default already. Nothing to do. */
  | 'ok'
  /** Annotate an existing class as the default. */
  | 'markDefault'
  /** No classes at all, but the local-path provisioner is running. Create the class. */
  | 'create'
  /** No classes and no provisioner. Install the provisioner, then create the class. */
  | 'install'
  /** Needs a human: several classes and no basis for choosing between them. */
  | 'manual';

export interface StorageRemedy {
  kind: StorageRemedyKind;
  /** The class to annotate, when `kind` is `markDefault`. */
  target?: string;
}

const isDefault = (sc: StorageClassLike) => {
  const annotations = sc?.metadata?.annotations || {};

  return annotations[DEFAULT_CLASS_ANNOTATION] === 'true' ||
    annotations['storageclass.beta.kubernetes.io/is-default-class'] === 'true';
};

/**
 * Work out what to do about a cluster with no default StorageClass.
 *
 * The one thing we never do is create a StorageClass naming a provisioner that
 * is not running: that leaves the PVC Pending just the same, only with a less
 * obvious cause - the exact symptom we are trying to remove. So an empty
 * cluster gets the provisioner installed first (`install`) rather than being
 * handed a class that cannot bind.
 *
 * `hasLocalPathProvisioner` is only consulted when there are no classes at
 * all. Callers may skip looking it up otherwise - see NewBuild.runChecks.
 */
export function storageRemedy(
  storageClasses: StorageClassLike[] | null | undefined,
  hasLocalPathProvisioner: boolean
): StorageRemedy {
  const classes = (storageClasses || []).filter((sc) => !!sc?.metadata?.name);

  if (classes.some(isDefault)) {
    return { kind: 'ok' };
  }

  if (!classes.length) {
    return hasLocalPathProvisioner ? { kind: 'create' } : { kind: 'install' };
  }

  if (classes.length === 1) {
    return { kind: 'markDefault', target: classes[0].metadata?.name };
  }

  // Several to choose from. Picking arbitrarily would silently decide where
  // every build's volume lands, so only go ahead when one of them is the
  // local-path class we would have created anyway.
  const localPath = classes.find((sc) => sc.provisioner === LOCAL_PATH_PROVISIONER);

  return localPath ? { kind: 'markDefault', target: localPath.metadata?.name } : { kind: 'manual' };
}

/** Can the UI fix this itself, or does it need a human? */
export function storageRemedyFixable(remedy: StorageRemedy): boolean {
  return ['markDefault', 'create', 'install'].includes(remedy.kind);
}
