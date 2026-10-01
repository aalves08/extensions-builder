import { ANNOTATION_SPEC } from '../config/builder';
import { BuildSpec, BuildState } from '../types';

/**
 * Deriving a build's state from its Job, and reading back the spec we stored
 * alongside it.
 *
 * Pure so the awkward cases - a Job that is both active and failed mid-retry,
 * a deadline that expired without any pod ever starting - can be pinned down
 * in a test rather than discovered in a cluster.
 */

export interface JobStatus {
  active?: number;
  succeeded?: number;
  failed?: number;
  startTime?: string;
  completionTime?: string;
  conditions?: { type?: string; status?: string; reason?: string; message?: string }[];
}

export function jobBuildState(status: JobStatus | null | undefined): BuildState {
  if (!status) {
    return 'pending';
  }

  const conditions = status.conditions || [];
  const isTrue = (type: string) => conditions.some((c) => c.type === type && c.status === 'True');

  // Conditions are checked before the counters: a Job killed by
  // activeDeadlineSeconds reports Failed while `active` may still be set.
  if (isTrue('Failed')) {
    return 'failed';
  }

  if (isTrue('Complete')) {
    return 'success';
  }

  if (status.succeeded) {
    return 'success';
  }

  if (status.failed) {
    return 'failed';
  }

  if (status.active) {
    return 'running';
  }

  return 'pending';
}

export function isFinished(state: BuildState): boolean {
  return state === 'success' || state === 'failed';
}

/** Why a Job failed, if Kubernetes said. Not the build error - that is in the log. */
export function jobFailureReason(status: JobStatus | null | undefined): string | null {
  const failed = (status?.conditions || []).find((c) => c.type === 'Failed' && c.status === 'True');

  if (!failed) {
    return null;
  }

  return failed.message || failed.reason || null;
}

export interface PodStatus {
  phase?: string;
  conditions?: { type?: string; status?: string; reason?: string; message?: string }[];
  containerStatuses?: { name?: string; state?: { waiting?: { reason?: string; message?: string } } }[];
}

/**
 * Container waiting reasons that will not clear on their own.
 *
 * Deliberately not ContainerCreating or PodInitializing: those are the normal
 * first minute of every build, and flagging them would cry wolf on every run.
 */
const BLOCKING_WAIT_REASONS = [
  'ImagePullBackOff',
  'ErrImagePull',
  'InvalidImageName',
  'ImageInspectError',
  'RegistryUnavailable',
  'CreateContainerConfigError',
  'CreateContainerError',
  'CrashLoopBackOff'
];

export interface BlockedReason {
  reason: string;
  message: string | null;
}

/**
 * Why a build pod exists but is going nowhere, if that is the case.
 *
 * Without this the symptom is silence: the phases sit on Waiting, the log
 * endpoint answers 400 because no container ever started, and nothing on the
 * page says why. An unpullable builder image and a node with no room both land
 * here, and both need a human.
 */
export function podBlockedReason(status: PodStatus | null | undefined): BlockedReason | null {
  if (!status) {
    return null;
  }

  const waiting = (status.containerStatuses || [])
    .map((container) => container?.state?.waiting)
    .find((state) => !!state?.reason && BLOCKING_WAIT_REASONS.includes(state.reason));

  if (waiting?.reason) {
    return { reason: waiting.reason, message: waiting.message || null };
  }

  // Nothing is waiting because nothing was ever placed. The scheduler puts its
  // explanation - no node with enough CPU, no volume it can reach - here.
  const unschedulable = (status.conditions || []).find((condition) => (
    condition.type === 'PodScheduled' && condition.status === 'False'
  ));

  if (unschedulable) {
    return { reason: unschedulable.reason || 'Unschedulable', message: unschedulable.message || null };
  }

  return null;
}

/**
 * Read the build spec back off a resource's annotations.
 *
 * Returns null rather than throwing on malformed JSON: a build whose spec we
 * cannot parse should still show up in the list so the user can delete it.
 */
export function specFromAnnotations(annotations: Record<string, string> | null | undefined): BuildSpec | null {
  const raw = annotations?.[ANNOTATION_SPEC];

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as BuildSpec;
  } catch {
    return null;
  }
}

/** Short human description of where a build's shell came from. */
export function shellSourceLabel(spec: BuildSpec | null): string {
  if (!spec) {
    return '-';
  }

  if (spec.shell.pr) {
    return `#${ spec.shell.pr }`;
  }

  return spec.shell.ref || '-';
}
