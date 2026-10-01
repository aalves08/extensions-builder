import { NAMESPACE } from '../../config/builder';
import {
  PreflightInput, countDefaultStorageClasses, preflightBlocked, preflightFailures, preflightWarnings, runPreflight
} from '../preflight';

const ALL_GOOD: PreflightInput = {
  isAdmin:               true,
  hasClusterRepoSchema:  true,
  hasJobSchema:          true,
  defaultStorageClasses: 1,
  storage:               { kind: 'ok' },
  namespaceExists:       true,
  nginxConfigExists:     true
};

const resultFor = (input: Partial<PreflightInput>, id: string) => runPreflight({ ...ALL_GOOD, ...input })
  .find((result) => result.id === id);

describe('runPreflight', () => {
  it('passes everything when the cluster is ready', () => {
    const results = runPreflight(ALL_GOOD);

    expect(results.every((result) => result.ok)).toBe(true);
    expect(preflightBlocked(results)).toBe(false);
  });

  it.each([
    [{ isAdmin: false }, 'admin'],
    [{ namespaceExists: false }, 'namespace'],
    [{ nginxConfigExists: false }, 'nginxConfig'],
    [{ hasJobSchema: false }, 'jobSchema'],
    [{ hasClusterRepoSchema: false }, 'clusterRepoSchema'],
    [{ defaultStorageClasses: 0, storage: { kind: 'manual' as const } }, 'storageClass']
  ])('blocks on %o', (input, id) => {
    const result = resultFor(input, id);

    expect(result?.ok).toBe(false);
    expect(result?.warningOnly).toBe(false);
    expect(preflightBlocked(runPreflight({ ...ALL_GOOD, ...input }))).toBe(true);
  });

  it('names the namespace in the message args, so the user knows what to install', () => {
    expect(resultFor({ namespaceExists: false }, 'namespace')?.messageArgs).toEqual({ namespace: NAMESPACE });
  });
});

describe('runPreflight fixability', () => {
  it.each([
    [{ namespaceExists: false }, 'namespace', 'namespace'],
    [{ nginxConfigExists: false }, 'nginxConfig', 'nginxConfig']
  ])('offers to fix %o', (input, id, remedy) => {
    expect(resultFor(input, id)?.fixable).toBe(remedy);
  });

  it.each([
    [{ namespaceExists: false }, 'namespace'],
    [{ nginxConfigExists: false }, 'nginxConfig']
  ])('does not offer %o to a non-admin, who could not carry it out', (input, id) => {
    expect(resultFor({ ...input, isAdmin: false }, id)?.fixable).toBeUndefined();
  });

  it.each([
    ['markDefault' as const, 'extensionsBuilder.preflight.storageClassNotDefault', 'storageClass'],
    ['create' as const, 'extensionsBuilder.preflight.storageClassCreatable', 'storageClass'],
    ['install' as const, 'extensionsBuilder.preflight.storageClassInstallable', 'storageClass'],
    ['manual' as const, 'extensionsBuilder.preflight.noStorageClass', undefined]
  ])('maps the %s remedy to its own message and fixability', (kind, messageKey, fixable) => {
    const result = resultFor({ defaultStorageClasses: 0, storage: { kind, target: 'fast' } }, 'storageClass');

    expect(result?.messageKey).toBe(messageKey);
    expect(result?.fixable).toBe(fixable);
  });

  it('names the class in the message args so the user knows what is about to change', () => {
    const result = resultFor({ defaultStorageClasses: 0, storage: { kind: 'markDefault', target: 'fast' } }, 'storageClass');

    expect(result?.messageArgs).toEqual({ name: 'fast' });
  });

  it('never offers to fix a check that needs a human', () => {
    const results = runPreflight({
      ...ALL_GOOD, isAdmin: false, hasJobSchema: false
    });

    expect(results.filter((r) => r.fixable).map((r) => r.id)).toEqual([]);
  });
});

describe('runPreflight storage', () => {
  it('warns rather than blocks on more than one default StorageClass', () => {
    const results = runPreflight({ ...ALL_GOOD, defaultStorageClasses: 2 });
    const storageClass = results.find((result) => result.id === 'storageClass');

    expect(storageClass?.ok).toBe(false);
    expect(storageClass?.warningOnly).toBe(true);
    expect(storageClass?.messageKey).toBe('extensionsBuilder.preflight.multipleStorageClasses');
    expect(preflightBlocked(results)).toBe(false);
    expect(preflightWarnings(results)).toHaveLength(1);
  });

  it('uses the "none at all" message when nothing can be done automatically', () => {
    expect(resultFor({ defaultStorageClasses: 0, storage: { kind: 'manual' } }, 'storageClass')?.messageKey)
      .toBe('extensionsBuilder.preflight.noStorageClass');
  });

  it('passes the storage check once something is the default', () => {
    expect(resultFor({}, 'storageClass')?.ok).toBe(true);
  });

  it('separates failures from warnings', () => {
    const results = runPreflight({
      ...ALL_GOOD, isAdmin: false, defaultStorageClasses: 3
    });

    expect(preflightFailures(results).map((r) => r.id)).toEqual(['admin']);
    expect(preflightWarnings(results).map((r) => r.id)).toEqual(['storageClass']);
  });
});

describe('countDefaultStorageClasses', () => {
  const sc = (annotations: Record<string, string>) => ({ metadata: { annotations } });

  it('counts the current annotation', () => {
    expect(countDefaultStorageClasses([sc({ 'storageclass.kubernetes.io/is-default-class': 'true' })])).toBe(1);
  });

  it('counts the pre-1.6 beta annotation some older storage addons still set', () => {
    expect(countDefaultStorageClasses([sc({ 'storageclass.beta.kubernetes.io/is-default-class': 'true' })])).toBe(1);
  });

  it('does not double-count a class carrying both annotations', () => {
    const both = sc({
      'storageclass.kubernetes.io/is-default-class':      'true',
      'storageclass.beta.kubernetes.io/is-default-class': 'true'
    });

    expect(countDefaultStorageClasses([both])).toBe(1);
  });

  it('ignores an annotation explicitly set to false', () => {
    expect(countDefaultStorageClasses([sc({ 'storageclass.kubernetes.io/is-default-class': 'false' })])).toBe(0);
  });

  it('ignores a class with no annotations at all', () => {
    expect(countDefaultStorageClasses([{}, { metadata: {} }])).toBe(0);
  });

  it.each([[[]], [null], [undefined]])('is zero for %s', (input) => {
    expect(countDefaultStorageClasses(input as [])).toBe(0);
  });
});
