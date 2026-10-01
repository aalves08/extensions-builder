import { MANAGEMENT } from '@shell/config/types';
import { SETTING } from '@shell/config/settings';
import { ANNOTATION_PREVIOUS_UI_INDEX, ANNOTATION_PREVIOUS_UI_OFFLINE, NAMESPACE, buildName } from '../config/builder';
import { STEVE_TYPES } from './build-resources';
import { findOrNull } from './api';

/**
 * Pointing Rancher's own UI at a build.
 *
 * An extension built against a new shell can compile cleanly and still break at
 * runtime inside a stock host, because the host is the half that actually ships
 * the API. So the builder can also build the dashboard from the same PR, and
 * this swaps Rancher over to it.
 *
 * Two settings are involved:
 *   ui-dashboard-index    - where the index.html comes from
 *   ui-offline-preferred  - 'true' serves Rancher's embedded copy regardless,
 *                           so it has to go to 'false' for the above to apply
 *
 * This is global and affects every user of the Rancher install, which is why
 * the UI puts it behind its own clearly-warned card and always offers a revert.
 * The previous values are stashed on the build's ConfigMap - a resource we own
 * and delete with the build - so the revert survives a page reload.
 */

/** 'true' makes Rancher serve its embedded UI and ignore ui-dashboard-index. */
export const OFFLINE_PREFERRED_REMOTE = 'false';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Store = any;
type SteveResource = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface HostUiState {
  /** Currently in effect, whether from `value` or the setting's default. */
  index: string;
  offlinePreferred: string;
  /** True when ui-dashboard-index points at this build. */
  active: boolean;
  /** Values to restore, if this build swapped them. */
  previousIndex: string | null;
  previousOffline: string | null;
}

function effectiveValue(setting: SteveResource | null): string {
  if (!setting) {
    return '';
  }

  // Rancher leaves `value` empty when the setting has never been changed.
  return setting.value || setting.default || '';
}

async function findSetting(store: Store, name: string): Promise<SteveResource | null> {
  return findOrNull(store, MANAGEMENT.SETTING, name);
}

export async function readHostUiState(store: Store, id: string, expectedIndex: string): Promise<HostUiState> {
  const index = await findSetting(store, SETTING.UI_DASHBOARD_INDEX);
  const offline = await findSetting(store, SETTING.UI_OFFLINE_PREFERRED);
  const configMap = await findOrNull(store, STEVE_TYPES.CONFIG_MAP, `${ NAMESPACE }/${ buildName(id) }`);
  const annotations = configMap?.metadata?.annotations || {};

  const current = effectiveValue(index);

  return {
    index:            current,
    offlinePreferred: effectiveValue(offline),
    active:           !!expectedIndex && current === expectedIndex,
    previousIndex:    annotations[ANNOTATION_PREVIOUS_UI_INDEX] ?? null,
    previousOffline:  annotations[ANNOTATION_PREVIOUS_UI_OFFLINE] ?? null
  };
}

/**
 * Stash the current values on the build's ConfigMap, then point Rancher at the
 * build. The stash happens first and is only written once - a second apply must
 * not overwrite the original values with this build's own.
 */
export async function applyHostUi(store: Store, id: string, indexUrl: string): Promise<void> {
  const indexSetting = await findSetting(store, SETTING.UI_DASHBOARD_INDEX);
  const offlineSetting = await findSetting(store, SETTING.UI_OFFLINE_PREFERRED);

  if (!indexSetting || !offlineSetting) {
    throw new Error('Could not read the ui-dashboard-index / ui-offline-preferred settings');
  }

  const configMap = await findOrNull(store, STEVE_TYPES.CONFIG_MAP, `${ NAMESPACE }/${ buildName(id) }`);

  if (configMap) {
    const annotations = { ...(configMap.metadata?.annotations || {}) };

    if (annotations[ANNOTATION_PREVIOUS_UI_INDEX] === undefined) {
      annotations[ANNOTATION_PREVIOUS_UI_INDEX] = effectiveValue(indexSetting);
      annotations[ANNOTATION_PREVIOUS_UI_OFFLINE] = effectiveValue(offlineSetting);
      configMap.metadata.annotations = annotations;
      await configMap.save();
    }
  }

  indexSetting.value = indexUrl;
  await indexSetting.save();

  offlineSetting.value = OFFLINE_PREFERRED_REMOTE;
  await offlineSetting.save();
}

/** Put back whatever was stashed when the swap was applied. */
export async function revertHostUi(store: Store, id: string): Promise<void> {
  const configMap = await findOrNull(store, STEVE_TYPES.CONFIG_MAP, `${ NAMESPACE }/${ buildName(id) }`);
  const annotations = configMap?.metadata?.annotations || {};

  const indexSetting = await findSetting(store, SETTING.UI_DASHBOARD_INDEX);
  const offlineSetting = await findSetting(store, SETTING.UI_OFFLINE_PREFERRED);

  if (indexSetting) {
    indexSetting.value = annotations[ANNOTATION_PREVIOUS_UI_INDEX] ?? '';
    await indexSetting.save();
  }

  if (offlineSetting) {
    offlineSetting.value = annotations[ANNOTATION_PREVIOUS_UI_OFFLINE] ?? '';
    await offlineSetting.save();
  }

  if (configMap && annotations[ANNOTATION_PREVIOUS_UI_INDEX] !== undefined) {
    delete configMap.metadata.annotations[ANNOTATION_PREVIOUS_UI_INDEX];
    delete configMap.metadata.annotations[ANNOTATION_PREVIOUS_UI_OFFLINE];
    await configMap.save();
  }
}
