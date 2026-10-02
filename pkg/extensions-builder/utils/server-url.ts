import { MANAGEMENT } from '@shell/config/types';
import { SETTING } from '@shell/config/settings';
import { ExternalAccess } from '../types';
import { findOrNull } from './api';

/**
 * Where this Rancher thinks it lives, and whether that is any use to us.
 *
 * To install a build from a *different* Rancher, the repository has to be
 * reachable from outside this cluster, which means an Ingress, which means a
 * hostname that already routes here. Asking the user to supply one is asking
 * them something the cluster already knows: `server-url` is the address every
 * downstream agent is told to call back on, so it routes in by definition.
 *
 * It is a default and not a fact, though. It is wrong in one common case, and
 * the case is the one this tool gets used in: `docker run rancher/rancher`
 * publishes a port straight off the container and runs k3s inside it, so
 * server-url points at Rancher's own listener and nothing an Ingress inside
 * that k3s does will ever be seen. Hence editable, and hence off by default
 * when there is no address here that could plausibly work.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Store = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Hosts that tell us nothing. A server-url on any of these is either an
 * unconfigured Rancher or one only reachable from the machine it runs on, and
 * in both cases an Ingress on that hostname is useless to anyone else.
 */
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'];

/**
 * Why an address cannot host the repository, in the words the form explains it
 * with. `none` means there was no address to judge in the first place.
 */
export type ExternalAccessReason = 'ok' | 'local' | 'port' | 'none';

export interface ExternalAccessSuggestion {
  access: ExternalAccess | null;
  reason: ExternalAccessReason;
  /** The address the reason is about, so the form can quote it back. */
  address: string;
}

/**
 * Judge an address this Rancher is reached at: either the external access to
 * default to, or why it cannot be one.
 *
 * The reason is carried rather than thrown away because the answer is "no"
 * surprisingly often, and a disabled checkbox with no explanation looks like a
 * bug in this extension rather than a fact about the cluster.
 *
 * Pure, so the "is this a usable address" rule is one readable function rather
 * than something buried in a component.
 */
export function inspectAddress(address: string): ExternalAccessSuggestion {
  const raw = (address || '').trim();
  const nothing: ExternalAccessSuggestion = {
    access: null, reason: 'none', address: raw
  };

  if (!raw) {
    return nothing;
  }

  let parsed: URL;

  try {
    // An address with no scheme is unusual but legal in the setting; assume
    // https rather than failing to parse and offering nothing.
    parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${ raw }`);
  } catch {
    return nothing;
  }

  const hostname = parsed.hostname.toLowerCase();

  if (!hostname) {
    return nothing;
  }

  if (LOCAL_HOSTS.includes(hostname)) {
    return {
      access: null, reason: 'local', address: parsed.host
    };
  }

  // A port here means the address does not go through an ingress controller:
  // the controller owns 80 and 443, so anything else is some other listener -
  // Rancher's own, usually - and it would answer our path with its own 404.
  // The Ingress could not carry the port anyway; `host` there is matched
  // against the Host header as a DNS name, and Kubernetes rejects a colon in
  // it. Better to say no with a reason than offer an address that cannot work.
  if (parsed.port && parsed.port !== (parsed.protocol === 'http:' ? '80' : '443')) {
    return {
      access: null, reason: 'port', address: parsed.host
    };
  }

  return {
    access:  { host: hostname, tls: parsed.protocol !== 'http:' },
    reason:  'ok',
    address: hostname
  };
}

/** The `server-url` setting's effective value, or '' if it is unset or unreadable. */
export async function readServerUrl(store: Store): Promise<string> {
  const setting = await findOrNull(store, MANAGEMENT.SETTING, SETTING.SERVER_URL);

  // Rancher leaves `value` empty until the setting has been changed.
  return setting?.value || setting?.default || '';
}

/**
 * The first of these addresses that could serve the repository, or the first
 * real reason none of them can.
 *
 * Two candidates rather than one because they fail in different places.
 * `server-url` is the considered answer and the one to prefer, but a fresh
 * Rancher leaves it unset. The address in the browser's bar is never unset and
 * is proven to route to this Rancher - from here, at least - but it is also
 * `localhost:8005` during `yarn dev`, which is no use to anybody else. Between
 * them they cover every install worth pre-filling for, and when neither
 * qualifies the honest answer is to say so rather than bake a guess into the
 * charts.
 */
export function suggestExternalAccess(candidates: string[]): ExternalAccessSuggestion {
  let rejected: ExternalAccessSuggestion | null = null;

  for (const candidate of candidates) {
    const suggestion = inspectAddress(candidate);

    if (suggestion.access) {
      return suggestion;
    }

    // Keep the first address that was actually judged and found wanting. An
    // absent server-url explains nothing; "this Rancher is on localhost" does.
    if (suggestion.reason !== 'none' && !rejected) {
      rejected = suggestion;
    }
  }

  return rejected || {
    access: null, reason: 'none', address: ''
  };
}

/** What the New Build form starts with, given this Rancher. */
export async function defaultExternalAccess(store: Store): Promise<ExternalAccessSuggestion> {
  return suggestExternalAccess([
    await readServerUrl(store),
    typeof window === 'undefined' ? '' : window.location.origin
  ]);
}
