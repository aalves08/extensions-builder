import { GITHUB_API } from '../config/builder';

/**
 * Talking to github.com from the browser.
 *
 * The REST API sends permissive CORS headers, so this goes direct rather than
 * through Rancher. Unauthenticated callers get 60 requests/hour per IP, which
 * is plenty for validating a PR number as someone types, as long as we debounce.
 *
 * Everything that can be a pure function is one, so the parsing is testable
 * without a network or a fetch stub.
 */

export interface PullRequestInfo {
  number: number;
  title: string;
  author: string;
  /** Head branch, qualified with the fork owner when the PR comes from a fork. */
  branch: string;
  sha: string;
  state: string;
  draft: boolean;
  htmlUrl: string;
  /** `owner/repo` the PR was opened against - the repo we clone. */
  baseRepo: string;
}

export interface RepoRef {
  owner: string;
  repo: string;
}

/** Shape of the bits of GitHub's pull request payload we actually read. */
interface RawPullRequest {
  number?: number;
  title?: string;
  state?: string;
  draft?: boolean;
  html_url?: string;
  user?: { login?: string };
  head?: { ref?: string; sha?: string; repo?: { full_name?: string } | null };
  base?: { repo?: { full_name?: string } };
}

/**
 * Pull an `owner/repo` out of anything someone is likely to paste: an https
 * clone URL, an SSH remote, a browser URL, or the bare `owner/repo` itself.
 */
export function parseRepoRef(input: string): RepoRef | null {
  const trimmed = (input || '').trim().replace(/\.git$/, '').replace(/\/+$/, '');

  if (!trimmed) {
    return null;
  }

  const patterns = [
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/]+)/i,
    /^git@github\.com:([^/]+)\/([^/]+)$/i,
    /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);

    if (match) {
      return { owner: match[1], repo: match[2] };
    }
  }

  return null;
}

/** Canonical https clone URL for a repo reference. */
export function cloneUrl(ref: RepoRef): string {
  return `https://github.com/${ ref.owner }/${ ref.repo }.git`;
}

/**
 * Read a PR number out of a number, a `#1234`, or a full pull request URL.
 * Returns null for anything that is not one of those.
 */
export function parsePullRequestNumber(input: string | number | null | undefined): number | null {
  if (typeof input === 'number') {
    return Number.isInteger(input) && input > 0 ? input : null;
  }

  const trimmed = (input || '').trim();

  if (!trimmed) {
    return null;
  }

  const fromUrl = trimmed.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/i);

  if (fromUrl) {
    return parseInt(fromUrl[1], 10);
  }

  const bare = trimmed.match(/^#?(\d+)$/);

  if (bare) {
    const value = parseInt(bare[1], 10);

    return value > 0 ? value : null;
  }

  return null;
}

/** Normalise GitHub's pull request payload down to what the UI shows. */
export function normalizePullRequest(raw: RawPullRequest): PullRequestInfo {
  const headRepo = raw.head?.repo?.full_name;
  const baseRepo = raw.base?.repo?.full_name || '';
  // A fork PR's branch name on its own is ambiguous (half of them are "main"),
  // so qualify it with the fork owner the way GitHub's own UI does.
  const branch = raw.head?.ref || '';
  const qualified = headRepo && headRepo !== baseRepo ? `${ headRepo.split('/')[0] }:${ branch }` : branch;

  return {
    number:  raw.number || 0,
    title:   raw.title || '',
    author:  raw.user?.login || '',
    branch:  qualified,
    sha:     raw.head?.sha || '',
    state:   raw.state || '',
    draft:   !!raw.draft,
    htmlUrl: raw.html_url || '',
    baseRepo
  };
}

export class GithubError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = 'GithubError';
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Look up a pull request. Throws `GithubError` carrying the HTTP status so the
 * caller can tell "no such PR" (404) from "you have been rate limited" (403).
 */
export async function fetchPullRequest(
  repo: RepoRef,
  prNumber: number,
  doFetch: FetchLike = (input, init) => fetch(input, init)
): Promise<PullRequestInfo> {
  const url = `${ GITHUB_API }/repos/${ repo.owner }/${ repo.repo }/pulls/${ prNumber }`;
  const res = await doFetch(url, { headers: { Accept: 'application/vnd.github+json' } });

  if (!res.ok) {
    throw new GithubError(`GitHub returned ${ res.status } for ${ url }`, res.status);
  }

  return normalizePullRequest(await res.json());
}

/** Check a branch or tag exists, so a bad ref fails in the form and not 20 minutes in. */
export async function refExists(
  repo: RepoRef,
  ref: string,
  doFetch: FetchLike = (input, init) => fetch(input, init)
): Promise<boolean> {
  const url = `${ GITHUB_API }/repos/${ repo.owner }/${ repo.repo }/commits/${ encodeURIComponent(ref) }`;
  const res = await doFetch(url, { headers: { Accept: 'application/vnd.github+json' } });

  return res.ok;
}
