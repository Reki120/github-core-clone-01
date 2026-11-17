// The forge's store: git objects, refs, repositories, issues, pull requests and labels, all in
// memory. Everything is deterministic: no wall clock, no randomness. A monotonic counter off the
// scenario epoch (2025-01-01T00:00:00Z) stamps every created_at and every commit, so two runs fed
// the same requests in the same order produce the same bytes.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
/** The scenario epoch: every timestamp derives from this plus a counter. */
export const EPOCH_SEC = 1735689600;

/** The token owner, from wire.ts's fixed scenario (viewer users[0]). */
export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export function sha1(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The id of a git object: sha1("<type> <len>\0" + data). */
export function objectId(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1(Buffer.concat([head, data]));
}

export function isOid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

export interface CommitParts {
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorEpoch: number;
  committerName: string;
  committerEmail: string;
  committerEpoch: number;
  message: string;
}

export function parseCommit(data: Buffer): CommitParts {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let authorName = '';
  let authorEmail = '';
  let authorEpoch = 0;
  let committerName = '';
  let committerEmail = '';
  let committerEpoch = 0;
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      const m = /^author (.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
      if (m) {
        authorName = m[1] ?? '';
        authorEmail = m[2] ?? '';
        authorEpoch = Number(m[3]);
      }
    } else if (line.startsWith('committer ')) {
      const m = /^committer (.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
      if (m) {
        committerName = m[1] ?? '';
        committerEmail = m[2] ?? '';
        committerEpoch = Number(m[3]);
      }
    }
  }
  return {
    tree,
    parents,
    authorName,
    authorEmail,
    authorEpoch,
    committerName,
    committerEmail,
    committerEpoch,
    message,
  };
}

export function buildCommit(parts: CommitParts): Buffer {
  const lines: string[] = [`tree ${parts.tree}`];
  for (const p of parts.parents) lines.push(`parent ${p}`);
  lines.push(`author ${parts.authorName} <${parts.authorEmail}> ${parts.authorEpoch} +0000`);
  lines.push(`committer ${parts.committerName} <${parts.committerEmail}> ${parts.committerEpoch} +0000`);
  return Buffer.from(`${lines.join('\n')}\n\n${parts.message}`, 'utf8');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp < 0) break;
    const nul = data.indexOf(0, sp);
    if (nul < 0 || nul + 21 > data.length) break;
    entries.push({
      mode: data.subarray(off, sp).toString('ascii'),
      name: data.subarray(sp + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return entries;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** A delta instruction stream applied to a base, per the git pack format. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = delta[off++] ?? 0;
      value |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    return value;
  };
  const srcSize = readVarint();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (off < delta.length) {
    const op = delta[off++] ?? 0;
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) cpOff |= (delta[off++] ?? 0) << (8 * i);
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) cpSize |= (delta[off++] ?? 0) << (8 * i);
      }
      if (cpSize === 0) cpSize = 0x10000;
      out.push(base.subarray(cpOff, cpOff + cpSize));
      produced += cpSize;
    } else if (op !== 0) {
      out.push(delta.subarray(off, off + op));
      off += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (produced !== targetSize || result.length !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

/**
 * Inflate the deflate stream starting at `offset`, whose uncompressed size is `size`. Node's
 * inflateSync ignores trailing bytes, so the stream's end is found by binary search for the
 * shortest prefix that inflates to exactly `size` bytes (a shorter prefix throws).
 */
export function inflateAt(buf: Buffer, offset: number, size: number): { data: Buffer; consumed: number } {
  let lo = 1;
  let hi = buf.length - offset;
  let answer = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      const out = inflateSync(buf.subarray(offset, offset + mid));
      if (out.length === size) {
        answer = mid;
        hi = mid - 1;
      } else if (out.length < size) {
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    } catch {
      lo = mid + 1;
    }
  }
  if (answer < 0) throw new Error('cannot inflate pack entry');
  return { data: inflateSync(buf.subarray(offset, offset + answer)), consumed: answer };
}

const PACK_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Read a pack v2/v3 file of plain objects, resolving OFS/REF deltas. Returns oid -> object. */
export function readPack(buf: Buffer): Map<string, GitObject> {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const offsets = new Map<number, string>();
  const deltas: Array<{ baseOid?: string; baseOff?: number; data: Buffer; size: number }> = [];
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const entryStart = off;
    // Object header: varint, low 4 bits of the first byte are the type, then size bits.
    let byte = buf[off++] ?? 0;
    const typeNum = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[off++] ?? 0;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeNum === 6) {
      // OFS_DELTA: negative offset varint.
      let b = buf[off++] ?? 0;
      let baseOff = b & 0x7f;
      while (b & 0x80) {
        b = buf[off++] ?? 0;
        baseOff = ((baseOff + 1) << 7) | (b & 0x7f);
      }
      const start = off;
      const { data, consumed } = inflateAt(buf, off, size);
      off = start + consumed;
      deltas.push({ baseOff: entryStart - baseOff, data, size });
    } else if (typeNum === 7) {
      const baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
      const start = off;
      const { data, consumed } = inflateAt(buf, off, size);
      off = start + consumed;
      deltas.push({ baseOid, data, size });
    } else {
      const type = PACK_TYPES[typeNum];
      if (type === undefined) throw new Error(`unknown pack object type ${typeNum}`);
      const start = off;
      const { data, consumed } = inflateAt(buf, off, size);
      off = start + consumed;
      if (data.length !== size) throw new Error('pack object size mismatch');
      const oid = objectId(type, data);
      objects.set(oid, { type, data });
      offsets.set(entryStart, oid);
    }
  }
  // Resolve deltas in pack order (a delta's base always precedes it, or is an earlier delta).
  const resolved = new Map<object, GitObject>();
  const resolveDelta = (d: { baseOid?: string; baseOff?: number; data: Buffer; size: number }): GitObject => {
    if (resolved.has(d)) return resolved.get(d) as GitObject;
    let base: GitObject | undefined;
    if (d.baseOid !== undefined) base = objects.get(d.baseOid);
    else if (d.baseOff !== undefined) {
      const oid = offsets.get(d.baseOff);
      if (oid !== undefined) base = objects.get(oid);
    }
    if (base === undefined) throw new Error('delta base not in pack');
    const data = applyDelta(base.data, d.data);
    const obj: GitObject = { type: base.type, data };
    resolved.set(d, obj);
    return obj;
  };
  for (const d of deltas) {
    const obj = resolveDelta(d);
    objects.set(objectId(obj.type, obj.data), obj);
  }
  return objects;
}

const PACK_TYPE_NUM: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Write a pack v2 of plain (undeltified) objects, sorted by oid for determinism. */
export function writePack(entries: GitObject[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const x = objectId(a.type, a.data);
    const y = objectId(b.type, b.data);
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(sorted.length, 8);
  parts.push(head);
  for (const obj of sorted) {
    const typeNum = PACK_TYPE_NUM[obj.type];
    const size = obj.data.length;
    const header: number[] = [];
    let s = size;
    let first = (typeNum << 4) | (s & 0x0f);
    s >>>= 4;
    if (s > 0) first |= 0x80;
    header.push(first);
    while (s > 0) {
      let b = s & 0x7f;
      s >>>= 7;
      if (s > 0) b |= 0x80;
      header.push(b);
    }
    parts.push(Buffer.from(header));
    parts.push(deflateSync(obj.data));
  }
  const withoutTrailer = Buffer.concat(parts);
  const trailer = createHash('sha1').update(withoutTrailer).digest();
  return Buffer.concat([withoutTrailer, trailer]);
}

// -----------------------------------------------------------------------------------------------------------
// The store
// -----------------------------------------------------------------------------------------------------------

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergeBaseSha: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Comment {
  id: number;
  issueNumber: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  seq: number;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  labels: Map<string, { name: string; color: string }>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  comments: Map<number, Comment[]>;
  numCounter: number;
  commentCounter: number;
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private repoSeq = 0;
  private createSeq = 0;
  private clockSec = EPOCH_SEC;
  private requestSeq = 0;

  nextRequestId(): string {
    this.requestSeq += 1;
    return `req-${this.requestSeq}`;
  }

  /** One deterministic second per call; returns epoch + ISO timestamp. */
  tick(): { epoch: number; iso: string } {
    this.clockSec += 1;
    return { epoch: this.clockSec, iso: new Date(this.clockSec * 1000).toISOString() };
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const id = (this.repoSeq += 1);
    const repo: Repo = {
      id,
      owner,
      name,
      fullName: `${owner}/${name}`,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      seq: (this.createSeq += 1),
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      comments: new Map(),
      numCounter: 0,
      commentCounter: 0,
    };
    this.repos.set(repo.fullName, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  listReposFor(owner: string): Repo[] {
    return [...this.repos.values()].filter((r) => r.owner === owner).sort((a, b) => a.seq - b.seq);
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(repo.fullName);
  }

  /** Store an object, returning its oid. */
  putObject(repo: Repo, type: ObjType, data: Buffer): string {
    const oid = objectId(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** Build (and store) a tree from path -> blob-oid, creating intermediate trees. */
  buildTree(repo: Repo, files: Map<string, string>): string {
    const buildDir = (prefix: string): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Set<string>();
      for (const [path, oid] of files) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash < 0) entries.push({ mode: '100644', name: rest, oid });
        else dirs.add(rest.slice(0, slash));
      }
      for (const dir of dirs) {
        entries.push({ mode: '40000', name: dir, oid: buildDir(`${prefix}${dir}/`) });
      }
      const data = buildTree(entries);
      return this.putObject(repo, 'tree', data);
    };
    return buildDir('');
  }

  /** Flatten a tree oid into path -> {oid, mode}. Empty tree oid ('') yields an empty map. */
  flattenTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'tree') return;
      for (const e of parseTree(obj.data)) {
        if (e.mode === '40000') walk(e.oid, `${prefix}${e.name}/`);
        else out.set(`${prefix}${e.name}`, { oid: e.oid, mode: e.mode });
      }
    };
    if (treeOid !== '') walk(treeOid, '');
    return out;
  }

  /** Commit a tree on top of `parents` with the viewer as author/committer; returns the commit oid. */
  makeCommit(repo: Repo, treeOid: string, parents: string[], message: string): string {
    const { epoch } = this.tick();
    const data = buildCommit({
      tree: treeOid,
      parents,
      authorName: VIEWER.name,
      authorEmail: VIEWER.email,
      authorEpoch: epoch,
      committerName: VIEWER.name,
      committerEmail: VIEWER.email,
      committerEpoch: epoch,
      message,
    });
    return this.putObject(repo, 'commit', data);
  }

  /** True when `ancestor` is reachable from `oid` (or equal), following first-parent and all parents. */
  isAncestor(repo: Repo, ancestor: string, oid: string): boolean {
    if (ancestor === oid) return true;
    const seen = new Set<string>();
    const stack = [oid];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (cur === ancestor) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const obj = repo.objects.get(cur);
      if (obj === undefined || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.data).parents) stack.push(p);
    }
    return false;
  }

  /** Resolve a ref name or oid to a commit oid, or '' when unknown. Bare branch names resolve
   * under refs/heads/, bare tags under refs/tags/. */
  resolveRef(repo: Repo, refOrOid: string): string {
    if (repo.refs.has(refOrOid)) return repo.refs.get(refOrOid) as string;
    const headRef = repo.refs.get(`refs/heads/${refOrOid}`);
    if (headRef !== undefined) return headRef;
    const tagRef = repo.refs.get(`refs/tags/${refOrOid}`);
    if (tagRef !== undefined) return tagRef;
    if (refOrOid === 'HEAD') {
      const target = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      return target ?? '';
    }
    if (isOid(refOrOid) && repo.objects.has(refOrOid)) return refOrOid;
    return '';
  }

  /** All commits reachable from `tips` (following parents), as oids. */
  reachableCommits(repo: Repo, tips: string[]): Set<string> {
    const out = new Set<string>();
    const stack = [...tips];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (cur === '' || out.has(cur)) continue;
      const obj = repo.objects.get(cur);
      if (obj === undefined) continue;
      if (obj.type === 'tag') {
        const text = obj.data.toString('utf8');
        const m = /^object ([0-9a-f]{40})$/m.exec(text);
        if (m) stack.push(m[1] as string);
        out.add(cur);
        continue;
      }
      if (obj.type !== 'commit') continue;
      out.add(cur);
      for (const p of parseCommit(obj.data).parents) stack.push(p);
    }
    return out;
  }

  /** Every object reachable from the given commit/tag tips (commits, trees, blobs, tags). */
  reachableObjects(repo: Repo, tips: string[]): Map<string, GitObject> {
    const out = new Map<string, GitObject>();
    const commits = this.reachableCommits(repo, tips);
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
        const text = obj.data.toString('utf8');
        const m = /^object ([0-9a-f]{40})$/m.exec(text);
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

  /** Diff two trees (null/'' = empty): added/modified/removed files with line counts. */
  diffTrees(
    repo: Repo,
    baseTreeOid: string,
    headTreeOid: string,
  ): Array<{ path: string; status: 'added' | 'modified' | 'removed'; oldOid: string; newOid: string; additions: number; deletions: number }> {
    const base = this.flattenTree(repo, baseTreeOid);
    const head = this.flattenTree(repo, headTreeOid);
    const lineCount = (oid: string): number => {
      const obj = repo.objects.get(oid);
      if (obj === undefined) return 0;
      const text = obj.data.toString('utf8');
      if (text === '') return 0;
      return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    };
    const out: Array<{ path: string; status: 'added' | 'modified' | 'removed'; oldOid: string; newOid: string; additions: number; deletions: number }> = [];
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b === undefined && h !== undefined) {
        out.push({ path, status: 'added', oldOid: '', newOid: h.oid, additions: lineCount(h.oid), deletions: 0 });
      } else if (b !== undefined && h === undefined) {
        out.push({ path, status: 'removed', oldOid: b.oid, newOid: '', additions: 0, deletions: lineCount(b.oid) });
      } else if (b !== undefined && h !== undefined && b.oid !== h.oid) {
        out.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid, additions: Math.max(1, lineCount(h.oid)), deletions: lineCount(b.oid) });
      }
    }
    return out;
  }

  /** Three-way merge check: does merging `headTip` into `baseTip` (merge-base `mergeBaseTip`) conflict? */
  mergeConflicts(repo: Repo, mergeBaseTip: string, baseTip: string, headTip: string): string[] {
    const baseCommit = repo.objects.get(baseTip);
    const headCommit = repo.objects.get(headTip);
    const mergeCommit = repo.objects.get(mergeBaseTip);
    const baseTree = baseCommit?.type === 'commit' ? parseCommit(baseCommit.data).tree : '';
    const headTree = headCommit?.type === 'commit' ? parseCommit(headCommit.data).tree : '';
    const mergeTree = mergeCommit?.type === 'commit' ? parseCommit(mergeCommit.data).tree : '';
    const baseFiles = this.flattenTree(repo, baseTree);
    const headFiles = this.flattenTree(repo, headTree);
    const mergeFiles = this.flattenTree(repo, mergeTree);
    const conflicts: string[] = [];
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...mergeFiles.keys()]);
    for (const path of paths) {
      const o = mergeFiles.get(path)?.oid ?? '';
      const b = baseFiles.get(path)?.oid ?? '';
      const h = headFiles.get(path)?.oid ?? '';
      if (o !== b && o !== h && b !== h) conflicts.push(path);
    }
    return conflicts;
  }

  /** The merged tree for a squash merge: head's version where head changed, base's elsewhere. */
  mergeTree(repo: Repo, mergeBaseTip: string, baseTip: string, headTip: string): string {
    const baseCommit = repo.objects.get(baseTip);
    const headCommit = repo.objects.get(headTip);
    const mergeCommit = repo.objects.get(mergeBaseTip);
    const baseTree = baseCommit?.type === 'commit' ? parseCommit(baseCommit.data).tree : '';
    const headTree = headCommit?.type === 'commit' ? parseCommit(headCommit.data).tree : '';
    const mergeTree = mergeCommit?.type === 'commit' ? parseCommit(mergeCommit.data).tree : '';
    const baseFiles = this.flattenTree(repo, baseTree);
    const headFiles = this.flattenTree(repo, headTree);
    const mergeFiles = this.flattenTree(repo, mergeTree);
    const result = new Map<string, string>();
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...mergeFiles.keys()]);
    for (const path of paths) {
      const o = mergeFiles.get(path)?.oid ?? '';
      const b = baseFiles.get(path)?.oid ?? '';
      const h = headFiles.get(path)?.oid ?? '';
      const chosen = o !== h ? h : b;
      if (chosen !== '') result.set(path, chosen);
    }
    return this.buildTree(repo, result);
  }
}
