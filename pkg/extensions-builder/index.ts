import { importTypes } from '@rancher/auto-import';
import { IPlugin } from '@shell/core/types';
import extensionRouting from './routing/extension-routing';

/**
 * The product is registered the old way - `addProduct(require('./product'))`
 * plus explicit routes - and not with the New Product Registration API, which
 * is otherwise the recommended thing to use and which this extension used
 * first. The swap was deliberate, and it is about which Rancher versions can
 * load this at all.
 *
 * The new API lives in `@shell/core/plugin-products-external`, and that module
 * first appears in release-2.15. On an older host the import resolves to
 * nothing and the extension fails to register - not gracefully, and not with an
 * error that points anywhere useful.
 *
 * Nothing stops it being installed there, either. The two annotations in
 * package.json are the only gate, and only one of them does anything:
 *
 *   - `ui-extensions-version` is matched against the *shell* version, and every
 *     release from 2.12 to 2.15 ships a 3.0.x shell (3.0.5, 3.0.8, 3.0.9,
 *     3.0.13). It cannot tell them apart.
 *   - `rancher-version` is matched against the backend `/rancherversion`, so it
 *     can - but it describes the server, not the UI. Anyone who has pointed
 *     `ui-dashboard-index` at a different dashboard bundle, which is exactly
 *     what this extension's host-UI toggle does, has already decoupled the two.
 *
 * So the floor was a real one, and the audience is the wrong one to impose it
 * on: the people who want to build a shell PR and try extensions against it are
 * also the people still running 2.12 and 2.13 locally.
 *
 * The old registration is plain type-map DSL, unchanged for years and present
 * in every one of those releases, and the result is identical - the same
 * top-level admin-only product with the same two pages. The cost is about forty
 * lines in product.ts and extension-routing.ts that the new API would have
 * generated. Everything else this extension imports from the shell was checked
 * against release-2.12 and is there.
 *
 * If the floor ever rises to 2.15 for other reasons, this is worth reverting:
 * the new API is the supported path and the metadata form is easier to read.
 */
export default function(plugin: IPlugin): void {
  // Auto-import model, detail, edit from the folders
  importTypes(plugin);

  // Provide plugin metadata from package.json
  plugin.metadata = require('./package.json');

  plugin.addProduct(require('./product'));
  plugin.addRoutes(extensionRouting);
}
