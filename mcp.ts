// Model Context Protocol over Streamable HTTP: the modern 2026-07-28 era via server/discover,
// plus the legacy initialize handshake. Tools act on the same store as REST and GraphQL.

import {
  VIEWER,
  type Repo,
  type Store,
} from './store.ts';
import {
  issueJson,
  mergePullRequest,
  pullJson,
  repoJson,
} from './rest.ts';

export const MCP_REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const SERVER_INFO = { name: 'git-forge', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Issue state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const ALIASES: Record<string, string[]> = {
  create_repo: ['create_repository', 'repo_create', 'repos_create', 'repository_create'],
  get_repo: ['get_repository', 'repo_get', 'repos_get', 'repository_get'],
  create_issue: ['issue_create', 'issues_create'],
  list_issues: ['issues_list', 'issue_list'],
  create_pull_request: ['pull_request_create', 'pulls_create', 'create_pr', 'pr_create'],
  merge_pull_request: ['pull_request_merge', 'pulls_merge', 'merge_pr', 'pr_merge'],
};

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function canonicalTool(name: string): string | null {
  const norm = normalizeName(name);
  for (const tool of TOOLS) {
    if (norm === normalizeName(tool.name)) return tool.name;
    const aliases = ALIASES[tool.name] ?? [];
    for (const alias of aliases) {
      if (norm === normalizeName(alias)) return tool.name;
    }
    // A server prefix is allowed: github__create_issue matches as a suffix.
    if (norm.endsWith(normalizeName(tool.name))) return tool.name;
  }
  return null;
}

interface RpcError {
  code: number;
  message: string;
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, error: RpcError): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error };
}

function toolResult(data: unknown, isError = false): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }],
    structuredContent: data,
    isError,
  };
}

function toolError(message: string): Record<string, unknown> {
  return toolResult({ error: message }, true);
}

function ownedRepo(store: Store, owner: unknown, repoName: unknown): Repo | null {
  if (owner !== VIEWER.login || typeof repoName !== 'string') return null;
  return store.getRepo(VIEWER.login, repoName) ?? null;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const canonical = canonicalTool(name);
  if (canonical === null) {
    throw { code: -32602, message: `Unknown tool: ${name}` } as RpcError;
  }
  const tool = TOOLS.find((t) => t.name === canonical) as ToolDef;
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return toolError(`Missing required argument: ${required}`);
    }
  }
  switch (canonical) {
    case 'create_repo': {
      const repoName = String(args.name);
      if (store.getRepo(VIEWER.login, repoName) !== undefined) {
        return toolError('Repository already exists.');
      }
      const repo = store.createRepo(
        VIEWER.login,
        repoName,
        typeof args.description === 'string' ? args.description : '',
        args.private === true,
      );
      return toolResult({ ...repoJson(store, repo), full_name: repo.fullName });
    }
    case 'get_repo': {
      const repo = ownedRepo(store, args.owner, args.repo);
      if (repo === null) return toolError('Repository not found');
      return toolResult({ ...repoJson(store, repo), full_name: repo.fullName });
    }
    case 'create_issue': {
      const repo = ownedRepo(store, args.owner, args.repo);
      if (repo === null) return toolError('Repository not found');
      const number = (repo.numCounter += 1);
      const { iso } = store.tick();
      const issue = {
        number,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const,
        labels: [] as string[],
        createdSeq: number,
        createdAt: iso,
        updatedAt: iso,
      };
      repo.issues.set(number, issue);
      return toolResult(issueJson(store, repo, issue));
    }
    case 'list_issues': {
      const repo = ownedRepo(store, args.owner, args.repo);
      if (repo === null) return toolError('Repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((i) => i.state === state);
      list.sort((a, b) => b.createdSeq - a.createdSeq);
      const items = list.map((i) => issueJson(store, repo, i));
      return toolResult({ issues: items });
    }
    case 'create_pull_request': {
      const repo = ownedRepo(store, args.owner, args.repo);
      if (repo === null) return toolError('Repository not found');
      const head = String(args.head);
      const base = String(args.base);
      const headTip = repo.refs.get(`refs/heads/${head}`);
      const baseTip = repo.refs.get(`refs/heads/${base}`);
      if (headTip === undefined || baseTip === undefined) {
        return toolError('Invalid head or base branch');
      }
      const number = (repo.numCounter += 1);
      const { iso } = store.tick();
      const pull = {
        number,
        title: String(args.title),
        body: '',
        state: 'open' as const,
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
      return toolResult(pullJson(store, repo, pull));
    }
    case 'merge_pull_request': {
      const repo = ownedRepo(store, args.owner, args.repo);
      if (repo === null) return toolError('Repository not found');
      const pull = repo.pulls.get(Number(args.pull_number));
      if (pull === undefined) return toolError('Pull request not found');
      const result = mergePullRequest(store, repo, pull);
      if (result.status !== 200) {
        return toolError(String((result.json as Record<string, unknown>).message ?? 'Merge failed'));
      }
      return toolResult({
        number: pull.number,
        merged: true,
        state: 'closed',
        sha: (result.json as Record<string, unknown>).sha,
        merge_commit_sha: (result.json as Record<string, unknown>).sha,
      });
    }
    default:
      throw { code: -32602, message: `Unknown tool: ${name}` } as RpcError;
  }
}

export function handleMcp(
  store: Store,
  rawBody: string,
): { status: number; json: unknown; headers?: Record<string, string>; noBody?: boolean } {
  let body: unknown;
  try {
    body = JSON.parse(rawBody) as unknown;
  } catch {
    let id: unknown = null;
    const m = /"id"\s*:\s*("([^"]*)"|(\d+))/.exec(rawBody);
    if (m !== null) id = m[2] !== undefined ? m[2] : Number(m[3]);
    return { status: 400, json: rpcError(id, { code: -32700, message: 'Parse error' }) };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, json: rpcError(null, { code: -32600, message: 'Invalid Request' }) };
  }
  const req = body as Record<string, unknown>;
  const id = req.id;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params ?? {}) as Record<string, unknown>;

  // A notification (no id) is answered with 202 and no body.
  if (id === undefined) {
    if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
      return { status: 202, json: null, noBody: true };
    }
    return { status: 400, json: rpcError(null, { code: -32600, message: 'Invalid Request' }) };
  }

  try {
    if (method === 'server/discover') {
      return {
        status: 200,
        json: rpcResult(id, {
          supportedVersions: [...MCP_REVISIONS],
          capabilities: { tools: {} },
          serverInfo: { ...SERVER_INFO },
          instructions: 'A standalone GitHub-compatible git forge: repositories, issues, pull requests, git smart HTTP, GraphQL and MCP.',
          _meta: {
            'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO },
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          },
        }),
      };
    }
    if (method === 'initialize') {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2026-07-28';
      const negotiated = MCP_REVISIONS.includes(offered) ? offered : '2026-07-28';
      return {
        status: 200,
        json: rpcResult(id, {
          protocolVersion: negotiated,
          capabilities: { tools: {} },
          serverInfo: { ...SERVER_INFO },
        }),
        headers: { 'mcp-session-id': 'mcp-session-1' },
      };
    }
    if (method === 'ping') {
      return { status: 200, json: rpcResult(id, {}) };
    }
    if (method === 'tools/list') {
      return { status: 200, json: rpcResult(id, { tools: TOOLS }) };
    }
    if (method === 'tools/call') {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const result = callTool(store, name, args);
      return { status: 200, json: rpcResult(id, result) };
    }
    return { status: 200, json: rpcError(id, { code: -32601, message: `Method not found: ${method}` }) };
  } catch (err) {
    if (err !== null && typeof err === 'object' && 'code' in (err as Record<string, unknown>)) {
      const e = err as RpcError;
      return { status: 200, json: rpcError(id, e) };
    }
    return { status: 200, json: rpcError(id, { code: -32603, message: 'Internal error' }) };
  }
}
