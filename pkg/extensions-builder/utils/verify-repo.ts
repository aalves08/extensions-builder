import { BuiltPackage } from '../types';

/**
 * Checking that a published build is actually usable.
 *
 * A ClusterRepo reaching `active` only means Rancher managed to fetch an
 * index.yaml. An empty index, or one missing the extension you came for,
 * reaches `active` just as happily - and then the Extensions page shows
 * nothing and there is no obvious reason why. So after the sync we read the
 * index back through Rancher (`clusterRepo.followLink('index')`) and assert
 * the charts we expect are in it.
 */

export interface HelmIndexVersion {
  name?: string;
  version?: string;
  urls?: string[];
  annotations?: Record<string, string>;
}

export interface HelmIndex {
  entries?: Record<string, HelmIndexVersion[]>;
}

export interface ExpectedChart {
  name: string;
  version: string;
}

export interface VerifyResult {
  ok: boolean;
  found: ExpectedChart[];
  /** Expected but not in the index. Non-empty means the publish is not usable. */
  missing: ExpectedChart[];
  /** In the index but not expected. Normally the leftovers of a previous build. */
  unexpected: ExpectedChart[];
}

/** Flatten a helm index into one entry per chart version. */
export function indexCharts(index: HelmIndex | null | undefined): ExpectedChart[] {
  const entries = index?.entries || {};

  return Object.keys(entries).flatMap((name) => (entries[name] || [])
    .filter((version) => !!version?.version)
    .map((version) => ({ name: version.name || name, version: version.version as string })));
}

export function verifyIndex(index: HelmIndex | null | undefined, expected: ExpectedChart[]): VerifyResult {
  const found = indexCharts(index);
  const key = (chart: ExpectedChart) => `${ chart.name }@${ chart.version }`;
  const foundKeys = new Set(found.map(key));
  const expectedKeys = new Set(expected.map(key));

  const missing = expected.filter((chart) => !foundKeys.has(key(chart)));
  const unexpected = found.filter((chart) => !expectedKeys.has(key(chart)));

  return {
    ok: missing.length === 0 && expected.length > 0,
    found,
    missing,
    unexpected
  };
}

/** The charts a build should have produced, from its built package list. */
export function expectedCharts(packages: Pick<BuiltPackage, 'name' | 'version'>[]): ExpectedChart[] {
  return packages.map(({ name, version }) => ({ name, version }));
}

/** One-line description of a verification result, as an i18n key plus args. */
export function verifyMessage(result: VerifyResult): { key: string; args: Record<string, string> } {
  if (result.ok) {
    return {
      key:  'extensionsBuilder.detail.publish.verified',
      args: { count: String(result.found.length) }
    };
  }

  if (result.found.length === 0) {
    return { key: 'extensionsBuilder.detail.publish.emptyIndex', args: {} };
  }

  return {
    key:  'extensionsBuilder.detail.publish.missingCharts',
    args: { charts: result.missing.map((chart) => `${ chart.name } ${ chart.version }`).join(', ') }
  };
}
