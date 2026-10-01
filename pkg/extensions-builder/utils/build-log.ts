import { PHASES } from '../config/builder';
import { BuildPhase, BuiltPackage, PhaseState } from '../types';

/**
 * Reading a build's progress out of its pod log.
 *
 * This is the only channel available. The builder writes a rich status.json,
 * but it writes it to the output volume, which is served by an in-cluster nginx
 * the browser cannot reach. So the phase scripts also echo single-line markers
 * and we reconstruct the state from those:
 *
 *   ::phase::<name>::start|ok|skip|fail
 *   ::shell::<sha>::<ref>
 *   ::package::<pkg>::<version>
 *   ::dashboard::<index url>
 *
 * Emitted by builder/lib/common.sh and builder/phases/*.sh. Keep the two in step.
 */

export interface ParsedLog {
  phases: BuildPhase[];
  /** Name of the phase currently running, if any. */
  currentPhase: string | null;
  shellSha: string | null;
  shellRef: string | null;
  packages: Pick<BuiltPackage, 'name' | 'version'>[];
  dashboardIndex: string | null;
  /** The last few non-marker lines, for a one-line "what is it doing" summary. */
  lastLine: string | null;
}

const MARKER = /^::([a-z]+)::(.*)$/;

const MARKER_TO_STATE: Record<string, PhaseState> = {
  start: 'running',
  ok:    'success',
  skip:  'skipped',
  fail:  'failed'
};

function blankPhases(): BuildPhase[] {
  return PHASES.map((name) => ({
    name, state: 'pending', startedAt: null, finishedAt: null
  }));
}

/**
 * Parse a whole log. Deliberately tolerant: the log is almost entirely yarn and
 * webpack output, and a line that happens to look like a marker but is not one
 * should be ignored rather than throw.
 */
export function parseBuildLog(log: string | null | undefined): ParsedLog {
  const result: ParsedLog = {
    phases:         blankPhases(),
    currentPhase:   null,
    shellSha:       null,
    shellRef:       null,
    packages:       [],
    dashboardIndex: null,
    lastLine:       null
  };

  if (!log) {
    return result;
  }

  for (const raw of log.split('\n')) {
    const line = raw.trim();

    if (!line) {
      continue;
    }

    const match = line.match(MARKER);

    if (!match) {
      result.lastLine = line;
      continue;
    }

    const [, kind, rest] = match;
    const parts = rest.split('::');

    switch (kind) {
    case 'phase': {
      const [name, event] = parts;
      const phase = result.phases.find((p) => p.name === name);
      const state = MARKER_TO_STATE[event];

      if (phase && state) {
        phase.state = state;
        result.currentPhase = state === 'running' ? name : null;
      }
      break;
    }
    case 'shell':
      result.shellSha = parts[0] || null;
      result.shellRef = parts[1] || null;
      break;
    case 'package':
      if (parts[0] && parts[1] && !result.packages.some((p) => p.name === parts[0])) {
        result.packages.push({ name: parts[0], version: parts[1] });
      }
      break;
    case 'dashboard':
      // The URL contains "://", so it has to be rejoined rather than taken from parts[0].
      result.dashboardIndex = rest || null;
      break;
    default:
      // An unrecognised marker is not an error - a newer builder image may emit
      // markers this UI does not know about yet.
      break;
    }
  }

  return result;
}

/**
 * Fold the Job's own outcome into the parsed phases.
 *
 * The log can go quiet without a failure marker - an OOM kill, the node going
 * away, activeDeadlineSeconds expiring. In those cases the Job is failed but
 * the last phase still reads "running", which would leave the stepper spinning
 * forever. So a finished Job always wins over what the log last said.
 */
export function reconcilePhases(phases: BuildPhase[], jobFinished: boolean, jobFailed: boolean): BuildPhase[] {
  if (!jobFinished) {
    return phases;
  }

  return phases.map((phase) => {
    if (phase.state !== 'running') {
      return phase;
    }

    return { ...phase, state: jobFailed ? 'failed' : 'success' };
  });
}
