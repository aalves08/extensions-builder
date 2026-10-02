import { BuildPhase } from '../../types';
import { parseBuildLog, reconcilePhases } from '../build-log';

const stateOf = (phases: BuildPhase[], name: string) => phases.find((p) => p.name === name)?.state;

describe('parseBuildLog', () => {
  it('starts every phase pending', () => {
    const { phases } = parseBuildLog('');

    expect(phases).toHaveLength(5);
    expect(phases.every((p) => p.state === 'pending')).toBe(true);
  });

  it.each([[null], [undefined], ['']])('survives %s', (input) => {
    expect(parseBuildLog(input).currentPhase).toBeNull();
  });

  it('tracks a phase through start and ok', () => {
    const { phases, currentPhase } = parseBuildLog([
      '::phase::resolve::start',
      '::phase::resolve::ok'
    ].join('\n'));

    expect(stateOf(phases, 'resolve')).toBe('success');
    expect(currentPhase).toBeNull();
  });

  it('reports the running phase while it is still going', () => {
    const { currentPhase } = parseBuildLog([
      '::phase::resolve::ok',
      '::phase::publish-shell::start'
    ].join('\n'));

    expect(currentPhase).toBe('publish-shell');
  });

  it('records a skipped phase, which is what build-dashboard does when the toggle is off', () => {
    const { phases } = parseBuildLog('::phase::build-dashboard::skip');

    expect(stateOf(phases, 'build-dashboard')).toBe('skipped');
  });

  it('records a failed phase', () => {
    const { phases } = parseBuildLog('::phase::package::fail');

    expect(stateOf(phases, 'package')).toBe('failed');
  });

  it('reads the shell sha and ref', () => {
    const parsed = parseBuildLog('::shell::0123456789abcdef::refs/pull/13579/head');

    expect(parsed.shellSha).toBe('0123456789abcdef');
    expect(parsed.shellRef).toBe('refs/pull/13579/head');
  });

  it('collects packages in order and ignores a repeat', () => {
    const parsed = parseBuildLog([
      '::package::kubewarden::1.2.0',
      '::package::elemental::2.0.0',
      '::package::kubewarden::1.2.0'
    ].join('\n'));

    expect(parsed.packages).toEqual([
      { name: 'kubewarden', version: '1.2.0' },
      { name: 'elemental', version: '2.0.0' }
    ]);
  });

  it('keeps the whole dashboard url, which contains the :: in https://', () => {
    const parsed = parseBuildLog('::dashboard::https://builder.example.com/dashboard/index.html');

    expect(parsed.dashboardIndex).toBe('https://builder.example.com/dashboard/index.html');
  });

  it('ignores a marker it does not recognise, so a newer builder image does not break the UI', () => {
    const parsed = parseBuildLog([
      '::somethingnew::whatever',
      '::phase::resolve::ok'
    ].join('\n'));

    expect(stateOf(parsed.phases, 'resolve')).toBe('success');
  });

  it('ignores a phase name it does not know', () => {
    const parsed = parseBuildLog('::phase::not-a-phase::start');

    expect(parsed.currentPhase).toBeNull();
    expect(parsed.phases.every((p) => p.state === 'pending')).toBe(true);
  });

  it('keeps the last non-marker line as the "what is it doing" summary', () => {
    const parsed = parseBuildLog([
      '::phase::build-extensions::start',
      'yarn install v1.22.22',
      '[2/4] Fetching packages...',
      '::package::kubewarden::1.2.0'
    ].join('\n'));

    expect(parsed.lastLine).toBe('[2/4] Fetching packages...');
  });

  it('is not confused by yarn output that merely contains colons', () => {
    const parsed = parseBuildLog('info There appears to be trouble: retrying');

    expect(parsed.phases.every((p) => p.state === 'pending')).toBe(true);
    expect(parsed.lastLine).toBe('info There appears to be trouble: retrying');
  });
});

describe('reconcilePhases', () => {
  const running: BuildPhase[] = [
    {
      name: 'resolve', state: 'success', startedAt: null, finishedAt: null, durationSeconds: 12
    },
    {
      name: 'publish-shell', state: 'running', startedAt: null, finishedAt: null, durationSeconds: null
    },
    {
      name: 'package', state: 'pending', startedAt: null, finishedAt: null, durationSeconds: null
    }
  ];

  it('changes nothing while the job is still going', () => {
    expect(reconcilePhases(running, false, false)).toEqual(running);
  });

  it('fails a phase left spinning by a job that died silently, e.g. an OOM kill', () => {
    const out = reconcilePhases(running, true, true);

    expect(stateOf(out, 'publish-shell')).toBe('failed');
  });

  it('does not touch phases that already finished', () => {
    const out = reconcilePhases(running, true, true);

    expect(stateOf(out, 'resolve')).toBe('success');
    expect(stateOf(out, 'package')).toBe('pending');
  });

  it('succeeds a stuck phase when the job itself completed', () => {
    const out = reconcilePhases(running, true, false);

    expect(stateOf(out, 'publish-shell')).toBe('success');
  });
});
