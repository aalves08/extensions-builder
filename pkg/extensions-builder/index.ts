import { importTypes } from '@rancher/auto-import';
import { IPlugin } from '@shell/core/types';
import { IF_HAVE } from '@shell/store/type-map';
import { PRODUCT_NAME } from './config/builder';

// Init the package
export default function(plugin: IPlugin): void {
  // Auto-import model, detail, edit from the folders
  importTypes(plugin);

  // Provide plugin metadata from package.json
  plugin.metadata = require('./package.json');

  /**
   * A top-level product rather than something hung off the explorer: a build is
   * not scoped to a cluster the user has selected. Everything it creates lives
   * in the local cluster, which is what the `management` store addresses.
   *
   * Gated on IF_HAVE.ADMIN because a build creates cluster-scoped objects
   * (a ClusterRepo) and, with the host UI toggle, rewrites global settings.
   * Showing the product to anyone else would only produce 403s.
   */
  plugin.addProduct({
    name:     PRODUCT_NAME,
    labelKey: 'extensionsBuilder.product.label',
    enable:   { ifHave: IF_HAVE.ADMIN },
    sideBar:  {
      weight: 1,
      icon:   { name: 'pipeline' }
    },
    resources: { store: 'management' },
    appHeader: {
      // None of these apply - the product never targets a downstream cluster.
      hideCopyConfig: true,
      hideKubeConfig: true,
      hideKubeShell:  true
    }
  }, [
    {
      name:      'builds',
      labelKey:  'extensionsBuilder.nav.builds',
      component: () => import('./pages/Builds.vue'),
      sideMenu:  { weight: 100 }
    },
    {
      name:      'new',
      labelKey:  'extensionsBuilder.nav.new',
      component: () => import('./pages/NewBuild.vue'),
      sideMenu:  { weight: 90 }
    }
  ]);
}
