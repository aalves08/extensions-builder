import { MANAGED_BY } from '../config/builder';
import { STEVE_TYPES } from './build-resources';

/**
 * The local-path provisioner, as plain objects.
 *
 * A cluster with no StorageClass at all needs something behind the class before
 * a class is worth creating - annotating a class whose provisioner is not
 * running leaves the PVC Pending just the same, only with a less obvious cause.
 * So when there is nothing there, the UI installs the provisioner too.
 *
 * This mirrors deploy/local-path-storage.yaml from
 * rancher/local-path-provisioner at the tag in LOCAL_PATH_VERSION. It is a
 * copy, so it goes stale: when bumping the version, re-read the upstream file
 * rather than only changing the image tag.
 *
 * It is the same provisioner k3s and RKE2 ship, which is why a cluster that
 * already has one is left well alone.
 */

export const LOCAL_PATH_VERSION = 'v0.0.31';
export const LOCAL_PATH_IMAGE = `rancher/local-path-provisioner:${ LOCAL_PATH_VERSION }`;

/** Upstream's namespace. k3s and RKE2 instead run theirs in kube-system. */
export const LOCAL_PATH_NAMESPACE = 'local-path-storage';
export const LOCAL_PATH_SA = 'local-path-provisioner-service-account';
export const LOCAL_PATH_ROLE = 'local-path-provisioner-role';
export const LOCAL_PATH_BINDING = 'local-path-provisioner-bind';
export const LOCAL_PATH_CONFIG = 'local-path-config';
export const LOCAL_PATH_PROVISIONER_NAME = 'local-path-provisioner';

/**
 * Where a provisioner might already be running, most likely first. Checked
 * before installing anything, so a k3s cluster is never given a second one.
 */
export const LOCAL_PATH_DEPLOYMENTS = [
  `kube-system/${ LOCAL_PATH_PROVISIONER_NAME }`,
  `${ LOCAL_PATH_NAMESPACE }/${ LOCAL_PATH_PROVISIONER_NAME }`
];

/**
 * Deliberately not `app.kubernetes.io/managed-by`, which is what the extension
 * selects its own objects by. This is shared cluster storage: deleting a build,
 * or the extension itself, must never take the provisioner with it. The
 * annotation records who created it without making it selectable.
 */
const CREATED_BY = 'extensions-builder.cattle.io/created-by';

const meta = (name: string, namespaced = true) => ({
  name,
  ...(namespaced ? { namespace: LOCAL_PATH_NAMESPACE } : {}),
  labels:      { app: LOCAL_PATH_PROVISIONER_NAME },
  annotations: { [CREATED_BY]: MANAGED_BY }
});

const subjects = () => [{
  kind: 'ServiceAccount', name: LOCAL_PATH_SA, namespace: LOCAL_PATH_NAMESPACE
}];

const CONFIG_JSON = JSON.stringify({
  nodePathMap: [{
    node:  'DEFAULT_PATH_FOR_NON_LISTED_NODES',
    paths: ['/opt/local-path-provisioner']
  }]
}, null, 4);

const SETUP = `#!/bin/sh
set -eu
mkdir -m 0777 -p "$VOL_DIR"
`;

const TEARDOWN = `#!/bin/sh
set -eu
rm -rf "$VOL_DIR"
`;

const HELPER_POD = `apiVersion: v1
kind: Pod
metadata:
  name: helper-pod
spec:
  priorityClassName: system-node-critical
  tolerations:
    - key: node.kubernetes.io/disk-pressure
      operator: Exists
      effect: NoSchedule
  containers:
  - name: helper-pod
    image: busybox
    imagePullPolicy: IfNotPresent
`;

/**
 * Every object the provisioner needs, in the order they must be created.
 *
 * The namespace is first because everything namespaced depends on it, and the
 * ServiceAccount is before the Deployment so the pod is never scheduled without
 * the identity it needs. The StorageClass is deliberately not here - whether to
 * create it, and whether to mark it default, is decided separately in
 * utils/bootstrap.ts.
 */
export function localPathObjects(): Record<string, unknown>[] {
  return [
    {
      type:     STEVE_TYPES.NAMESPACE,
      metadata: meta(LOCAL_PATH_NAMESPACE, false)
    },
    {
      type:     STEVE_TYPES.SERVICE_ACCOUNT,
      metadata: meta(LOCAL_PATH_SA)
    },
    {
      type:     STEVE_TYPES.CONFIG_MAP,
      metadata: meta(LOCAL_PATH_CONFIG),
      data:     {
        'config.json':    CONFIG_JSON,
        setup:            SETUP,
        teardown:         TEARDOWN,
        'helperPod.yaml': HELPER_POD
      }
    },
    {
      type:     STEVE_TYPES.ROLE,
      metadata: meta(LOCAL_PATH_ROLE),
      // The provisioner creates a short-lived helper pod per volume, in its own
      // namespace, to make and remove the directory on the node.
      rules:    [{
        apiGroups: [''],
        resources: ['pods'],
        verbs:     ['get', 'list', 'watch', 'create', 'patch', 'update', 'delete']
      }]
    },
    {
      type:     STEVE_TYPES.CLUSTER_ROLE,
      metadata: meta(LOCAL_PATH_ROLE, false),
      rules:    [
        {
          apiGroups: [''],
          resources: ['nodes', 'persistentvolumeclaims', 'configmaps', 'pods', 'pods/log'],
          verbs:     ['get', 'list', 'watch']
        },
        {
          apiGroups: [''],
          resources: ['persistentvolumes'],
          verbs:     ['get', 'list', 'watch', 'create', 'patch', 'update', 'delete']
        },
        {
          apiGroups: [''], resources: ['events'], verbs: ['create', 'patch']
        },
        {
          apiGroups: ['storage.k8s.io'], resources: ['storageclasses'], verbs: ['get', 'list', 'watch']
        }
      ]
    },
    {
      type:     STEVE_TYPES.ROLE_BINDING,
      metadata: meta(LOCAL_PATH_BINDING),
      roleRef:  {
        apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: LOCAL_PATH_ROLE
      },
      subjects: subjects()
    },
    {
      type:     STEVE_TYPES.CLUSTER_ROLE_BINDING,
      metadata: meta(LOCAL_PATH_BINDING, false),
      roleRef:  {
        apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: LOCAL_PATH_ROLE
      },
      subjects: subjects()
    },
    {
      type:     STEVE_TYPES.DEPLOYMENT,
      metadata: meta(LOCAL_PATH_PROVISIONER_NAME),
      spec:     {
        replicas: 1,
        selector: { matchLabels: { app: LOCAL_PATH_PROVISIONER_NAME } },
        template: {
          metadata: { labels: { app: LOCAL_PATH_PROVISIONER_NAME } },
          spec:     {
            serviceAccountName: LOCAL_PATH_SA,
            containers:         [{
              name:            LOCAL_PATH_PROVISIONER_NAME,
              image:           LOCAL_PATH_IMAGE,
              imagePullPolicy: 'IfNotPresent',
              command:         [
                'local-path-provisioner', '--debug', 'start', '--config', '/etc/config/config.json'
              ],
              volumeMounts: [{ name: 'config-volume', mountPath: '/etc/config/' }],
              env:          [
                { name: 'POD_NAMESPACE', valueFrom: { fieldRef: { fieldPath: 'metadata.namespace' } } },
                { name: 'CONFIG_MOUNT_PATH', value: '/etc/config/' }
              ]
            }],
            volumes: [{ name: 'config-volume', configMap: { name: LOCAL_PATH_CONFIG } }]
          }
        }
      }
    }
  ];
}
