// Git smart HTTP: protocol v2 and v0 upload-pack, v0 receive-pack, over the store in store.ts.
// The suite's client speaks both; it never sends deltas on push, and the server never needs to
// send deltas or thin packs on fetch (plain objects satisfy every check).

import {
  isOid,
  objectId,
  parseCommit,
  parseTree,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
  type Repo,
  type Store,
} from './store.ts';

export const AGENT = 'git-forge/1.0';

// ---------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------

export function pkt(data: string | Buffer): Buffer {
  const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = body.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), body]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Decode pkt-lines from `buf`. Stops after the first flush packet: in a receive-pack request
 * the pack bytes follow the flush, and they are returned via `rest`. */
export function decodePktLines(buf: Buffer): { packets: Packet[]; rest: number } {
  const packets: Packet[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error('malformed pkt-line');
    const len = parseInt(head, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      off += 4;
      break;
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end' });
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) throw new Error('malformed pkt-line length');
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets, rest: off };
}

/** Split sideband-packable bytes into pkt-lines with a band byte (max 65520 per packet). */
export function sideband(data: Buffer, band = 1): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 32768;
  for (let off = 0; off < data.length; off += CHUNK) {
    const piece = data.subarray(off, Math.min(off + CHUNK, data.length));
    out.push(pkt(Buffer.concat([Buffer.from([band]), piece])));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Advertisement
// ---------------------------------------------------------------------------

function refLines(repo: Repo): Array<{ oid: string; ref: string; peeled?: string }> {
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const out: Array<{ oid: string; ref: string; peeled?: string }> = [];
  const mainTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? '';
  if (mainTip !== '') out.push({ oid: mainTip, ref: 'HEAD' });
  for (const [ref, oid] of refs) {
    out.push({ oid, ref });
    const obj = repo.objects.get(oid);
    if (obj !== undefined && obj.type === 'tag') {
      // Peeled: the commit the annotated tag points at.
      const text = obj.data.toString('utf8');
      const m = /^object ([0-9a-f]{40})$/m.exec(text);
      if (m) {
        let target = m[1] as string;
        let guard = 0;
        while (guard++ < 10) {
          const t = repo.objects.get(target);
          if (t === undefined || t.type !== 'tag') break;
          const mm = /^object ([0-9a-f]{40})$/m.exec(t.data.toString('utf8'));
          if (!mm) break;
          target = mm[1] as string;
        }
        out.push({ oid: target, ref: `${ref}^{}` });
      }
    }
  }
  return out;
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? 'side-band-64k thin-pack ofs-delta multi_ack_detailed multi_ack shallow symref=HEAD:refs/heads/main agent=git-forge/1.0'
      : 'report-status side-band-64k delete-refs agent=git-forge/1.0';
  const parts: Buffer[] = [pkt(`# service=${service}\n`), FLUSH];
  const lines = refLines(repo);
  if (lines.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    lines.forEach((line, i) => {
      const suffix = i === 0 ? `\0${caps}` : '';
      parts.push(pkt(`${line.oid} ${line.ref}${suffix}\n`));
    });
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pkt('version 2\n'),
    pkt(`agent=${AGENT}\n`),
    pkt('ls-refs=unborn\n'),
    pkt('fetch=shallow filter\n'),
    pkt('object-format=sha1\n'),
    FLUSH,
  ]);
}

// ---------------------------------------------------------------------------
// Fetch object selection
// ---------------------------------------------------------------------------

export interface FetchSelection {
  objects: Map<string, GitObject>;
  shallow: string[];
  unshallow: string[];
}

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen?: number;
}

/** Objects reachable from a commit set without walking past the set's own parents. */
function objectsFromCommits(store: Store, repo: Repo, commits: Set<string>): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const visitTree = (treeOid: string): void => {
    const obj = repo.objects.get(treeOid);
    if (obj === undefined || obj.type !== 'tree' || out.has(treeOid)) return;
    out.set(treeOid, obj);
    for (const e of parseTree(obj.data)) {
      const child = repo.objects.get(e.oid);
      if (child === undefined) continue;
      if (child.type === 'tree') visitTree(e.oid);
      else out.set(e.oid, child);
    }
  };
  for (const c of commits) {
    const obj = repo.objects.get(c);
    if (obj === undefined) continue;
    out.set(c, obj);
    if (obj.type === 'commit') visitTree(parseCommit(obj.data).tree);
    else if (obj.type === 'tag') {
      const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (m) {
        const target = repo.objects.get(m[1] as string);
        if (target !== undefined) {
          out.set(m[1] as string, target);
          if (target.type === 'commit') visitTree(parseCommit(target.data).tree);
        }
      }
    }
  }
  return out;
}

export function selectFetch(store: Store, repo: Repo, req: FetchRequest): FetchSelection {
  const haveSet = new Set(req.haves);
  const clientShallow = new Set(req.shallow);
  const wantSet = new Set(req.wants);
  const maxDepth = req.deepen !== undefined ? req.deepen - 1 : Number.POSITIVE_INFINITY;
  // Included commits with their distance from a want (wants are distance 0).
  const included = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number }> = req.wants.filter(isOid).map((oid) => ({ oid, depth: 0 }));
  while (queue.length > 0) {
    const { oid, depth } = queue.shift() as { oid: string; depth: number };
    if (included.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined || (obj.type !== 'commit' && obj.type !== 'tag')) continue;
    included.set(oid, depth);
    if (obj.type === 'tag') {
      const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (m) queue.push({ oid: m[1] as string, depth });
      continue;
    }
    if (depth >= maxDepth) continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (included.has(parent)) continue;
      // A parent the client fully holds (have, not shallow, not itself wanted) needs no walk.
      if (haveSet.has(parent) && !clientShallow.has(parent) && !wantSet.has(parent)) continue;
      queue.push({ oid: parent, depth: depth + 1 });
    }
  }
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (req.deepen !== undefined) {
    for (const [oid, depth] of included) {
      if (depth === maxDepth) shallow.push(oid);
      else if (clientShallow.has(oid)) unshallow.push(oid);
    }
  } else {
    for (const oid of included.keys()) if (clientShallow.has(oid)) unshallow.push(oid);
  }
  // Objects the client already holds: a shallow have holds only itself plus its tree; a full
  // have holds its whole ancestry.
  const held = new Map<string, GitObject>();
  for (const h of req.haves) {
    if (!isOid(h)) continue;
    if (clientShallow.has(h)) {
      for (const [oid, obj] of objectsFromCommits(store, repo, new Set([h]))) held.set(oid, obj);
      // objectsFromCommits on a shallow have must not walk its parents: it does not (it only
      // visits the given commits), so this is exactly the commit plus its tree and blobs.
    } else {
      for (const [oid, obj] of store.reachableObjects(repo, [h])) held.set(oid, obj);
    }
  }
  const send = objectsFromCommits(store, repo, new Set(included.keys()));
  for (const oid of held.keys()) send.delete(oid);
  return { objects: send, shallow, unshallow };
}

function wantedRefLines(repo: Repo, wants: string[]): string[] {
  const lines: string[] = [];
  for (const oid of wants) {
    let ref = 'HEAD';
    const mainTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (mainTip === oid) ref = `refs/heads/${repo.defaultBranch}`;
    else {
      for (const [r, tip] of repo.refs) {
        if (tip === oid) {
          ref = r;
          break;
        }
      }
    }
    lines.push(`${oid} ${ref}`);
  }
  return lines;
}

function ackLines(repo: Repo, haves: string[]): string[] {
  if (haves.length === 0) return ['NAK'];
  const known = haves.filter((h) => isOid(h) && repo.objects.has(h));
  if (known.length === 0) return ['NAK'];
  return [`ACK ${known[0] as string}`, 'ready'];
}

// ---------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------

function lsRefsResponse(repo: Repo, args: string[]): Buffer {
  const prefixes: string[] = [];
  for (const a of args) {
    if (a.startsWith('ref-prefix ')) prefixes.push(a.slice('ref-prefix '.length));
  }
  const lines: string[] = [];
  const mainTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? '';
  const include = (ref: string): boolean => prefixes.length === 0 || prefixes.some((p) => ref.startsWith(p));
  const headIncluded = prefixes.length === 0 || prefixes.some((p) => 'HEAD'.startsWith(p));
  if (headIncluded) {
    if (mainTip === '') lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}`);
    else lines.push(`${mainTip} HEAD symref-target:refs/heads/${repo.defaultBranch}`);
  }
  for (const line of refLines(repo)) {
    if (line.ref === 'HEAD') continue;
    if (!include(line.ref)) continue;
    if (line.ref.endsWith('^{}')) {
      // Peeled lines are attached to the tag line, not listed separately.
      continue;
    }
    let text = `${line.oid} ${line.ref}`;
    const peeled = refLines(repo).find((l) => l.ref === `${line.ref}^{}`);
    if (peeled !== undefined) text += ` peeled:${peeled.oid}`;
    lines.push(text);
  }
  const parts = lines.map((l) => pkt(`${l}\n`));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function v2FetchResponse(store: Store, repo: Repo, req: FetchRequest): Buffer {
  const sel = selectFetch(store, repo, req);
  const parts: Buffer[] = [];
  parts.push(pkt('acknowledgments\n'));
  for (const line of ackLines(repo, req.haves)) parts.push(pkt(`${line}\n`));
  parts.push(DELIM);
  if (sel.shallow.length > 0 || sel.unshallow.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of sel.shallow) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of sel.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(DELIM);
  }
  const wanted = wantedRefLines(repo, req.wants);
  if (wanted.length > 0) {
    parts.push(pkt('wanted-refs\n'));
    for (const line of wanted) parts.push(pkt(`${line}\n`));
    parts.push(DELIM);
  }
  if (sel.objects.size > 0) {
    parts.push(pkt('packfile\n'));
    const pack = writePack([...sel.objects.values()]);
    for (const chunk of sideband(pack, 1)) parts.push(chunk);
    parts.push(FLUSH);
  } else {
    parts.push(FLUSH);
  }
  return Buffer.concat(parts);
}

function v0FetchResponse(store: Store, repo: Repo, req: FetchRequest): Buffer {
  const sel = selectFetch(store, repo, req);
  const parts: Buffer[] = [];
  for (const line of ackLines(repo, req.haves)) parts.push(pkt(`${line}\n`));
  for (const oid of sel.shallow) parts.push(pkt(`shallow ${oid}\n`));
  for (const oid of sel.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
  if (sel.objects.size > 0) {
    const pack = writePack([...sel.objects.values()]);
    for (const chunk of sideband(pack, 1)) parts.push(chunk);
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function parseV2Body(body: Buffer): { command: string; args: string[] } {
  const { packets } = decodePktLines(body);
  let command = '';
  const args: string[] = [];
  let afterDelim = false;
  for (const p of packets) {
    if (p.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (p.kind !== 'data') continue;
    const text = p.payload.toString('utf8').replace(/\n$/, '');
    if (!afterDelim) {
      if (text.startsWith('command=')) command = text.slice('command='.length);
    } else {
      args.push(text);
    }
  }
  return { command, args };
}

function parseV0FetchBody(body: Buffer): FetchRequest {
  const { packets } = decodePktLines(body);
  const req: FetchRequest = { wants: [], haves: [], shallow: [] };
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    let text = p.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul >= 0) text = text.slice(0, nul);
    if (text.startsWith('want ')) req.wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) req.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) req.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) req.deepen = Number(text.slice(7).trim());
  }
  return req;
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function parseReceiveBody(body: Buffer): { commands: PushCommand[]; pack: Buffer } {
  const { packets, rest } = decodePktLines(body);
  const commands: PushCommand[] = [];
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    let text = p.payload.toString('utf8');
    const nul = text.indexOf('\0');
    if (nul >= 0) text = text.slice(0, nul);
    const line = text.replace(/\n$/, '');
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (m) commands.push({ oldOid: m[1] as string, newOid: m[2] as string, ref: m[3] as string });
  }
  return { commands, pack: body.subarray(rest) };
}

// ---------------------------------------------------------------------------
// Handlers (called from app.ts with the repo already resolved)
// ---------------------------------------------------------------------------

export function handleInfoRefs(
  repo: Repo | undefined,
  service: string | null,
  gitProtocol: string | undefined,
): { status: number; contentType: string; body: Buffer } {
  if (repo === undefined) {
    return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"Not Found"}\n') };
  }
  if (service === 'git-upload-pack') {
    if (gitProtocol === 'version=2') {
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement() };
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v0Advertisement(repo, 'git-upload-pack') };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: v0Advertisement(repo, 'git-receive-pack') };
  }
  return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"Bad Request"}\n') };
}

export function handleUploadPack(
  store: Store,
  repo: Repo | undefined,
  body: Buffer,
  gitProtocol: string | undefined,
): { status: number; contentType: string; body: Buffer } {
  if (repo === undefined) {
    return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"Not Found"}\n') };
  }
  try {
    if (gitProtocol === 'version=2') {
      const { command, args } = parseV2Body(body);
      if (command === 'ls-refs') {
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefsResponse(repo, args) };
      }
      if (command === 'fetch') {
        const req: FetchRequest = { wants: [], haves: [], shallow: [] };
        for (const a of args) {
          if (a.startsWith('want ')) req.wants.push(a.slice(5).trim());
          else if (a.startsWith('have ')) req.haves.push(a.slice(5).trim());
          else if (a.startsWith('shallow ')) req.shallow.push(a.slice(8).trim());
          else if (a.startsWith('deepen ')) req.deepen = Number(a.slice(7).trim());
        }
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: v2FetchResponse(store, repo, req) };
      }
      return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"Bad Request"}\n') };
    }
    const req = parseV0FetchBody(body);
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: v0FetchResponse(store, repo, req) };
  } catch {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"Bad Request"}\n') };
  }
}

export function handleReceivePack(
  store: Store,
  repo: Repo | undefined,
  body: Buffer,
): { status: number; contentType: string; body: Buffer } {
  if (repo === undefined) {
    return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"Not Found"}\n') };
  }
  const reportLines: string[] = [];
  try {
    const { commands, pack } = parseReceiveBody(body);
    if (commands.length === 0) throw new Error('no commands');
    const hasData = commands.some((c) => c.newOid !== ZERO_OID);
    let unpackOk = true;
    let unpackDetail = 'ok';
    if (hasData) {
      try {
        if (pack.length === 0) throw new Error('missing pack');
        const objects = readPack(pack);
        for (const [oid, obj] of objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
        }
      } catch (err) {
        unpackOk = false;
        unpackDetail = err instanceof Error ? err.message : 'unpack failed';
      }
    }
    reportLines.push(`unpack ${unpackOk ? 'ok' : unpackDetail}`);
    for (const cmd of commands) {
      if (!unpackOk) {
        reportLines.push(`ng ${cmd.ref} unpack failed`);
        continue;
      }
      if (cmd.newOid === ZERO_OID) {
        // Delete.
        const current = repo.refs.get(cmd.ref);
        if (current === undefined) {
          reportLines.push(`ng ${cmd.ref} remote ref does not exist`);
        } else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
          reportLines.push(`ng ${cmd.ref} non-fast-forward`);
        } else {
          repo.refs.delete(cmd.ref);
          reportLines.push(`ok ${cmd.ref}`);
        }
        continue;
      }
      const newObj = repo.objects.get(cmd.newOid);
      if (newObj === undefined || (newObj.type !== 'commit' && newObj.type !== 'tag')) {
        reportLines.push(`ng ${cmd.ref} object not found`);
        continue;
      }
      const current = repo.refs.get(cmd.ref);
      if (current === undefined) {
        if (cmd.oldOid !== ZERO_OID) {
          reportLines.push(`ng ${cmd.ref} non-fast-forward`);
          continue;
        }
        repo.refs.set(cmd.ref, cmd.newOid);
        reportLines.push(`ok ${cmd.ref}`);
        continue;
      }
      if (cmd.oldOid !== current) {
        reportLines.push(`ng ${cmd.ref} non-fast-forward`);
        continue;
      }
      if (!store.isAncestor(repo, current, cmd.newOid)) {
        reportLines.push(`ng ${cmd.ref} non-fast-forward`);
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      reportLines.push(`ok ${cmd.ref}`);
    }
  } catch {
    reportLines.length = 0;
    reportLines.push('unpack error');
  }
  // The report-status stream is itself pkt-lined inside sideband band 1.
  const inner = Buffer.concat(reportLines.map((l) => pkt(`${l}\n`)));
  const parts: Buffer[] = [];
  for (const chunk of sideband(inner, 1)) parts.push(chunk);
  parts.push(FLUSH);
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.concat(parts) };
}

/** A tag object id for an annotated tag, or '' when the ref is not an annotated tag. */
export function tagTarget(repo: Repo, ref: string): string {
  const oid = repo.refs.get(ref);
  if (oid === undefined) return '';
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'tag') return '';
  const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
  return m ? (m[1] as string) : '';
}

export { objectId };
