import {
  HelmIndex, expectedCharts, indexCharts, verifyIndex, verifyMessage
} from '../verify-repo';

const INDEX: HelmIndex = {
  entries: {
    kubewarden: [
      {
        name: 'kubewarden', version: '1.2.0', urls: ['plugin/kubewarden/kubewarden-1.2.0.tgz']
      },
      {
        name: 'kubewarden', version: '1.1.0', urls: ['plugin/kubewarden/kubewarden-1.1.0.tgz']
      }
    ],
    elemental: [{ name: 'elemental', version: '2.0.0' }]
  }
};

describe('indexCharts', () => {
  it('flattens one entry per chart version', () => {
    expect(indexCharts(INDEX)).toEqual([
      { name: 'kubewarden', version: '1.2.0' },
      { name: 'kubewarden', version: '1.1.0' },
      { name: 'elemental', version: '2.0.0' }
    ]);
  });

  it('drops a version entry with no version, which helm will not serve anyway', () => {
    expect(indexCharts({ entries: { broken: [{ name: 'broken' }] } })).toEqual([]);
  });

  it('falls back to the entry key when the version entry has no name', () => {
    expect(indexCharts({ entries: { keyed: [{ version: '1.0.0' }] } })).toEqual([{ name: 'keyed', version: '1.0.0' }]);
  });

  it.each([[null], [undefined], [{} as HelmIndex]])('is empty for %s', (index) => {
    expect(indexCharts(index as HelmIndex | null)).toEqual([]);
  });
});

describe('verifyIndex', () => {
  it('passes when every expected chart is present', () => {
    const result = verifyIndex(INDEX, [{ name: 'kubewarden', version: '1.2.0' }]);

    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('fails when a chart is missing, which is the case a green ClusterRepo hides', () => {
    const result = verifyIndex(INDEX, [{ name: 'kubewarden', version: '9.9.9' }]);

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([{ name: 'kubewarden', version: '9.9.9' }]);
  });

  it('matches on version, not just name', () => {
    expect(verifyIndex(INDEX, [{ name: 'elemental', version: '1.0.0' }]).ok).toBe(false);
  });

  it('fails on an empty index, which syncs to active perfectly happily', () => {
    const result = verifyIndex({ entries: {} }, [{ name: 'kubewarden', version: '1.2.0' }]);

    expect(result.ok).toBe(false);
    expect(result.found).toEqual([]);
  });

  it('fails when nothing was expected, because that means the build produced nothing', () => {
    expect(verifyIndex(INDEX, []).ok).toBe(false);
  });

  it('reports extra charts without failing, since older versions legitimately linger', () => {
    const result = verifyIndex(INDEX, [{ name: 'kubewarden', version: '1.2.0' }]);

    expect(result.ok).toBe(true);
    expect(result.unexpected).toEqual([
      { name: 'kubewarden', version: '1.1.0' },
      { name: 'elemental', version: '2.0.0' }
    ]);
  });
});

describe('expectedCharts', () => {
  it('keeps only name and version', () => {
    const packages = [{
      name: 'kubewarden', version: '1.2.0', repo: 'r', dist: 'd', source: 's'
    }];

    expect(expectedCharts(packages)).toEqual([{ name: 'kubewarden', version: '1.2.0' }]);
  });
});

describe('verifyMessage', () => {
  it('reports the chart count on success', () => {
    const message = verifyMessage(verifyIndex(INDEX, [{ name: 'elemental', version: '2.0.0' }]));

    expect(message.key).toBe('extensionsBuilder.detail.publish.verified');
    expect(message.args.count).toBe('3');
  });

  it('calls out an empty index specifically', () => {
    const message = verifyMessage(verifyIndex({ entries: {} }, [{ name: 'a', version: '1' }]));

    expect(message.key).toBe('extensionsBuilder.detail.publish.emptyIndex');
  });

  it('names the charts that are missing', () => {
    const message = verifyMessage(verifyIndex(INDEX, [{ name: 'kubewarden', version: '9.9.9' }]));

    expect(message.key).toBe('extensionsBuilder.detail.publish.missingCharts');
    expect(message.args.charts).toBe('kubewarden 9.9.9');
  });
});
