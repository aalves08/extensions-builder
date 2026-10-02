import { IPlugin } from '@shell/core/types';
import { IF_HAVE } from '@shell/store/type-map';
import { BLANK_CLUSTER, PRODUCT_NAME, ROUTE_BUILDS, ROUTE_NEW_BUILD } from './config/builder';

/**
 * Product registration, done through the type-map DSL rather than the New
 * Product Registration API. The reasoning is in index.ts.
 *
 * Everything below is what `addProduct` would have produced from the metadata
 * object it replaced, written out by hand: a top-level product in the
 * management store, admin-only, with two custom pages in the side menu.
 */
export function init($plugin: IPlugin, store: unknown): void {
  const { basicType, product, virtualType } = $plugin.DSL(store, PRODUCT_NAME);

  const to = (name: string) => ({
    name,
    params: {
      product: PRODUCT_NAME,
      cluster: BLANK_CLUSTER,
      pkg:     PRODUCT_NAME
    }
  });

  product({
    labelKey: 'extensionsBuilder.product.label',

    /**
     * A top-level product rather than something hung off the explorer: a build
     * is not scoped to a cluster the user has selected. Everything it creates
     * lives in the local cluster, which is what the `management` store
     * addresses, so there is no cluster to switch between either.
     *
     * `category` only has to be none of 'configuration', 'legacy' or 'hci' for
     * the product to land in the main list in the side nav; 'global' is what
     * the shell's own top-level extension products use.
     */
    category:            'global',
    inStore:             'management',
    showClusterSwitcher: false,
    icon:                'pipeline',
    weight:              1,
    to:                  to(ROUTE_BUILDS),

    /**
     * A build creates cluster-scoped objects (a ClusterRepo) and, with the host
     * UI toggle, rewrites global settings. Showing the product to anyone else
     * would only produce 403s.
     */
    ifHave: IF_HAVE.ADMIN,

    // None of these apply - the product never targets a downstream cluster.
    hideCopyConfig: true,
    hideKubeConfig: true,
    hideKubeShell:  true
  });

  basicType(['builds', 'new']);

  virtualType({
    name:       'builds',
    labelKey:   'extensionsBuilder.nav.builds',
    namespaced: false,
    weight:     100,
    route:      to(ROUTE_BUILDS)
  });

  virtualType({
    name:       'new',
    labelKey:   'extensionsBuilder.nav.new',
    namespaced: false,
    weight:     90,
    route:      to(ROUTE_NEW_BUILD)
  });
}
