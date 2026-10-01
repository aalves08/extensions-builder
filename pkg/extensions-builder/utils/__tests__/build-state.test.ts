import { ANNOTATION_SPEC } from '../../config/builder';
import { BuildSpec } from '../../types';
import {
  JobStatus, isFinished, jobBuildState, jobFailureReason, shellSourceLabel, specFromAnnotations
} from '../build-state';

const condition = (type: string, status = 'True', extra: Record<string, string> = {}) => ({
  type, status, ...extra
});

describe('jobBuildState', () => {
  it.each([[null], [undefined], [{} as JobStatus]])('is pending for %s', (status) => {
    expect(jobBuildState(status as JobStatus | null)).toBe('pending');
  });

  it('is running while a pod is active', () => {
    expect(jobBuildState({ active: 1 })).toBe('running');
  });

  it('is success on the Complete condition', () => {
    expect(jobBuildState({ conditions: [condition('Complete')] })).toBe('success');
  });

  it('is success on the succeeded counter alone', () => {
    expect(jobBuildState({ succeeded: 1 })).toBe('success');
  });

  it('is failed on the Failed condition', () => {
    expect(jobBuildState({ conditions: [condition('Failed')] })).toBe('failed');
  });

  it('is failed, not running, when activeDeadlineSeconds expires while a pod is still active', () => {
    const status: JobStatus = {
      active:     1,
      conditions: [condition('Failed', 'True', { reason: 'DeadlineExceeded' })]
    };

    expect(jobBuildState(status)).toBe('failed');
  });

  it('ignores a condition whose status is False', () => {
    expect(jobBuildState({ active: 1, conditions: [condition('Failed', 'False')] })).toBe('running');
  });
});

describe('isFinished', () => {
  it.each([['success', true], ['failed', true], ['running', false], ['pending', false], ['unknown', false]])(
    '%s -> %s',
    (state, expected) => {
      expect(isFinished(state as 'success')).toBe(expected);
    }
  );
});

describe('jobFailureReason', () => {
  it('prefers the message over the reason', () => {
    const status: JobStatus = { conditions: [condition('Failed', 'True', { reason: 'DeadlineExceeded', message: 'Job was active longer than specified deadline' })] };

    expect(jobFailureReason(status)).toBe('Job was active longer than specified deadline');
  });

  it('falls back to the reason', () => {
    expect(jobFailureReason({ conditions: [condition('Failed', 'True', { reason: 'BackoffLimitExceeded' })] }))
      .toBe('BackoffLimitExceeded');
  });

  it('is null when the job did not fail', () => {
    expect(jobFailureReason({ conditions: [condition('Complete')] })).toBeNull();
  });

  it.each([[null], [undefined]])('is null for %s', (status) => {
    expect(jobFailureReason(status as JobStatus | null)).toBeNull();
  });
});

describe('specFromAnnotations', () => {
  const spec = { buildId: 'pr1-abcd' } as BuildSpec;

  it('round-trips a stored spec', () => {
    expect(specFromAnnotations({ [ANNOTATION_SPEC]: JSON.stringify(spec) })).toEqual(spec);
  });

  it('returns null rather than throwing on malformed json, so the build can still be deleted', () => {
    expect(specFromAnnotations({ [ANNOTATION_SPEC]: '{not json' })).toBeNull();
  });

  it.each([[null], [undefined], [{}]])('returns null for %s', (annotations) => {
    expect(specFromAnnotations(annotations as Record<string, string> | null)).toBeNull();
  });
});

describe('shellSourceLabel', () => {
  const specWith = (pr: number | null, ref: string | null) => ({
    shell: {
      repo: 'https://github.com/rancher/dashboard.git', pr, ref
    }
  } as BuildSpec);

  it('shows the PR number when there is one', () => {
    expect(shellSourceLabel(specWith(13579, null))).toBe('#13579');
  });

  it('shows the ref otherwise', () => {
    expect(shellSourceLabel(specWith(null, 'master'))).toBe('master');
  });

  it('prefers the PR when, somehow, both are set', () => {
    expect(shellSourceLabel(specWith(13579, 'master'))).toBe('#13579');
  });

  it('is a dash for a spec we could not read', () => {
    expect(shellSourceLabel(null)).toBe('-');
  });
});
