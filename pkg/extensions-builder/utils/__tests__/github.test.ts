import {
  GithubError,
  cloneUrl,
  fetchPullRequest,
  normalizePullRequest,
  parsePullRequestNumber,
  parseRepoRef,
  refExists
} from '../github';

const okResponse = (body: unknown) => ({
  ok: true, status: 200, json: () => Promise.resolve(body)
}) as unknown as Response;

const errorResponse = (status: number) => ({
  ok: false, status, json: () => Promise.resolve({})
}) as unknown as Response;

describe('parseRepoRef', () => {
  it.each([
    ['https://github.com/rancher/dashboard.git', 'rancher', 'dashboard'],
    ['https://github.com/rancher/dashboard', 'rancher', 'dashboard'],
    ['http://github.com/rancher/dashboard/', 'rancher', 'dashboard'],
    ['https://www.github.com/rancher/dashboard/pull/13579', 'rancher', 'dashboard'],
    ['git@github.com:aalves08/dashboard.git', 'aalves08', 'dashboard'],
    ['rancher/dashboard', 'rancher', 'dashboard'],
    ['rancher/kubewarden-ui', 'rancher', 'kubewarden-ui']
  ])('reads %s', (input, owner, repo) => {
    expect(parseRepoRef(input)).toEqual({ owner, repo });
  });

  it.each([['', 'empty'], ['   ', 'blank'], ['https://gitlab.com/a/b', 'not github'], ['dashboard', 'no owner']])(
    'rejects %s (%s)',
    (input) => {
      expect(parseRepoRef(input)).toBeNull();
    }
  );
});

describe('cloneUrl', () => {
  it('builds an https clone url', () => {
    expect(cloneUrl({ owner: 'rancher', repo: 'dashboard' })).toBe('https://github.com/rancher/dashboard.git');
  });
});

describe('parsePullRequestNumber', () => {
  it.each([
    [1234, 1234],
    ['1234', 1234],
    ['#1234', 1234],
    ['  1234 ', 1234],
    ['https://github.com/rancher/dashboard/pull/13579', 13579],
    ['https://github.com/rancher/dashboard/pull/13579/files', 13579]
  ])('reads %s as %s', (input, expected) => {
    expect(parsePullRequestNumber(input)).toBe(expected);
  });

  const rejected: [string | null | undefined, string][] = [
    ['', 'empty'], ['abc', 'text'], ['0', 'zero'], ['-5', 'negative'], [null, 'null'], [undefined, 'undefined']
  ];

  it.each(rejected)('rejects %s (%s)', (input) => {
    expect(parsePullRequestNumber(input)).toBeNull();
  });

  it('rejects a non-integer number', () => {
    expect(parsePullRequestNumber(12.5)).toBeNull();
  });
});

describe('normalizePullRequest', () => {
  it('leaves a same-repo branch unqualified', () => {
    const info = normalizePullRequest({
      number: 10,
      title:  'Bump something',
      user:   { login: 'someone' },
      head:   {
        ref: 'my-branch', sha: 'abc123', repo: { full_name: 'rancher/dashboard' }
      },
      base: { repo: { full_name: 'rancher/dashboard' } }
    });

    expect(info.branch).toBe('my-branch');
    expect(info.baseRepo).toBe('rancher/dashboard');
  });

  it('qualifies a fork branch with its owner', () => {
    const info = normalizePullRequest({
      number: 10,
      head:   {
        ref: 'main', sha: 'abc123', repo: { full_name: 'aalves08/dashboard' }
      },
      base: { repo: { full_name: 'rancher/dashboard' } }
    });

    expect(info.branch).toBe('aalves08:main');
  });

  it('survives a deleted fork, where head.repo is null', () => {
    const info = normalizePullRequest({
      number: 10,
      head:   {
        ref: 'gone', sha: 'abc123', repo: null
      },
      base: { repo: { full_name: 'rancher/dashboard' } }
    });

    expect(info.branch).toBe('gone');
  });

  it('defaults every missing field rather than throwing', () => {
    expect(normalizePullRequest({})).toEqual({
      number:   0,
      title:    '',
      author:   '',
      branch:   '',
      sha:      '',
      state:    '',
      draft:    false,
      htmlUrl:  '',
      baseRepo: ''
    });
  });
});

describe('fetchPullRequest', () => {
  const repo = { owner: 'rancher', repo: 'dashboard' };

  it('calls the right url and normalises the result', async() => {
    const doFetch = jest.fn().mockResolvedValue(okResponse({
      number: 42, title: 'A change', user: { login: 'dev' }
    }));

    const info = await fetchPullRequest(repo, 42, doFetch);

    expect(doFetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/rancher/dashboard/pulls/42',
      { headers: { Accept: 'application/vnd.github+json' } }
    );
    expect(info.title).toBe('A change');
  });

  it('throws a GithubError carrying the status, so 404 and 403 can be told apart', async() => {
    const doFetch = jest.fn().mockResolvedValue(errorResponse(403));

    await expect(fetchPullRequest(repo, 42, doFetch)).rejects.toMatchObject({ name: 'GithubError', status: 403 });
    await expect(fetchPullRequest(repo, 42, doFetch)).rejects.toBeInstanceOf(GithubError);
  });
});

describe('refExists', () => {
  const repo = { owner: 'rancher', repo: 'dashboard' };

  it('url-encodes the ref, so release/v2.9 does not become a path', async() => {
    const doFetch = jest.fn().mockResolvedValue(okResponse({}));

    await refExists(repo, 'release/v2.9', doFetch);

    expect(doFetch.mock.calls[0][0]).toBe('https://api.github.com/repos/rancher/dashboard/commits/release%2Fv2.9');
  });

  it('is false for a ref that does not resolve', async() => {
    const doFetch = jest.fn().mockResolvedValue(errorResponse(404));

    await expect(refExists(repo, 'nope', doFetch)).resolves.toBe(false);
  });
});
