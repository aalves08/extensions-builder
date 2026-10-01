import { PickerRow } from '../../types';
import {
  Manifest, emptyRow, fetchManifest, manifestToRows, validateRow, validateRows
} from '../manifest';

const MANIFEST: Manifest = {
  extensions: {
    kubewarden: {
      repo:     'rancher/kubewarden-ui',
      branch:   'gh-pages',
      versions: ['1.0.0', '1.1.0', '1.2.0']
    },
    elemental: {
      repo:     'rancher/elemental-ui',
      branch:   'gh-pages',
      versions: ['2.0.0']
    }
  }
};

const row = (over: Partial<PickerRow> = {}): PickerRow => ({
  ...emptyRow(), name: 'a', pkg: 'a', repo: 'https://github.com/o/r.git', ...over
});

describe('manifestToRows', () => {
  it('maps every entry and sorts by name', () => {
    const rows = manifestToRows(MANIFEST);

    expect(rows.map((r) => r.name)).toEqual(['elemental', 'kubewarden']);
  });

  it('ignores the manifest branch, which is gh-pages and holds charts rather than source', () => {
    const rows = manifestToRows(MANIFEST);

    expect(rows.every((r) => r.ref === '')).toBe(true);
  });

  it('uses the manifest key as both the name and the pkg folder', () => {
    const [, kubewarden] = manifestToRows(MANIFEST);

    expect(kubewarden.name).toBe('kubewarden');
    expect(kubewarden.pkg).toBe('kubewarden');
  });

  it('builds a clone url from the owner/repo in the entry', () => {
    const [, kubewarden] = manifestToRows(MANIFEST);

    expect(kubewarden.repo).toBe('https://github.com/rancher/kubewarden-ui.git');
  });

  it('lists versions newest first, for display only', () => {
    const [, kubewarden] = manifestToRows(MANIFEST);

    expect(kubewarden.versions).toEqual(['1.2.0', '1.1.0', '1.0.0']);
  });

  it('starts everything unselected', () => {
    expect(manifestToRows(MANIFEST).every((r) => !r.selected)).toBe(true);
  });

  it('drops an entry with no repo rather than producing an unbuildable row', () => {
    const rows = manifestToRows({
      extensions: {
        broken: {
          repo: '', branch: '', versions: []
        }
      }
    });

    expect(rows).toEqual([]);
  });

  it.each([[null], [undefined], [{} as Manifest]])('returns nothing for %s', (input) => {
    expect(manifestToRows(input as Manifest | null)).toEqual([]);
  });
});

describe('validateRow', () => {
  it('accepts a complete row', () => {
    expect(validateRow(row(), [])).toBeNull();
  });

  it('accepts an ssh clone url', () => {
    expect(validateRow(row({ repo: 'git@github.com:o/r.git' }), [])).toBeNull();
  });

  it.each([
    [{ repo: '' }, 'noRepo'],
    [{ repo: 'github.com/o/r' }, 'badRepo'],
    [{ pkg: '' }, 'noPkg'],
    [{ name: '' }, 'noName']
  ])('rejects %o with %s', (over, suffix) => {
    expect(validateRow(row(over), [])).toBe(`extensionsBuilder.new.extensions.errors.${ suffix }`);
  });

  it('rejects a name another selected row already uses, because the clone dirs would collide', () => {
    expect(validateRow(row({ name: 'dup' }), ['dup'])).toBe('extensionsBuilder.new.extensions.errors.duplicateName');
  });
});

describe('validateRows', () => {
  it('ignores unselected rows entirely', () => {
    const rows = [row({ selected: false, repo: '' }), row({ selected: true })];

    expect(validateRows(rows)).toEqual({});
  });

  it('flags both halves of a duplicate pair, by index', () => {
    const rows = [row({ name: 'same' }), row({ name: 'same' })];

    expect(validateRows(rows)).toEqual({
      0: 'extensionsBuilder.new.extensions.errors.duplicateName',
      1: 'extensionsBuilder.new.extensions.errors.duplicateName'
    });
  });

  it('does not treat a row as a duplicate of itself', () => {
    expect(validateRows([row({ name: 'solo' })])).toEqual({});
  });
});

describe('fetchManifest', () => {
  it('returns rows on success', async() => {
    const doFetch = jest.fn().mockResolvedValue({
      ok: true, status: 200, json: () => Promise.resolve(MANIFEST)
    });

    await expect(fetchManifest(doFetch)).resolves.toHaveLength(2);
  });

  it('throws with the status when the manifest cannot be read', async() => {
    const doFetch = jest.fn().mockResolvedValue({
      ok: false, status: 404, json: () => Promise.resolve({})
    });

    await expect(fetchManifest(doFetch)).rejects.toThrow('HTTP 404');
  });
});
