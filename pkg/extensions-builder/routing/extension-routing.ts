import { BLANK_CLUSTER, PRODUCT_NAME, ROUTE_BUILDS, ROUTE_NEW_BUILD } from '../config/builder';

/**
 * The pages, as vue-router records. Under the old-style registration these are
 * ours to declare; `addProduct(metadata, pages)` used to generate them.
 *
 * `product` and `cluster` go in meta because the shell reads them off the
 * active route to work out which product's side menu to render and which store
 * to resolve against. `pkg` is what tells it the route belongs to this
 * extension, so unloading the extension takes its routes with it.
 *
 * Paths are relative, and `parent: 'default'` mounts them under the shell's
 * default layout route, which sits at `/` - so they resolve to
 * /extensions-builder/c/_/<page>. Naming the parent is not optional dressing:
 * `addRoute` with no parent logs a deprecation warning and assumes 'default'
 * anyway.
 */
const meta = {
  product: PRODUCT_NAME,
  cluster: BLANK_CLUSTER,
  pkg:     PRODUCT_NAME
};

export default [
  {
    parent: 'default',
    route:  {
      name:      ROUTE_BUILDS,
      path:      `${ PRODUCT_NAME }/c/:cluster/builds`,
      component: () => import('../pages/Builds.vue'),
      meta
    }
  },
  {
    parent: 'default',
    route:  {
      name:      ROUTE_NEW_BUILD,
      path:      `${ PRODUCT_NAME }/c/:cluster/new`,
      component: () => import('../pages/NewBuild.vue'),
      meta
    }
  }
];
