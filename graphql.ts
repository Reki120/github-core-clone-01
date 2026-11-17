// GitHub GraphQL v4, for exactly the documents gh and github-mcp-server send: a small parser
// plus an executor over the store. Unknown fields answer HTTP 200 with an errors array naming
// the field; an unknown repository answers data.repository = null with no errors.

import {
  VIEWER,
  parseCommit,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import {
  commentGid,
  decodeGid,
  issueGid,
  mergePullRequest,
  prGid,
  repoGid,
  userGid,
} from './rest.ts';

// ---------------------------------------------------------------------------
// Tokenizer and parser (only what the suite's documents use)
// ---------------------------------------------------------------------------

type Tok =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'var'; value: string };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[j + 1] as string;
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
          j += 2;
        } else {
          out += src[j] as string;
          j += 1;
        }
      }
      toks.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (c === '$') {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j] as string)) j += 1;
      toks.push({ kind: 'var', value: src.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (c === '.' && src.slice(i, i + 3) === '...') {
      toks.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():!@[]=|&'.includes(c)) {
      toks.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1;
      let isFloat = false;
      if (src[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1;
      }
      toks.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j] as string)) j += 1;
      toks.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  return toks;
}

type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface FieldNode {
  alias?: string;
  name: string;
  args: Record<string, ValueNode>;
  selection?: FieldNode[];
  fragmentOn?: string;
}

interface OperationNode {
  kind: 'query' | 'mutation';
  name?: string;
  varDefs: Record<string, ValueNode | undefined>;
  selection: FieldNode[];
}

class Parser {
  private pos = 0;
  private readonly toks: Tok[];
  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  private peek(): Tok | undefined {
    return this.toks[this.pos];
  }
  private next(): Tok {
    const t = this.toks[this.pos];
    if (t === undefined) throw new Error('unexpected end of document');
    this.pos += 1;
    return t;
  }
  private expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) throw new Error(`expected ${value}`);
  }
  private isPunct(value: string): boolean {
    const t = this.peek();
    return t !== undefined && t.kind === 'punct' && t.value === value;
  }

  parseDocument(): OperationNode[] {
    const ops: OperationNode[] = [];
    while (this.peek() !== undefined) {
      ops.push(this.parseOperation());
    }
    return ops;
  }

  private parseOperation(): OperationNode {
    let kind: 'query' | 'mutation' = 'query';
    const t = this.peek();
    if (t?.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
      kind = t.value;
      this.next();
    }
    let name: string | undefined;
    const nt = this.peek();
    if (nt?.kind === 'name') {
      name = nt.value;
      this.next();
    }
    const varDefs: Record<string, ValueNode | undefined> = {};
    if (this.isPunct('(')) {
      this.next();
      while (!this.isPunct(')')) {
        const v = this.next();
        if (v.kind !== 'var') throw new Error('expected variable');
        // Skip the type (names, !, [ ]).
        while (this.peek() !== undefined && !this.isPunct('=') && !this.isPunct(',') && !this.isPunct(')')) this.next();
        let def: ValueNode | undefined;
        if (this.isPunct('=')) {
          this.next();
          def = this.parseValue();
        }
        varDefs[v.value] = def;
        if (this.isPunct(',')) this.next();
      }
      this.expectPunct(')');
    }
    const selection = this.parseSelectionSet();
    return { kind, name, varDefs, selection };
  }

  private parseSelectionSet(): FieldNode[] {
    this.expectPunct('{');
    const fields: FieldNode[] = [];
    while (!this.isPunct('}')) {
      fields.push(this.parseField());
    }
    this.expectPunct('}');
    return fields;
  }

  private parseField(): FieldNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '...') {
      const nt = this.peek();
      if (nt?.kind === 'name' && nt.value === 'on') {
        this.next();
        const typeName = this.next();
        if (typeName.kind !== 'name') throw new Error('expected type name');
        const selection = this.parseSelectionSet();
        return { name: '__fragment', args: {}, selection, fragmentOn: typeName.value };
      }
      // Named fragment spread: not used by the suite; parse and drop.
      this.next();
      return { name: '__fragment', args: {}, selection: [] };
    }
    if (t.kind !== 'name') throw new Error('expected field name');
    let alias: string | undefined;
    let name = t.value;
    if (this.isPunct(':')) {
      this.next();
      const n = this.next();
      if (n.kind !== 'name') throw new Error('expected field name after alias');
      alias = name;
      name = n.value;
    }
    const args: Record<string, ValueNode> = {};
    if (this.isPunct('(')) {
      this.next();
      while (!this.isPunct(')')) {
        const a = this.next();
        if (a.kind !== 'name') throw new Error('expected argument name');
        this.expectPunct(':');
        args[a.value] = this.parseValue();
        if (this.isPunct(',')) this.next();
      }
      this.expectPunct(')');
    }
    let selection: FieldNode[] | undefined;
    if (this.isPunct('{')) selection = this.parseSelectionSet();
    return { alias, name, args, selection };
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'var') return { kind: 'var', name: t.value };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: Number(t.value) };
    if (t.kind === 'float') return { kind: 'float', value: Number(t.value) };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'bool', value: true };
      if (t.value === 'false') return { kind: 'bool', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const items: ValueNode[] = [];
      while (!this.isPunct(']')) {
        items.push(this.parseValue());
        if (this.isPunct(',')) this.next();
      }
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!this.isPunct('}')) {
        const a = this.next();
        if (a.kind !== 'name') throw new Error('expected object field name');
        this.expectPunct(':');
        fields[a.value] = this.parseValue();
        if (this.isPunct(',')) this.next();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error('unexpected value');
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'var':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'bool':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node.fields)) out[k] = resolveValue(v, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

type NodeValue = { __typename: string; [key: string]: unknown } | null;

const FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email', 'avatarUrl'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'description', 'private', 'issue', 'issues', 'pullRequests', 'pullRequest',
    'createdAt', 'updatedAt', 'url',
  ],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
  IssueConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  IssueEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable',
    'files', 'headRef', 'baseRef', 'author', 'createdAt', 'updatedAt',
  ],
  PullRequestConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  Ref: ['name', 'target'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description', 'type'],
  __EnumValue: ['name', 'description'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'comment', 'clientMutationId', 'subject'],
  IssueCommentEdge: ['node', 'cursor'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
};

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'closed', 'locked', 'url'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'headRef', 'baseRef', 'author', 'createdAt', 'updatedAt', 'additions', 'deletions', 'changedFiles', 'commits', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'createdAt', 'updatedAt', 'url', 'fork', 'archived'],
  User: ['login', 'id', 'name', 'email', 'avatarUrl'],
  IssueConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  PullRequestConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
};

const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'PACKAGE', 'MILESTONE', 'PROJECT', 'WIKI'],
  IssueState: ['OPEN', 'CLOSED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

interface Ctx {
  store: Store;
  errors: Array<{ message: string }>;
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(field.args)) out[k] = resolveValue(v, variables);
  return out;
}

function cursorFor(number: number): string {
  return Buffer.from(`issue:${number}`, 'utf8').toString('base64');
}

function issueNode(repo: Repo, issue: Issue): NodeValue {
  return { __typename: 'Issue', repo, issue };
}

function pullNode(repo: Repo, pull: Pull): NodeValue {
  return { __typename: 'PullRequest', repo, pull };
}

function repoNode(repo: Repo): NodeValue {
  return { __typename: 'Repository', repo };
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): NodeValue {
  let list = [...repo.issues.values()];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toUpperCase()));
    list = list.filter((i) => wanted.has(i.state.toUpperCase()));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  const direction = orderBy?.direction === 'ASC' ? 1 : -1;
  list.sort((a, b) => direction * (a.number - b.number));
  const after = args.after as string | undefined;
  if (typeof after === 'string' && after !== '') {
    try {
      const decoded = Buffer.from(after, 'base64').toString('utf8');
      const m = /^issue:(\d+)$/.exec(decoded);
      if (m) {
        const idx = list.findIndex((i) => i.number === Number(m[1]));
        if (idx >= 0) list = list.slice(idx + 1);
      }
    } catch {
      // An unreadable cursor yields the first page.
    }
  }
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(0, Math.max(0, first));
  const hasNextPage = list.length > page.length;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1]?.number ?? 0) : null;
  return {
    __typename: 'IssueConnection',
    repo,
    nodes: page.map((i) => issueNode(repo, i)),
    pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor },
  };
}

function prFilesConnection(ctx: Ctx, repo: Repo, pull: Pull, first: number): NodeValue {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const baseTree = treeOfTip(repo, baseTip);
  const headTree = treeOfTip(repo, pull.headSha);
  const diff = ctx.store.diffTrees(repo, baseTree, headTree);
  const nodes = diff.slice(0, Math.max(0, first)).map((d) => ({
    __typename: 'PullRequestChangedFile',
    path: d.path,
    additions: d.additions,
    deletions: d.deletions,
    changeType: d.status.toUpperCase(),
  }));
  return {
    __typename: 'PullRequestChangedFileConnection',
    repo,
    nodes,
    pageInfo: { __typename: 'PageInfo', hasNextPage: diff.length > nodes.length, endCursor: null },
  };
}

function treeOfTip(repo: Repo, tip: string): string {
  const obj = repo.objects.get(tip);
  if (obj === undefined || obj.type !== 'commit') return '';
  return parseCommit(obj.data).tree;
}

function findRepoByGid(store: Store, id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGid(id);
  if (decoded === null || decoded.type !== 'Repository') return null;
  return store.repos.get(decoded.key) ?? null;
}

function findIssueByGid(store: Store, id: unknown): { repo: Repo; issue: Issue } | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGid(id);
  if (decoded === null || decoded.type !== 'Issue') return null;
  const m = /^(.+)#(\d+)$/.exec(decoded.key);
  if (m === null) return null;
  const repo = store.repos.get(m[1] as string);
  if (repo === undefined) return null;
  const issue = repo.issues.get(Number(m[2]));
  return issue === undefined ? null : { repo, issue };
}

function findPullByGid(store: Store, id: unknown): { repo: Repo; pull: Pull } | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGid(id);
  if (decoded === null || decoded.type !== 'PullRequest') return null;
  const m = /^(.+)#(\d+)$/.exec(decoded.key);
  if (m === null) return null;
  const repo = store.repos.get(m[1] as string);
  if (repo === undefined) return null;
  const pull = repo.pulls.get(Number(m[2]));
  return pull === undefined ? null : { repo, pull };
}

function resolveField(ctx: Ctx, parentType: string, parent: NodeValue, field: FieldNode, variables: Record<string, unknown>): unknown {
  const { store } = ctx;
  const args = argsOf(field, variables);
  if (parent === null) return null;
  switch (parentType) {
    case 'Query': {
      if (field.name === 'viewer') return { __typename: 'User', login: VIEWER.login };
      if (field.name === 'repository') {
        if (args.owner !== VIEWER.login) return null;
        const repo = store.getRepo(String(args.owner), String(args.name));
        return repo === undefined ? null : repoNode(repo);
      }
      if (field.name === 'node') {
        const decoded = typeof args.id === 'string' ? decodeGid(args.id) : null;
        if (decoded !== null && decoded.type === 'Repository') {
          const repo = store.repos.get(decoded.key);
          return repo === undefined ? null : repoNode(repo);
        }
        if (decoded !== null && decoded.type === 'Issue') {
          const found = findIssueByGid(store, args.id);
          return found === null ? null : issueNode(found.repo, found.issue);
        }
        if (decoded !== null && decoded.type === 'PullRequest') {
          const found = findPullByGid(store, args.id);
          return found === null ? null : pullNode(found.repo, found.pull);
        }
        return null;
      }
      if (field.name === '__type') {
        return { __typename: '__Type', name: String(args.name ?? '') };
      }
      return null;
    }
    case 'Mutation': {
      if (field.name === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = findRepoByGid(store, input.repositoryId);
        if (repo === null) {
          ctx.errors.push({ message: 'Repository not found' });
          return { __typename: 'CreateIssuePayload', issue: null };
        }
        const number = (repo.numCounter += 1);
        const { iso } = store.tick();
        const issue: Issue = {
          number,
          title: String(input.title ?? ''),
          body: String(input.body ?? ''),
          state: 'open',
          labels: [],
          createdSeq: number,
          createdAt: iso,
          updatedAt: iso,
        };
        repo.issues.set(number, issue);
        return { __typename: 'CreateIssuePayload', issue: issueNode(repo, issue) };
      }
      if (field.name === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = findIssueByGid(store, input.issueId);
        if (found === null) {
          ctx.errors.push({ message: 'Issue not found' });
          return { __typename: 'CloseIssuePayload', issue: null };
        }
        found.issue.state = 'closed';
        found.issue.updatedAt = store.tick().iso;
        return { __typename: 'CloseIssuePayload', issue: issueNode(found.repo, found.issue) };
      }
      if (field.name === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = findRepoByGid(store, input.repositoryId);
        if (repo === null) {
          ctx.errors.push({ message: 'Repository not found' });
          return { __typename: 'CreatePullRequestPayload', pullRequest: null };
        }
        const head = String(input.headRefName ?? '');
        const base = String(input.baseRefName ?? '');
        const headTip = repo.refs.get(`refs/heads/${head}`);
        const baseTip = repo.refs.get(`refs/heads/${base}`);
        if (headTip === undefined || baseTip === undefined) {
          ctx.errors.push({ message: 'Invalid head or base branch' });
          return { __typename: 'CreatePullRequestPayload', pullRequest: null };
        }
        const number = (repo.numCounter += 1);
        const { iso } = store.tick();
        const pull: Pull = {
          number,
          title: String(input.title ?? ''),
          body: '',
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
        return { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(repo, pull) };
      }
      if (field.name === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = findPullByGid(store, input.pullRequestId);
        if (found === null) {
          ctx.errors.push({ message: 'Pull request not found' });
          return { __typename: 'MergePullRequestPayload', pullRequest: null };
        }
        const result = mergePullRequest(store, found.repo, found.pull);
        if (result.status !== 200) {
          ctx.errors.push({ message: String((result.json as Record<string, unknown>).message ?? 'Merge failed') });
        }
        return { __typename: 'MergePullRequestPayload', pullRequest: pullNode(found.repo, found.pull) };
      }
      if (field.name === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = findIssueByGid(store, input.subjectId);
        if (found === null) {
          ctx.errors.push({ message: 'Subject not found' });
          return { __typename: 'AddCommentPayload', commentEdge: null };
        }
        const id = (found.repo.commentCounter += 1);
        const { iso } = store.tick();
        const comment = { id, issueNumber: found.issue.number, body: String(input.body ?? ''), createdAt: iso, updatedAt: iso };
        const list = found.repo.comments.get(found.issue.number) ?? [];
        list.push(comment);
        found.repo.comments.set(found.issue.number, list);
        return {
          __typename: 'AddCommentPayload',
          commentEdge: {
            __typename: 'IssueCommentEdge',
            node: {
              __typename: 'IssueComment',
              id: commentGid(found.repo, found.issue.number, id),
              body: comment.body,
            },
          },
        };
      }
      return null;
    }
    case 'User': {
      if (field.name === 'login') return parent.login;
      if (field.name === 'id') return userGid(String(parent.login));
      if (field.name === 'name') return VIEWER.name;
      if (field.name === 'email') return VIEWER.email;
      return null;
    }
    case 'Repository': {
      const repo = parent.repo as Repo;
      switch (field.name) {
        case 'id':
          return repoGid(repo);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return repo.fullName;
        case 'owner':
          return { __typename: 'User', login: repo.owner };
        case 'defaultBranchRef': {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          return tip === undefined ? null : { __typename: 'Ref', name: repo.defaultBranch };
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'description':
          return repo.description;
        case 'private':
          return repo.private;
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          return issue === undefined ? null : issueNode(repo, issue);
        }
        case 'issues':
          return issuesConnection(repo, args);
        case 'pullRequests': {
          const first = typeof args.first === 'number' ? args.first : undefined;
          let list = [...repo.pulls.values()].sort((a, b) => b.createdSeq - a.createdSeq);
          if (first !== undefined) list = list.slice(0, first);
          return {
            __typename: 'PullRequestConnection',
            repo,
            nodes: list.map((p) => pullNode(repo, p)),
            pageInfo: { __typename: 'PageInfo', hasNextPage: false, endCursor: null },
          };
        }
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.number));
          return pull === undefined ? null : pullNode(repo, pull);
        }
        default:
          return null;
      }
    }
    case 'Issue': {
      const issue = parent.issue as Issue;
      switch (field.name) {
        case 'id':
          return issueGid(parent.repo as Repo, issue.number);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'state':
          return issue.state.toUpperCase();
        case 'body':
          return issue.body;
        default:
          return null;
      }
    }
    case 'IssueConnection': {
      if (field.name === 'nodes') return parent.nodes;
      if (field.name === 'pageInfo') return parent.pageInfo;
      if (field.name === 'totalCount') return (parent.nodes as unknown[]).length;
      return null;
    }
    case 'IssueEdge': {
      if (field.name === 'node') return parent.node;
      if (field.name === 'cursor') return parent.cursor ?? null;
      return null;
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return parent.hasNextPage ?? false;
      if (field.name === 'endCursor') return parent.endCursor ?? null;
      if (field.name === 'hasPreviousPage') return false;
      if (field.name === 'startCursor') return null;
      return null;
    }
    case 'PullRequest': {
      const pull = parent.pull as Pull;
      const repo = parent.repo as Repo;
      switch (field.name) {
        case 'id':
          return prGid(repo, pull.number);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pull.state === 'open' ? 'OPEN' : pull.merged ? 'MERGED' : 'CLOSED';
        case 'merged':
          return pull.merged;
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'mergeable': {
          const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? '';
          return store.mergeConflicts(repo, pull.mergeBaseSha, baseTip, pull.headSha).length === 0 ? 'MERGEABLE' : 'CONFLICTING';
        }
        case 'files':
          return prFilesConnection(ctx, repo, pull, typeof args.first === 'number' ? args.first : 10);
        default:
          return null;
      }
    }
    case 'PullRequestConnection': {
      if (field.name === 'nodes') return parent.nodes;
      if (field.name === 'pageInfo') return parent.pageInfo;
      if (field.name === 'totalCount') return (parent.nodes as unknown[]).length;
      return null;
    }
    case 'PullRequestChangedFileConnection': {
      if (field.name === 'nodes') return parent.nodes;
      if (field.name === 'pageInfo') return parent.pageInfo;
      if (field.name === 'totalCount') return (parent.nodes as unknown[]).length;
      return null;
    }
    case 'PullRequestChangedFile': {
      if (field.name === 'path') return parent.path;
      if (field.name === 'additions') return parent.additions ?? 0;
      if (field.name === 'deletions') return parent.deletions ?? 0;
      if (field.name === 'changeType') return parent.changeType ?? 'MODIFIED';
      return null;
    }
    case 'Ref': {
      if (field.name === 'name') return parent.name;
      return null;
    }
    case '__Type': {
      const name = String(parent.name ?? '');
      if (field.name === 'name') return name;
      if (field.name === 'kind') return TYPE_ENUMS[name] !== undefined ? 'ENUM' : 'OBJECT';
      if (field.name === 'fields') {
        const list = TYPE_FIELDS[name];
        return list === undefined ? null : list.map((n) => ({ __typename: '__Field', name: n }));
      }
      if (field.name === 'enumValues') {
        const list = TYPE_ENUMS[name];
        return list === undefined ? null : list.map((n) => ({ __typename: '__EnumValue', name: n }));
      }
      return null;
    }
    case '__Field': {
      if (field.name === 'name') return parent.name;
      return null;
    }
    case '__EnumValue': {
      if (field.name === 'name') return parent.name;
      return null;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (field.name === 'issue') return parent.issue ?? null;
      return null;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (field.name === 'pullRequest') return parent.pullRequest ?? null;
      return null;
    }
    case 'AddCommentPayload': {
      if (field.name === 'commentEdge') return parent.commentEdge ?? null;
      return null;
    }
    case 'IssueCommentEdge': {
      if (field.name === 'node') return parent.node ?? null;
      return null;
    }
    case 'IssueComment': {
      if (field.name === 'id') return parent.id;
      if (field.name === 'body') return parent.body;
      return null;
    }
    default:
      return null;
  }
}

function executeSelection(
  ctx: Ctx,
  parentType: string,
  parent: NodeValue,
  selection: FieldNode[],
  variables: Record<string, unknown>,
): Record<string, unknown> | null {
  if (parent === null) return null;
  const out: Record<string, unknown> = {};
  for (const field of selection) {
    if (field.name === '__fragment') {
      if (field.fragmentOn !== undefined && field.fragmentOn !== parentType) continue;
      const nested = executeSelection(ctx, parentType, parent, field.selection ?? [], variables);
      if (nested !== null) Object.assign(out, nested);
      continue;
    }
    const known = FIELDS[parentType] ?? [];
    if (!known.includes(field.name)) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${parentType}".` });
      continue;
    }
    const key = field.alias ?? field.name;
    const value = resolveField(ctx, parentType, parent, field, variables);
    if (field.selection !== undefined && value !== null && value !== undefined) {
      if (Array.isArray(value)) {
        // A list of nodes: each item keeps its own __typename.
        out[key] = value.map((item) => {
          if (item !== null && typeof item === 'object' && '__typename' in item) {
            return executeSelection(ctx, (item as NodeValue)?.__typename ?? '', item as NodeValue, field.selection as FieldNode[], variables);
          }
          return item;
        });
      } else if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
        const node = value as NodeValue;
        out[key] = executeSelection(ctx, node?.__typename ?? '', node, field.selection as FieldNode[], variables);
      } else {
        out[key] = value;
      }
    } else {
      out[key] = value === undefined ? null : value;
    }
  }
  return out;
}

function executeDocument(
  ctx: Ctx,
  query: string,
  variables: Record<string, unknown>,
  operationName?: string,
): { data: unknown; errors: Array<{ message: string }> } {
  let ops: OperationNode[];
  try {
    ops = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  let op = ops[0];
  if (ops.length > 1 && operationName !== undefined) {
    op = ops.find((o) => o.name === operationName) ?? ops[0];
  }
  if (op === undefined) return { data: null, errors: [{ message: 'no operation' }] };
  const vars: Record<string, unknown> = { ...variables };
  for (const [name, def] of Object.entries(op.varDefs)) {
    if (vars[name] === undefined && def !== undefined) vars[name] = resolveValue(def, vars);
  }
  const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection(ctx, rootType, { __typename: rootType }, op.selection, vars);
  return { data, errors: ctx.errors };
}

export function handleGraphQL(store: Store, body: unknown): { status: number; json: unknown } {
  const runOne = (doc: unknown): Record<string, unknown> => {
    const ctx: Ctx = { store, errors: [] };
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
      return { data: null, errors: [{ message: 'invalid GraphQL request' }] };
    }
    const d = doc as Record<string, unknown>;
    if (typeof d.query !== 'string') {
      return { data: null, errors: [{ message: 'query is required' }] };
    }
    const variables = (d.variables ?? {}) as Record<string, unknown>;
    const result = executeDocument(ctx, d.query, variables, typeof d.operationName === 'string' ? d.operationName : undefined);
    const out: Record<string, unknown> = { data: result.data };
    if (result.errors.length > 0) out.errors = result.errors;
    return out;
  };
  if (Array.isArray(body)) {
    return { status: 200, json: body.map(runOne) };
  }
  return { status: 200, json: runOne(body) };
}
