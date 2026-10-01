import { MANAGEMENT } from '@shell/config/types';
import { LOCAL_CLUSTER } from './steve-proxy';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Store = any;
type SteveResource = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface ClusterOption {
  /** The id Rancher proxies the cluster under: `/k8s/clusters/<value>/v1`. */
  value: string;
  label: string;
}

/**
 * The clusters a storage provisioner could be installed into.
 *
 * Only ready clusters are offered. An unreachable one would fail on the first
 * request with a proxy error that says nothing useful about why.
 *
 * Local is pinned to the top and is the default everywhere, because it is the
 * cluster builds actually run in - the others are a convenience, not part of
 * the build path.
 */
export function clusterOptions(store: Store): ClusterOption[] {
  const clusters: SteveResource[] = store.getters['management/all'](MANAGEMENT.CLUSTER) || [];

  const options = clusters
    .filter((cluster) => cluster?.metadata?.name && cluster.isReady)
    .map((cluster) => ({
      value: cluster.metadata.name,
      label: cluster.nameDisplay || cluster.metadata.name
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const local = options.find((option) => option.value === LOCAL_CLUSTER);
  const rest = options.filter((option) => option.value !== LOCAL_CLUSTER);

  // Always offer local, even if the management schema is not loaded and the
  // list above came back empty. It is where builds run, so it is never wrong.
  return [local || { value: LOCAL_CLUSTER, label: LOCAL_CLUSTER }, ...rest];
}
