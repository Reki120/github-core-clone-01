// The forge's HTTP server: one process, the store, and four surfaces — git smart HTTP,
// REST v3, GraphQL v4 and MCP — plus the /healthz boot probe. main.ts owns the lifecycle;
// this file is the server the suite scores.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { Store } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
/** The largest request body accepted (packs stay far below this). */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const store = new Store();

/** The bearer token the suite presents; unset only outside a trial (fail open there). */
function isAuthorized(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const auth = req.headers.authorization ?? '';
  if (expected === '') return auth.startsWith('Bearer ') && auth.length > 7;
  return auth === `Bearer ${expected}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': store.nextRequestId(),
    ...headers,
  });
  res.end(text);
}

function sendNoBody(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'x-github-request-id': store.nextRequestId() });
  res.end();
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': store.nextRequestId(),
  });
  res.end(body);
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) as unknown };
  } catch {
    return { ok: false };
  }
}

function originOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

function segmentsOf(pathname: string): string[] {
  return pathname.split('/').filter((s) => s !== '');
}

/** Build the server. It binds nothing until the caller listens; the entry listens on port 0. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const pathname = url.pathname;
        const method = req.method ?? 'GET';
        const seg = segmentsOf(pathname);

        // The env's boot probe: 200 {"ok":true}, no token.
        if (method === 'GET' && pathname === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // Git smart HTTP: /<owner>/<repo>.git/info/refs and the two pack endpoints.
        if (seg.length >= 2 && (seg[1] ?? '').endsWith('.git')) {
          const owner = decodeURIComponent(seg[0] ?? '');
          const repoName = decodeURIComponent((seg[1] ?? '').slice(0, -'.git'.length));
          const repo = store.getRepo(owner, repoName);
          const tail = seg.slice(2).join('/');
          if (tail === 'info/refs' && method === 'GET') {
            const out = handleInfoRefs(repo, url.searchParams.get('service'), req.headers['git-protocol']);
            sendRaw(res, out.status, out.contentType, out.body);
            return;
          }
          if (tail === 'git-upload-pack' && method === 'POST') {
            const raw = await readBody(req);
            const out = handleUploadPack(store, repo, raw, req.headers['git-protocol']);
            sendRaw(res, out.status, out.contentType, out.body);
            return;
          }
          if (tail === 'git-receive-pack' && method === 'POST') {
            const raw = await readBody(req);
            const out = handleReceivePack(store, repo, raw);
            sendRaw(res, out.status, out.contentType, out.body);
            return;
          }
          notFound(res);
          return;
        }

        // GraphQL v4.
        if (pathname === '/api/graphql') {
          if (method !== 'POST') {
            notFound(res);
            return;
          }
          if (!isAuthorized(req)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          const raw = await readBody(req);
          const parsed = parseJsonBody(raw);
          if (!parsed.ok) {
            sendJson(res, 400, { message: 'Bad Request' });
            return;
          }
          const out = handleGraphQL(store, parsed.value);
          sendJson(res, out.status, out.json);
          return;
        }

        // MCP over Streamable HTTP.
        if (pathname === '/mcp') {
          if (method !== 'POST') {
            notFound(res);
            return;
          }
          if (!isAuthorized(req)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          const raw = await readBody(req);
          const out = handleMcp(store, raw.toString('utf8'));
          if (out.noBody) {
            sendNoBody(res, out.status);
            return;
          }
          sendJson(res, out.status, out.json, out.headers ?? {});
          return;
        }

        // REST v3.
        if (seg[0] === 'api' && seg[1] === 'v3') {
          const restSeg = seg.slice(2);
          const isPublic = method === 'GET' && (restSeg.length === 0 || (restSeg.length === 1 && restSeg[0] === 'meta'));
          if (!isPublic && !isAuthorized(req)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          const raw = await readBody(req);
          let parsed: unknown = {};
          if (raw.length > 0) {
            const p = parseJsonBody(raw);
            if (!p.ok) {
              sendJson(res, 400, { message: 'Problems parsing JSON' });
              return;
            }
            parsed = p.value;
          }
          const out = handleRest(store, method, restSeg, url.searchParams, parsed, originOf(req));
          if (out === null) {
            notFound(res);
            return;
          }
          if (out.noBody) {
            sendNoBody(res, out.status);
            return;
          }
          sendJson(res, out.status, out.json, out.headers ?? {});
          return;
        }

        notFound(res);
      } catch (err) {
        if (!res.headersSent) {
          try {
            sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
          } catch {
            // The client is gone; nothing more to do.
          }
        }
      }
    })();
  });
}
