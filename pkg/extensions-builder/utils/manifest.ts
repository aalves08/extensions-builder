import { MANIFEST_URL } from '../config/builder';
import { PickerRow } from '../types';

/**
 * Discovery of the official extensions, from
 * https://github.com/rancher/ui-plugin-charts/blob/main/manifest.json
 *
 * One thing in that file is a trap: every entry says `"branch": "gh-pages"`.
 * That is where the *published charts* live, not the source. Building from
 * gh-pages would get you a tree with no pkg/ directory at all. So we ignore
 * `branch` entirely and leave the ref empty, which makes the builder clone the
 * repo's default branch. The user can override it per row.
 *
 * The manifest key doubles as the package name (`pkg/<key>`), which holds for
 * every entry today and matches the ORG/REPO/PKG triples hard-coded in
 * rancher/dashboard's shell/scripts/test-plugins-build.sh.
 */

export interface ManifestEntry {
  repo: string;
  branch: string;
  versions: string[];
}

export interface Manifest {
  extensions: Record<string, ManifestEntry>;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Turn the manifest into picker rows, sorted by name so the list is stable. */
export function manifestToRows(manifest: Manifest | null | undefined): PickerRow[] {
  const extensions = manifest?.extensions;

  if (!extensions) {
    return [];
  }

  return Object.keys(extensions)
    .sort()
    .map((key) => {
      const entry = extensions[key] || {} as ManifestEntry;
      const versions = Array.isArray(entry.versions) ? [...entry.versions].reverse() : [];

      return {
        name:     key,
        pkg:      key,
        repo:     entry.repo ? `https://github.com/${ entry.repo }.git` : '',
        ref:      '',
        official: true,
        selected: false,
        versions
      };
    })
    .filter((row) => !!row.repo);
}

/** A blank row for a git URL the user types in themselves. */
export function emptyRow(): PickerRow {
  return {
    name:     '',
    pkg:      '',
    repo:     '',
    ref:      '',
    official: false,
    selected: true,
    versions: []
  };
}

/**
 * Per-row validation. Returns an i18n key for the first problem found, or null.
 * `names` is every other row's name, so duplicates can be caught - the builder
 * clones each extension into a directory named after it and would otherwise
 * silently overwrite one with the other.
 */
export function validateRow(row: PickerRow, otherNames: string[]): string | null {
  if (!row.repo?.trim()) {
    return 'extensionsBuilder.new.extensions.errors.noRepo';
  }

  if (!/^(https?:\/\/|git@)/.test(row.repo.trim())) {
    return 'extensionsBuilder.new.extensions.errors.badRepo';
  }

  if (!row.pkg?.trim()) {
    return 'extensionsBuilder.new.extensions.errors.noPkg';
  }

  if (!row.name?.trim()) {
    return 'extensionsBuilder.new.extensions.errors.noName';
  }

  if (otherNames.includes(row.name.trim())) {
    return 'extensionsBuilder.new.extensions.errors.duplicateName';
  }

  return null;
}

/** Validate the selected rows together. Returns one error key per offending row index. */
export function validateRows(rows: PickerRow[]): Record<number, string> {
  const errors: Record<number, string> = {};
  const selected = rows.filter((row) => row.selected);

  rows.forEach((row, index) => {
    if (!row.selected) {
      return;
    }

    const others = selected.filter((other) => other !== row).map((other) => (other.name || '').trim());
    const error = validateRow(row, others);

    if (error) {
      errors[index] = error;
    }
  });

  return errors;
}

export async function fetchManifest(doFetch: FetchLike = (input, init) => fetch(input, init)): Promise<PickerRow[]> {
  const res = await doFetch(MANIFEST_URL, { headers: { Accept: 'application/json' } });

  if (!res.ok) {
    throw new Error(`Could not read the extensions manifest (HTTP ${ res.status })`);
  }

  return manifestToRows(await res.json());
}
