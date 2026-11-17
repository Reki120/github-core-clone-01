// GitHub REST v3: repositories, branches, commits, contents, labels, issues, comments and
// pull requests, over the store in store.ts. Every check in checks-rest.ts is answered here.

import {
  VIEWER,
  isOid,
  parseCommit,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export interface RestResult {
  status: number;
  json: unknown;
  headers?: Record<string, string>;
  noBody?: boolean;
}

function gid(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64');
}

export function repoGid(repo: Repo): string {
  return gid('Repository', repo.fullName);
}
export function issueGid(repo: Repo, n: number): string {
  return gid('Issue', `${repo.fullName}#${n}`);
}
export function prGid(repo: Repo, n: number): string {
  return gid('PullRequest', `${repo.fullName}#${n}`);
}
export function commentGid(repo: Repo, issueN: number, id: number): string {
  return gid('IssueComment', `${repo.fullName}#${issueN}:${id}`);
}
export function userGid(login: string): string {
  return gid('User', login);
}

export function decodeGid(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { type: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

function notFound(message = 'Not Found'): RestResult {
  return { status: 404, json: { message } };
}

function userJson(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: userGid(VIEWER.login),
    avatar_url: '',
    gravatar_id: '',
    url: `/api/v3/users/${VIEWER.login}`,
    html_url: `https://github.com/${VIEWER.login}`,
    type: 'User',
    site_admin: false,
    name: VIEWER.name,
    email: VIEWER.email,
  };
}

export function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repoGid(repo),
    name: repo.name,
    full_name: repo.fullName,
    private: repo.private,
    owner: userJson(),
    html_url: `https://github.com/${repo.fullName}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.fullName}`,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    pushed_at: '2025-01-01T00:00:00Z',
    git_url: `git://github.com/${repo.fullName}.git`,
    ssh_url: `git@github.com:${repo.fullName}.git`,
    clone_url: `https://github.com/${repo.fullName}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.size + repo.pulls.size,
    license: null,
    allow_forking: true,
    is_template: false,
    web_commit_signoff_required: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
  };
}

export function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issueGid(repo, issue.number),
    node_id: issueGid(repo, issue.number),
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed', description: '' })),
    user: userJson(),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: (repo.comments.get(issue.number) ?? []).length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
  };
}

export function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const diff = store.diffTrees(
    repo,
    branchTreeOf(store, repo, pull.baseRef, pull.mergeBaseSha),
    branchTreeOf(store, repo, pull.headRef, pull.headSha),
  );
  let additions = 0;
  let deletions = 0;
  for (const d of diff) {
    additions += d.additions;
    deletions += d.deletions;
  }
  return {
    id: prGid(repo, pull.number),
    node_id: prGid(repo, pull.number),
    url: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.fullName}/pulls/${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: store.mergeConflicts(repo, pull.mergeBaseSha, repo.refs.get(`refs/heads/${pull.baseRef}`) ?? '', pull.headSha).length === 0,
    mergeable_state: 'clean',
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: pull.headSha,
      user: userJson(),
      repo: repoJson(store, repo),
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: pull.baseSha,
      user: userJson(),
      repo: repoJson(store, repo),
    },
    user: userJson(),
    assignee: null,
    assignees: [],
    milestone: null,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    draft: false,
    commits: 1,
    additions,
    deletions,
    changed_files: diff.length,
  };
}

/** The tree oid of a branch tip (or of a stored tip sha when the branch moved). */
function branchTreeOf(store: Store, repo: Repo, ref: string, tipSha: string): string {
  const tip = repo.refs.get(`refs/heads/${ref}`) ?? tipSha;
  const obj = repo.objects.get(tip);
  if (obj !== undefined && obj.type === 'commit') return parseCommit(obj.data).tree;
  return '';
}

function paginate<T>(items: T[], query: URLSearchParams, baseUrl: string): { page: T[]; link: string | null } {
  const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const links: string[] = [];
  const urlFor = (p: number): string => `${baseUrl}?per_page=${perPage}&page=${p}`;
  if (page < totalPages) links.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${urlFor(page - 1)}>; rel="prev"`);
  if (totalPages > 1) {
    links.push(`<${urlFor(1)}>; rel="first"`);
    links.push(`<${urlFor(totalPages)}>; rel="last"`);
  }
  return { page: slice, link: links.length > 0 ? links.join(', ') : null };
}

function bodyOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Resolve /repos/{owner}/{name} with ownership: any other owner is a 404, never a 403. */
function ownedRepo(store: Store, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return store.getRepo(owner, name) ?? null;
}

function commitJson(store: Store, repo: Repo, oid: string): Record<string, unknown> {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'commit') return { sha: oid, commit: { message: '' } };
  const parts = parseCommit(obj.data);
  const person = (name: string, email: string, epoch: number): Record<string, unknown> => ({
    name,
    email,
    date: new Date(epoch * 1000).toISOString(),
  });
  return {
    sha: oid,
    commit: {
      message: parts.message,
      author: person(parts.authorName, parts.authorEmail, parts.authorEpoch),
      committer: person(parts.committerName, parts.committerEmail, parts.committerEpoch),
      tree: { sha: parts.tree },
    },
    author: userJson(),
    committer: userJson(),
    parents: parts.parents.map((p) => ({ sha: p })),
  };
}

function walkCommits(store: Store, repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (cur === '' || seen.has(cur)) continue;
    seen.add(cur);
    const obj = repo.objects.get(cur);
    if (obj === undefined || obj.type !== 'commit') continue;
    out.push(cur);
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Route handlers. `seg` are the path segments after /api/v3.
// ---------------------------------------------------------------------------

export function handleRest(
  store: Store,
  method: string,
  seg: string[],
  query: URLSearchParams,
  body: unknown,
  origin: string,
): RestResult | null {
  // GET /api/v3/ — the API root (answered without auth by app.ts already; kept here too).
  if (seg.length === 0) {
    if (method !== 'GET') return notFound();
    return {
      status: 200,
      json: { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    };
  }
  if (seg[0] === 'meta' && seg.length === 1) {
    if (method !== 'GET') return notFound();
    return { status: 200, json: { installed_version: '1.0.0' } };
  }
  if (seg[0] === 'user') {
    if (seg.length === 1) {
      if (method !== 'GET') return notFound();
      return { status: 200, json: userJson() };
    }
    if (seg[1] === 'repos') {
      if (method === 'GET') {
        const repos = store.listReposFor(VIEWER.login);
        const { page, link } = paginate(
          repos.map((r) => repoJson(store, r)),
          query,
          `${origin}/api/v3/user/repos`,
        );
        return { status: 200, json: page, headers: link !== null ? { link } : {} };
      }
      if (method === 'POST') {
        const b = bodyOf(body);
        const name = str(b.name);
        if (name === '') return { status: 422, json: { message: 'name is required' } };
        if (store.getRepo(VIEWER.login, name) !== undefined) {
          return { status: 422, json: { message: 'Repository already exists.' } };
        }
        const repo = store.createRepo(VIEWER.login, name, str(b.description), bool(b.private, false));
        return { status: 201, json: repoJson(store, repo) };
      }
      return notFound();
    }
    return notFound();
  }
  if (seg[0] !== 'repos' || seg.length < 3) return null;
  const owner = decodeURIComponent(seg[1] ?? '');
  const repoName = decodeURIComponent(seg[2] ?? '');
  const repo = ownedRepo(store, owner, repoName);
  const rest = seg.slice(3);

  if (rest.length === 0) {
    if (method === 'GET') {
      if (repo === null) return notFound();
      return { status: 200, json: repoJson(store, repo) };
    }
    if (method === 'PATCH') {
      if (repo === null) return notFound();
      const b = bodyOf(body);
      if (typeof b.description === 'string') repo.description = b.description;
      if (typeof b.private === 'boolean') repo.private = b.private;
      return { status: 200, json: repoJson(store, repo) };
    }
    if (method === 'DELETE') {
      if (repo === null) return notFound();
      store.deleteRepo(repo);
      return { status: 204, json: null, noBody: true };
    }
    return notFound();
  }

  if (repo === null) return notFound();

  // Branches and commits.
  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const list = [...repo.refs.entries()]
        .filter(([r]) => r.startsWith('refs/heads/'))
        .map(([r, sha]) => ({ name: r.slice('refs/heads/'.length), commit: { sha }, protected: false }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return { status: 200, json: list };
    }
    if (rest.length === 2 && method === 'GET') {
      const branch = decodeURIComponent(rest[1] ?? '');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) return notFound();
      return { status: 200, json: { name: branch, commit: { sha }, protected: false } };
    }
    return notFound();
  }
  if (rest[0] === 'commits') {
    if (method !== 'GET') return notFound();
    const shaParam = query.get('sha') ?? repo.defaultBranch;
    const tip = store.resolveRef(repo, shaParam);
    if (tip === '') return { status: 200, json: [] };
    const commits = walkCommits(store, repo, tip).map((oid) => commitJson(store, repo, oid));
    return { status: 200, json: commits };
  }
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const b = bodyOf(body);
      const ref = str(b.ref);
      const sha = str(b.sha);
      if (!ref.startsWith('refs/') || !isOid(sha)) {
        return { status: 422, json: { message: 'Invalid ref or sha' } };
      }
      if (repo.refs.has(ref)) return { status: 422, json: { message: 'Reference already exists' } };
      const obj = repo.objects.get(sha);
      if (obj === undefined || obj.type !== 'commit') {
        return { status: 422, json: { message: 'Object does not exist' } };
      }
      repo.refs.set(ref, sha);
      return { status: 201, json: { ref, object: { sha, type: 'commit' } } };
    }
    if (method === 'GET') {
      const refPath = rest.slice(2).map((s) => decodeURIComponent(s)).join('/');
      if (refPath === '') {
        const list = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha, type: 'commit' } }));
        return { status: 200, json: list };
      }
      const sha = repo.refs.get(refPath);
      if (sha === undefined) return notFound();
      return { status: 200, json: { ref: refPath, object: { sha, type: 'commit' } } };
    }
    return notFound();
  }

  // Contents.
  if (rest[0] === 'contents') {
    const path = rest.slice(1).map((s) => decodeURIComponent(s)).join('/');
    const refParam = query.get('ref') ?? repo.defaultBranch;
    if (method === 'PUT') {
      const b = bodyOf(body);
      const message = str(b.message, `Update ${path}`);
      const contentB64 = str(b.content);
      if (contentB64 === '') return { status: 422, json: { message: 'content is required' } };
      const bytes = Buffer.from(contentB64, 'base64');
      const branch = str(b.branch, repo.defaultBranch);
      const refName = `refs/heads/${branch}`;
      const tip = repo.refs.get(refName);
      const tipTree = tip !== undefined ? treeOfTip(store, repo, tip) : '';
      const files = store.flattenTree(repo, tipTree);
      const existing = files.get(path);
      const givenSha = typeof b.sha === 'string' ? (b.sha as string).toLowerCase() : '';
      if (givenSha !== '' && (existing === undefined || existing.oid.toLowerCase() !== givenSha)) {
        return { status: 409, json: { message: 'sha does not match' } };
      }
      const blobOid = store.putObject(repo, 'blob', bytes);
      const nextFiles = new Map<string, string>();
      for (const [p, entry] of files) nextFiles.set(p, entry.oid);
      nextFiles.set(path, blobOid);
      const treeOid = store.buildTree(repo, nextFiles);
      const parents = tip !== undefined ? [tip] : [];
      const commitOid = store.makeCommit(repo, treeOid, parents, message);
      repo.refs.set(refName, commitOid);
      const status = existing === undefined ? 201 : 200;
      return {
        status,
        json: {
          content: {
            name: path.split('/').pop() ?? path,
            path,
            sha: blobOid,
            size: bytes.length,
            encoding: 'base64',
            type: 'file',
          },
          commit: { sha: commitOid, message },
        },
      };
    }
    if (method === 'GET') {
      const tip = store.resolveRef(repo, refParam);
      if (tip === '') return notFound();
      const tipTree = treeOfTip(store, repo, tip);
      const files = store.flattenTree(repo, tipTree);
      const file = files.get(path);
      if (file !== undefined) {
        const obj = repo.objects.get(file.oid);
        const bytes = obj?.data ?? Buffer.alloc(0);
        return {
          status: 200,
          json: {
            type: 'file',
            encoding: 'base64',
            size: bytes.length,
            name: path.split('/').pop() ?? path,
            path,
            content: bytes.toString('base64'),
            sha: file.oid,
          },
        };
      }
      // Directory listing (or the repo root when path is empty).
      const prefix = path === '' ? '' : `${path}/`;
      const seen = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string }>();
      for (const [p, entry] of files) {
        if (!p.startsWith(prefix)) continue;
        const restPath = p.slice(prefix.length);
        const slash = restPath.indexOf('/');
        if (slash < 0) {
          seen.set(restPath, { type: 'file', name: restPath, path: p, sha: entry.oid });
        } else {
          const dirName = restPath.slice(0, slash);
          if (!seen.has(dirName)) {
            const dirTree = treeOidOfDir(store, repo, tipTree, `${prefix}${dirName}`);
            seen.set(dirName, { type: 'dir', name: dirName, path: `${prefix}${dirName}`, sha: dirTree });
          }
        }
      }
      if (seen.size === 0) return notFound();
      return { status: 200, json: [...seen.values()].sort((a, b) => (a.name < b.name ? -1 : 1)) };
    }
    if (method === 'DELETE') {
      const b = bodyOf(body);
      const message = str(b.message, `Delete ${path}`);
      const branch = str(b.branch, repo.defaultBranch);
      const refName = `refs/heads/${branch}`;
      const tip = repo.refs.get(refName);
      if (tip === undefined) return notFound();
      const tipTree = treeOfTip(store, repo, tip);
      const files = store.flattenTree(repo, tipTree);
      const existing = files.get(path);
      if (existing === undefined) return notFound();
      const givenSha = typeof b.sha === 'string' ? (b.sha as string).toLowerCase() : '';
      if (givenSha !== '' && existing.oid.toLowerCase() !== givenSha) {
        return { status: 409, json: { message: 'sha does not match' } };
      }
      const nextFiles = new Map<string, string>();
      for (const [p, entry] of files) if (p !== path) nextFiles.set(p, entry.oid);
      const treeOid = store.buildTree(repo, nextFiles);
      const commitOid = store.makeCommit(repo, treeOid, [tip], message);
      repo.refs.set(refName, commitOid);
      return { status: 200, json: { commit: { sha: commitOid, message } } };
    }
    return notFound();
  }

  // Labels.
  if (rest[0] === 'labels') {
    if (method === 'POST' && rest.length === 1) {
      const b = bodyOf(body);
      const name = str(b.name);
      if (name === '') return { status: 422, json: { message: 'name is required' } };
      const color = str(b.color, 'ededed');
      repo.labels.set(name, { name, color });
      return { status: 201, json: { name, color, description: '' } };
    }
    if (method === 'GET' && rest.length === 1) {
      return { status: 200, json: [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: '' })) };
    }
    return notFound();
  }

  // Issues.
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const b = bodyOf(body);
        const title = str(b.title);
        const labelsRaw = Array.isArray(b.labels) ? b.labels : [];
        const labelNames: string[] = [];
        for (const l of labelsRaw) {
          const name = typeof l === 'string' ? l : typeof l === 'object' && l !== null ? str((l as Record<string, unknown>).name) : '';
          if (name === '') continue;
          if (!repo.labels.has(name)) return { status: 422, json: { message: `Label does not exist: ${name}` } };
          labelNames.push(name);
        }
        const number = (repo.numCounter += 1);
        const { iso } = store.tick();
        const issue: Issue = {
          number,
          title,
          body: str(b.body),
          state: 'open',
          labels: labelNames,
          createdSeq: number,
          createdAt: iso,
          updatedAt: iso,
        };
        repo.issues.set(number, issue);
        return { status: 201, json: issueJson(store, repo, issue) };
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        let list = [...repo.issues.values()];
        if (state !== 'all') list = list.filter((i) => i.state === state);
        if (sort === 'created') {
          list.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
        }
        const { page, link } = paginate(
          list.map((i) => issueJson(store, repo, i)),
          query,
          `${origin}/api/v3/repos/${repo.fullName}/issues`,
        );
        return { status: 200, json: page, headers: link !== null ? { link } : {} };
      }
      return notFound();
    }
    const num = Number(rest[1]);
    if (!Number.isInteger(num) || num < 1) return notFound();
    const issue = repo.issues.get(num);
    if (rest.length === 2) {
      if (method === 'GET') {
        if (issue === undefined) return notFound();
        return { status: 200, json: issueJson(store, repo, issue) };
      }
      if (method === 'PATCH') {
        if (issue === undefined) return notFound();
        const b = bodyOf(body);
        if (typeof b.state === 'string' && (b.state === 'open' || b.state === 'closed')) issue.state = b.state;
        if (typeof b.title === 'string') issue.title = b.title;
        if (typeof b.body === 'string') issue.body = b.body;
        issue.updatedAt = store.tick().iso;
        return { status: 200, json: issueJson(store, repo, issue) };
      }
      return notFound();
    }
    if (rest[2] === 'comments') {
      if (issue === undefined) return notFound();
      if (method === 'POST') {
        const b = bodyOf(body);
        const id = (repo.commentCounter += 1);
        const { iso } = store.tick();
        const comment = { id, issueNumber: num, body: str(b.body), createdAt: iso, updatedAt: iso };
        const list = repo.comments.get(num) ?? [];
        list.push(comment);
        repo.comments.set(num, list);
        return {
          status: 201,
          json: {
            id,
            node_id: commentGid(repo, num, id),
            body: comment.body,
            user: userJson(),
            created_at: iso,
            updated_at: iso,
          },
        };
      }
      if (method === 'GET') {
        const list = repo.comments.get(num) ?? [];
        return {
          status: 200,
          json: list.map((c) => ({
            id: c.id,
            node_id: commentGid(repo, num, c.id),
            body: c.body,
            user: userJson(),
            created_at: c.createdAt,
            updated_at: c.updatedAt,
          })),
        };
      }
      return notFound();
    }
    return notFound();
  }

  // Pull requests.
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const b = bodyOf(body);
        const head = str(b.head).replace(/^[^:]+:/, '');
        const base = str(b.base).replace(/^[^:]+:/, '');
        const headTip = repo.refs.get(`refs/heads/${head}`);
        const baseTip = repo.refs.get(`refs/heads/${base}`);
        if (headTip === undefined || baseTip === undefined) {
          return { status: 422, json: { message: 'Invalid head or base branch' } };
        }
        const number = (repo.numCounter += 1);
        const { iso } = store.tick();
        const pull: Pull = {
          number,
          title: str(b.title),
          body: str(b.body),
          state: 'open',
          merged: false,
          mergedAt: null,
          mergeCommitSha: null,
          headRef: head,
          baseRef: base,
          headSha: headTip,
          baseSha: baseTip,
          mergeBaseSha: baseTip,
          createdSeq: number,
          createdAt: iso,
          updatedAt: iso,
        };
        repo.pulls.set(number, pull);
        return { status: 201, json: pullJson(store, repo, pull) };
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let list = [...repo.pulls.values()];
        if (state !== 'all') list = list.filter((p) => p.state === state);
        list.sort((a, b) => b.createdSeq - a.createdSeq);
        const { page, link } = paginate(
          list.map((p) => pullJson(store, repo, p)),
          query,
          `${origin}/api/v3/repos/${repo.fullName}/pulls`,
        );
        return { status: 200, json: page, headers: link !== null ? { link } : {} };
      }
      return notFound();
    }
    const num = Number(rest[1]);
    if (!Number.isInteger(num) || num < 1) return notFound();
    const pull = repo.pulls.get(num);
    if (rest.length === 2) {
      if (method === 'GET') {
        if (pull === undefined) return notFound();
        return { status: 200, json: pullJson(store, repo, pull) };
      }
      return notFound();
    }
    if (rest[2] === 'files' && method === 'GET') {
      if (pull === undefined) return notFound();
      const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
      const baseTree = treeOfTip(store, repo, baseTip);
      const headTree = treeOfTip(store, repo, pull.headSha);
      const diff = store.diffTrees(repo, baseTree, headTree);
      return {
        status: 200,
        json: diff.map((d) => ({
          filename: d.path,
          status: d.status,
          additions: d.additions,
          deletions: d.deletions,
          changes: d.additions + d.deletions,
          blob_url: '',
          raw_url: '',
          contents_url: '',
        })),
      };
    }
    if (rest[2] === 'merge' && method === 'PUT') {
      if (pull === undefined) return notFound();
      const result = mergePullRequest(store, repo, pull);
      return { status: result.status, json: result.json };
    }
    return notFound();
  }

  return null;
}

/** Squash-merge a pull request (shared by REST, GraphQL and MCP). */
export function mergePullRequest(
  store: Store,
  repo: Repo,
  pull: Pull,
): { status: number; json: Record<string, unknown> } {
  if (pull.merged) {
    return { status: 405, json: { message: 'Pull request already merged' } };
  }
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (baseTip === undefined) {
    return { status: 404, json: { message: 'Not Found' } };
  }
  const conflicts = store.mergeConflicts(repo, pull.mergeBaseSha, baseTip, pull.headSha);
  if (conflicts.length > 0) {
    return { status: 405, json: { message: 'Merge conflict' } };
  }
  const treeOid = store.mergeTree(repo, pull.mergeBaseSha, baseTip, pull.headSha);
  const mergeSha = store.makeCommit(repo, treeOid, [baseTip], pull.title);
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  const { iso } = store.tick();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = iso;
  pull.mergeCommitSha = mergeSha;
  pull.updatedAt = iso;
  return {
    status: 200,
    json: { sha: mergeSha, merged: true, message: 'Pull request successfully merged.' },
  };
}

function treeOfTip(store: Store, repo: Repo, tip: string): string {
  const obj = repo.objects.get(tip);
  if (obj === undefined || obj.type !== 'commit') return '';
  return parseCommit(obj.data).tree;
}

function treeOidOfDir(store: Store, repo: Repo, rootTreeOid: string, dirPath: string): string {
  const parts = dirPath.split('/').filter((p) => p !== '');
  let current = rootTreeOid;
  for (const part of parts) {
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'tree') return '';
    const entry = parseTree(obj.data).find((e) => e.name === part && e.mode === '40000');
    if (entry === undefined) return '';
    current = entry.oid;
  }
  return current;
}
