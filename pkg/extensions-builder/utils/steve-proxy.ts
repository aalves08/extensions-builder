/* eslint-disable @typescript-eslint/no-explicit-any */
type Store = any;
type SteveResource = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * A minimal Steve client for a cluster other than the one the store is bound
 * to.
 *
 * The `management` store only ever talks to the local cluster, and the
 * `cluster` store only to whichever cluster the user has navigated into.
 * Neither can reach a third cluster, which is what installing a storage
 * provisioner somewhere else needs. Rancher already proxies every cluster at
 * `/k8s/clusters/<id>/v1`, so this goes straight at that, using the store only
 * as an HTTP client that knows how to authenticate.
 *
 * Deliberately small: get, create, update. Anything that wants caching,
 * reactivity or models should go through the store instead.
 */

/** Rancher proxies the local cluster at this path too, so there is no special case. */
export const LOCAL_CLUSTER = 'local';

export class ClusterClient {
  readonly clusterId: string;

  private store: Store;
  private base: string;
  private collections: Record<string, string> | null = null;

  constructor(store: Store, clusterId: string) {
    this.store = store;
    this.clusterId = clusterId;
    this.base = `/k8s/clusters/${ clusterId }/v1`;
  }

  private request(opt: Record<string, unknown>): Promise<SteveResource> {
    return this.store.dispatch('management/request', opt);
  }

  /**
   * Resolve each type to its collection URL by reading the target cluster's
   * schemas, rather than assembling a path from the type name.
   *
   * Steve derives those paths itself and they are not uniformly guessable, so
   * asking is the only way to be right. It doubles as the permission check: a
   * type with no collection link is one this user cannot list, and failing
   * here is far clearer than a 404 midway through an install.
   */
  private async collectionFor(type: string): Promise<string> {
    if (!this.collections) {
      const res = await this.request({ url: `${ this.base }/schemas`, method: 'GET' });

      this.collections = (res?.data || []).reduce((acc: Record<string, string>, schema: SteveResource) => {
        if (schema?.id && schema?.links?.collection) {
          acc[schema.id] = schema.links.collection;
        }

        return acc;
      }, {});
    }

    const url = this.collections?.[type];

    if (!url) {
      throw new Error(`Cannot manage ${ type } in cluster ${ this.clusterId }: not available, or not permitted.`);
    }

    return url;
  }

  /** The resource, or null if it is not there. A 404 is an expected answer here. */
  async get(type: string, id: string): Promise<SteveResource | null> {
    const collection = await this.collectionFor(type);

    try {
      return await this.request({ url: `${ collection }/${ id }`, method: 'GET' });
    } catch {
      return null;
    }
  }

  /** Everything of a type. Empty rather than throwing when there is none. */
  async list(type: string): Promise<SteveResource[]> {
    const collection = await this.collectionFor(type);
    const res = await this.request({ url: collection, method: 'GET' });

    return res?.data || [];
  }

  async create(type: string, object: Record<string, unknown>): Promise<SteveResource> {
    const collection = await this.collectionFor(type);

    return this.request({
      url:     collection,
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      data:    object
    });
  }

  /**
   * Read, change, write back.
   *
   * Steve wants the whole object on a PUT, including the resourceVersion it
   * just handed us - which is what makes this safe against a concurrent edit:
   * the write is rejected rather than silently clobbering.
   */
  async update(type: string, id: string, mutate: (object: SteveResource) => void): Promise<SteveResource | null> {
    const collection = await this.collectionFor(type);
    const existing = await this.get(type, id);

    if (!existing) {
      return null;
    }

    mutate(existing);

    return this.request({
      url:     `${ collection }/${ id }`,
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      data:    existing
    });
  }
}

export function clusterClient(store: Store, clusterId = LOCAL_CLUSTER): ClusterClient {
  return new ClusterClient(store, clusterId || LOCAL_CLUSTER);
}
