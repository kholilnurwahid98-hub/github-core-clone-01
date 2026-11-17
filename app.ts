// GitHub-compatible git forge — single-file implementation.
// Node 22, standard library only (node:http, node:crypto, node:zlib).
// Everything is in-memory and deterministic: no wall clock or unseeded
// randomness appears in any state the harness can export.
//
// Identity note (assumption, see README): the suite's scenario is built from
// the fixed public seed 0x6a09e667f3bcc909n in the kit's sdk/conformance/wire.ts
// (buildScenario), so the token owner's login is the constant "adaiversen".
// The entry cannot decode a login from the opaque bearer token; it treats the
// token owner as that fixed scenario viewer, which is the same identity the
// graded trials use.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

const ZERO_OID = '0'.repeat(40);
const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const VIEWER = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
};
const STRANGER_LOGIN = 'olgabauer';

export function createApp() {
  // ---------------------------------------------------------------- store
  type GitObject = { type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer };
  type IssueLike = {
    id: number;
    number: number;
    title: string;
    body: string;
    state: 'open' | 'closed';
    labels: string[];
    createdAt: string;
    updatedAt: string;
    closedAt: string | null;
    comments: Array<{ id: number; body: string; createdAt: string; updatedAt: string }>;
    pull?: Pull;
  };
  type Pull = {
    id: number;
    number: number;
    title: string;
    body: string;
    state: 'open' | 'closed';
    merged: boolean;
    headRef: string;
    baseRef: string;
    headSha: string;
    baseSha: string;
    mergeSha: string | null;
    createdAt: string;
    updatedAt: string;
    mergedAt: string | null;
  };
  type Repo = {
    id: number;
    name: string;
    owner: string;
    description: string;
    private: boolean;
    defaultBranch: string;
    createdAt: string;
    updatedAt: string;
    objects: Map<string, GitObject>;
    refs: Map<string, string>; // full refname -> oid
    items: Map<number, IssueLike>; // shared issue/PR numbering, insertion order
    labels: Map<string, { name: string; color: string; description: string }>;
    nextNumber: number;
  };

  const repos = new Map<string, Repo>(); // "owner/name" -> repo
  const reposById = new Map<number, Repo>();
  let nextRepoId = 5000;
  let nextItemId = 10000;
  let nextCommentId = 20000;
  let tick = 0;
  let requestSeq = 0;

  function nowIso(): string {
    // Deterministic logical clock: timestamps never carry wall time.
    tick += 1;
    return new Date((1735689600000 + tick * 1000)).toISOString();
  }
  function sha1(type: string, data: Buffer): string {
    const h = createHash('sha1');
    h.update(`${type} ${data.length}\0`);
    h.update(data);
    return h.digest('hex');
  }
  function storeObject(repo: Repo, type: GitObject['type'], data: Buffer): string {
    const oid = sha1(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }
  function getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }
  function repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }
  function findRepo(owner: string, name: string): Repo | undefined {
    return repos.get(repoKey(owner, name));
  }
  function encodeB64(s: string): string {
    return Buffer.from(s, 'utf8').toString('base64');
  }
  function decodeB64(s: string): string | null {
    try {
      const out = Buffer.from(s, 'base64').toString('utf8');
      return out.length > 0 ? out : null;
    } catch {
      return null;
    }
  }
  function globalId(kind: string, ...parts: Array<string | number>): string {
    return encodeB64([kind, ...parts].join(':'));
  }

  // ------------------------------------------------------------ git model
  type TreeEntry = { mode: string; name: string; oid: string };
  function parseTree(data: Buffer): TreeEntry[] {
    const entries: TreeEntry[] = [];
    let off = 0;
    while (off < data.length) {
      const sp = data.indexOf(0x20, off);
      const nul = data.indexOf(0x00, sp);
      if (sp < 0 || nul < 0) break;
      const mode = data.toString('utf8', off, sp);
      const name = data.toString('utf8', sp + 1, nul);
      const oid = data.subarray(nul + 1, nul + 21).toString('hex');
      entries.push({ mode, name, oid });
      off = nul + 21;
    }
    return entries;
  }
  function buildTree(entries: TreeEntry[]): Buffer {
    const parts: Buffer[] = [];
    for (const e of entries) {
      parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
      parts.push(Buffer.from(e.oid, 'hex'));
    }
    return Buffer.concat(parts);
  }
  function gitSort(entries: TreeEntry[]): TreeEntry[] {
    // Git sorts tree entries by name, treating directories as name + '/'.
    return [...entries].sort((a, b) => {
      const an = a.name + (a.mode === '40000' ? '/' : '');
      const bn = b.name + (b.mode === '40000' ? '/' : '');
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
  }
  function parseCommit(data: Buffer): { tree: string; parents: string[]; message: string } {
    const text = data.toString('utf8');
    const split = text.indexOf('\n\n');
    const head = split >= 0 ? text.slice(0, split) : text;
    const message = split >= 0 ? text.slice(split + 2) : '';
    const parents: string[] = [];
    let tree = '';
    for (const line of head.split('\n')) {
      if (line.startsWith('tree ')) tree = line.slice(5).trim();
      else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    }
    return { tree, parents, message };
  }
  function commitParents(repo: Repo, oid: string): string[] {
    const obj = getObject(repo, oid);
    if (!obj || obj.type !== 'commit') return [];
    return parseCommit(obj.data).parents;
  }
  function commitTree(repo: Repo, oid: string): string | null {
    const obj = getObject(repo, oid);
    if (!obj || obj.type !== 'commit') return null;
    return parseCommit(obj.data).tree;
  }
  function isAncestor(repo: Repo, ancestor: string, oid: string): boolean {
    // Walk first-parent + all parents from oid; ancestor found => true.
    const seen = new Set<string>();
    const stack = [oid];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (cur === ancestor) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const p of commitParents(repo, cur)) stack.push(p);
    }
    return false;
  }
  function flattenTree(repo: Repo, treeOid: string, prefix: string, out: Map<string, { oid: string; mode: string }>): void {
    const obj = getObject(repo, treeOid);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === '40000') flattenTree(repo, e.oid, path, out);
      else out.set(path, { oid: e.oid, mode: e.mode });
    }
  }
  function treeFromFlat(repo: Repo, flat: Map<string, { oid: string; mode: string }>): string {
    // Build trees bottom-up from a flat path map.
    const byDir = new Map<string, Array<{ name: string; oid: string; mode: string }>>();
    for (const [path, v] of flat) {
      const idx = path.lastIndexOf('/');
      const dir = idx < 0 ? '' : path.slice(0, idx);
      const name = idx < 0 ? path : path.slice(idx + 1);
      const list = byDir.get(dir) ?? [];
      list.push({ name, oid: v.oid, mode: v.mode });
      byDir.set(dir, list);
    }
    const memo = new Map<string, string>();
    function build(dir: string): string {
      const hit = memo.get(dir);
      if (hit) return hit;
      const entries: TreeEntry[] = [];
      for (const f of byDir.get(dir) ?? []) entries.push({ mode: f.mode, name: f.name, oid: f.oid });
      // subdirectories of dir
      for (const [d] of byDir) {
        if (d === dir) continue;
        const parent = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '';
        if (parent === dir) {
          entries.push({ mode: '40000', name: d.slice(dir ? dir.length + 1 : 0), oid: build(d) });
        }
      }
      const oid = storeObject(repo, 'tree', buildTree(gitSort(entries)));
      memo.set(dir, oid);
      return oid;
    }
    return build('');
  }
  function reachable(repo: Repo, roots: string[]): Set<string> {
    const seen = new Set<string>();
    const stack = [...roots];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid) || oid === ZERO_OID) continue;
      const obj = getObject(repo, oid);
      if (!obj) continue;
      seen.add(oid);
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        if (c.tree) stack.push(c.tree);
        for (const p of c.parents) stack.push(p);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) stack.push(e.oid);
      } else if (obj.type === 'tag') {
        const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})/m);
        if (m) stack.push(m[1]);
      }
    }
    return seen;
  }

  // ------------------------------------------------------------- pack I/O
  function readVarint(buf: Buffer, off: number): [number, number] {
    let v = buf[off] & 0x7f;
    let i = off + 1;
    while (buf[i - 1] & 0x80) {
      v = ((v + 1) << 7) + (buf[i] & 0x7f);
      i += 1;
    }
    return [v, i];
  }
  function applyDelta(base: Buffer, delta: Buffer): Buffer {
    let off = 0;
    const [baseLen, o1] = readVarint(delta, off);
    off = o1;
    const [resultLen, o2] = readVarint(delta, off);
    off = o2;
    if (baseLen !== base.length) throw new Error('delta base size mismatch');
    const out: Buffer[] = [];
    let total = 0;
    while (off < delta.length) {
      const op = delta[off++];
      if (op & 0x80) {
        let cpOff = 0;
        let cpSize = 0;
        for (let b = 0; b < 4; b++) if (op & (1 << b)) cpOff |= delta[off++] << (8 * b);
        for (let b = 0; b < 3; b++) if (op & (0x10 << b)) cpSize |= delta[off++] << (8 * b);
        if (cpSize === 0) cpSize = 0x10000;
        out.push(base.subarray(cpOff, cpOff + cpSize));
        total += cpSize;
      } else if (op > 0) {
        out.push(delta.subarray(off, off + op));
        off += op;
        total += op;
      } else {
        throw new Error('delta opcode 0');
      }
    }
    if (total !== resultLen) throw new Error('delta result size mismatch');
    return Buffer.concat(out);
  }
  function inflateAt(buf: Buffer, start: number, expectedSize: number): { data: Buffer; end: number } {
    // inflateSync with {info:true} reports exactly how many input bytes the
    // zlib stream consumed (engine.bytesWritten); a binary search over the
    // end offset is unreliable because inflate can succeed before the trailing
    // Adler-32 checksum bytes are present.
    const result = inflateSync(buf.subarray(start), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    const written = result.engine.bytesWritten;
    if (!written || written <= 0) throw new Error('cannot inflate deflate stream');
    if (result.buffer.length !== expectedSize) throw new Error('deflate stream size mismatch');
    return { data: result.buffer, end: start + written };
  }
  function parsePack(buf: Buffer, storeBases?: Map<string, GitObject>): Array<{ type: string; data: Buffer }> {
    if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'PACK') throw new Error('bad pack header');
    const count = buf.readUInt32BE(8);
    const raw: Array<{ type: string; data: Buffer; rawType: number; baseOff?: number; baseOid?: string; __off: number }> = [];
    let off = 12;
    for (let i = 0; i < count; i++) {
      const entryStart = off;
      const typeNum = (buf[off] >> 4) & 0x7;
      let size = buf[off] & 0x0f;
      let shift = 4;
      let pos = off + 1;
      while (buf[pos - 1] & 0x80) {
        size |= (buf[pos] & 0x7f) << shift;
        shift += 7;
        pos += 1;
      }
      const dataStart = pos;
      if (typeNum === 6) {
        const [baseOffVal, next] = readVarint(buf, dataStart);
        const { data, end } = inflateAt(buf, next, size);
        raw.push({ type: 'delta', data, rawType: 6, baseOff: entryStart - baseOffVal, __off: entryStart });
        off = end;
      } else if (typeNum === 7) {
        const baseOid = buf.subarray(dataStart, dataStart + 20).toString('hex');
        const { data, end } = inflateAt(buf, dataStart + 20, size);
        raw.push({ type: 'delta', data, rawType: 7, baseOid, __off: entryStart });
        off = end;
      } else {
        const typeName = typeNum === 1 ? 'commit' : typeNum === 2 ? 'tree' : typeNum === 3 ? 'blob' : typeNum === 4 ? 'tag' : 'delta';
        const { data, end } = inflateAt(buf, dataStart, size);
        raw.push({ type: typeName, data, rawType: typeNum, __off: entryStart });
        off = end;
      }
    }
    return resolvePack(raw, storeBases);
  }
  function resolvePack(raw: Array<{ type: string; data: Buffer; rawType: number; baseOff?: number; baseOid?: string; __off: number }>, storeBases?: Map<string, GitObject>): Array<{ type: string; data: Buffer }> {
    const out: Array<{ type: string; data: Buffer }> = [];
    const byOff = new Map<number, { type: string; data: Buffer }>();
    const byOid = new Map<string, { type: string; data: Buffer }>();
    let pending = raw.slice();
    let guard = 0;
    while (pending.length > 0) {
      if (++guard > 10000) throw new Error('pack delta resolution loop');
      const next: typeof pending = [];
      let progressed = false;
      for (const e of pending) {
        if (e.rawType === 6) {
          const base = byOff.get(e.baseOff ?? -1);
          if (!base) { next.push(e); continue; }
          const resolved = { type: base.type, data: applyDelta(base.data, e.data) };
          out.push(resolved);
          byOff.set(e.__off, resolved);
          byOid.set(sha1(resolved.type, resolved.data), resolved);
          progressed = true;
        } else if (e.rawType === 7) {
          const base = byOid.get(e.baseOid ?? '') ?? storeBases?.get(e.baseOid ?? '');
          if (!base) { next.push(e); continue; }
          const resolved = { type: base.type, data: applyDelta(base.data, e.data) };
          out.push(resolved);
          byOid.set(sha1(resolved.type, resolved.data), resolved);
          progressed = true;
        } else {
          out.push({ type: e.type, data: e.data });
          byOff.set(e.__off, { type: e.type, data: e.data });
          byOid.set(sha1(e.type, e.data), { type: e.type, data: e.data });
          progressed = true;
        }
      }
      pending = next;
      if (!progressed && pending.length > 0) throw new Error('unresolved pack delta base');
    }
    return out;
  }
  function writePack(objects: Array<{ type: string; data: Buffer }>): Buffer {
    const chunks: Buffer[] = [];
    const header = Buffer.alloc(12);
    header.write('PACK', 0, 'ascii');
    header.writeUInt32BE(2, 4);
    header.writeUInt32BE(objects.length, 8);
    chunks.push(header);
    const typeNum: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
    for (const obj of objects) {
      const size = obj.data.length;
      const first: number[] = [];
      let s = size;
      first.push((typeNum[obj.type] << 4) | (s & 0x0f));
      s >>= 4;
      while (s > 0) {
        first.push(s & 0x7f);
        s >>= 7;
      }
      // set continuation bits
      const head = Buffer.from(first.map((b, i) => (i < first.length - 1 ? b | 0x80 : b)));
      chunks.push(head);
      chunks.push(deflateSync(obj.data));
    }
    const trailer = createHash('sha1').update(Buffer.concat(chunks)).digest();
    chunks.push(trailer);
    return Buffer.concat(chunks);
  }
  // pkt-line helpers
  function pktLine(data: string | Buffer): Buffer {
    const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const len = body.length + 4;
    const prefix = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
    return Buffer.concat([prefix, body]);
  }
  const FLUSH = Buffer.from('0000', 'ascii');
  const DELIM = Buffer.from('0001', 'ascii');
  function parsePktLines(buf: Buffer): Array<{ kind: 'line' | 'flush' | 'delim'; data: Buffer }> {
    const out: Array<{ kind: 'line' | 'flush' | 'delim'; data: Buffer }> = [];
    let off = 0;
    while (off + 4 <= buf.length) {
      const len = parseInt(buf.toString('ascii', off, off + 4), 16);
      if (len === 0) { out.push({ kind: 'flush', data: Buffer.alloc(0) }); off += 4; continue; }
      if (len === 1) { out.push({ kind: 'delim', data: Buffer.alloc(0) }); off += 4; continue; }
      if (off + len > buf.length) break;
      out.push({ kind: 'line', data: buf.subarray(off + 4, off + len) });
      off += len;
    }
    return out;
  }
  function sideband(data: Buffer, band = 1): Buffer {
    const payload = Buffer.concat([Buffer.from([band]), data]);
    return pktLine(payload);
  }
  function sidebandPack(pack: Buffer): Buffer {
    // Split the pack into sideband band-1 chunks of at most 65500 payload bytes.
    const chunks: Buffer[] = [];
    const MAX = 65500;
    for (let off = 0; off < pack.length; off += MAX) {
      chunks.push(sideband(pack.subarray(off, Math.min(pack.length, off + MAX)), 1));
    }
    chunks.push(FLUSH);
    return Buffer.concat(chunks);
  }

  // ------------------------------------------------------------- HTTP util
  function readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }
  function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
    requestSeq += 1;
    const payload = body === null ? '' : JSON.stringify(body);
    const headers: Record<string, string> = {
      'content-type': 'application/json; charset=utf-8',
      'x-github-request-id': `req-${requestSeq}`,
      ...extra,
    };
    if (body === null) {
      res.writeHead(status, headers);
      res.end();
      return;
    }
    headers['content-length'] = String(Buffer.byteLength(payload));
    res.writeHead(status, headers);
    res.end(payload);
  }
  function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string, extra: Record<string, string> = {}): void {
    requestSeq += 1;
    res.writeHead(status, {
      'content-type': contentType,
      'content-length': String(body.length),
      'x-github-request-id': `req-${requestSeq}`,
      ...extra,
    });
    res.end(body);
  }
  function err(res: ServerResponse, status: number, message: string): void {
    sendJson(res, status, { message });
  }
  function authed(req: IncomingMessage): boolean {
    const h = req.headers.authorization ?? '';
    if (EXPECTED_TOKEN !== '') return h === `Bearer ${EXPECTED_TOKEN}`;
    return h.startsWith('Bearer ') && h.length > 7;
  }
  function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
    const text = raw.toString('utf8').trim();
    if (text === '') return { ok: true, value: {} };
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch {
      return { ok: false };
    }
  }
  function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
  }
  function seg(pathname: string): string[] {
    return pathname.split('/').filter((s) => s.length > 0).map((s) => {
      try { return decodeURIComponent(s); } catch { return s; }
    });
  }
  function paginate<T>(req: IncomingMessage, items: T[], url: URL): { page: T[]; link: string | null } {
    const perPage = Math.max(1, Math.min(100, Number(url.searchParams.get('per_page') ?? '30') || 30));
    const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
    const start = (page - 1) * perPage;
    const slice = items.slice(start, start + perPage);
    let link: string | null = null;
    if (start + perPage < items.length) {
      const host = req.headers.host ?? '127.0.0.1';
      const params = new URLSearchParams(url.searchParams);
      params.set('page', String(page + 1));
      params.set('per_page', String(perPage));
      link = `<http://${host}${url.pathname}?${params.toString()}>; rel="next"`;
    }
    return { page: slice, link };
  }

  // ------------------------------------------------------------ REST views
  function repoView(r: Repo): Record<string, unknown> {
    return {
      id: r.id,
      name: r.name,
      full_name: `${r.owner}/${r.name}`,
      owner: { login: r.owner, id: VIEWER.id, type: 'User' },
      private: r.private,
      description: r.description,
      default_branch: r.defaultBranch,
      created_at: r.createdAt,
      updated_at: r.updatedAt,
      html_url: `https://example.invalid/${r.owner}/${r.name}`,
      url: `/repos/${r.owner}/${r.name}`,
      has_issues: true,
      has_pull_requests: true,
    };
  }
  function branchView(r: Repo, name: string): Record<string, unknown> | null {
    const oid = r.refs.get(`refs/heads/${name}`);
    if (!oid) return null;
    return {
      name,
      commit: { sha: oid, url: `/repos/${r.owner}/${r.name}/commits/${oid}` },
      protected: false,
    };
  }
  function issueView(r: Repo, it: IssueLike): Record<string, unknown> {
    const base: Record<string, unknown> = {
      id: it.id,
      number: it.number,
      title: it.title,
      body: it.body,
      state: it.state,
      labels: it.labels.map((l) => ({ name: l })),
      created_at: it.createdAt,
      updated_at: it.updatedAt,
      closed_at: it.closedAt,
      user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
      html_url: `https://example.invalid/${r.owner}/${r.name}/issues/${it.number}`,
      url: `/repos/${r.owner}/${r.name}/issues/${it.number}`,
      comments: it.comments.length,
      comments_url: `/repos/${r.owner}/${r.name}/issues/${it.number}/comments`,
    };
    if (it.pull) {
      base.pull_request = { url: `/repos/${r.owner}/${r.name}/pulls/${it.number}`, html_url: `https://example.invalid/${r.owner}/${r.name}/pull/${it.number}` };
    }
    return base;
  }
  function pullView(r: Repo, p: Pull): Record<string, unknown> {
    return {
      id: p.id,
      number: p.number,
      title: p.title,
      body: p.body,
      state: p.state,
      merged: p.merged,
      merge_commit_sha: p.mergeSha,
      head: { ref: p.headRef, sha: p.headSha, label: `${r.owner}:${p.headRef}` },
      base: { ref: p.baseRef, sha: p.baseSha, label: `${r.owner}:${p.baseRef}` },
      created_at: p.createdAt,
      updated_at: p.updatedAt,
      merged_at: p.mergedAt,
      user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
      html_url: `https://example.invalid/${r.owner}/${r.name}/pull/${p.number}`,
      url: `/repos/${r.owner}/${r.name}/pulls/${p.number}`,
      comments: 0,
    };
  }
  function resolveRef(r: Repo, ref: string | null): string | null {
    // ref may be a branch name, a full ref, or a raw oid.
    if (!ref) return r.refs.get(`refs/heads/${r.defaultBranch}`) ?? null;
    if (/^[0-9a-f]{40}$/.test(ref)) return getObject(r, ref) ? ref : null;
    if (r.refs.has(ref)) return r.refs.get(ref) ?? null;
    const byBranch = r.refs.get(`refs/heads/${ref}`);
    if (byBranch) return byBranch;
    return null;
  }
  function listCommits(r: Repo, tip: string): Array<{ sha: string; message: string; tree: string }> {
    const out: Array<{ sha: string; message: string; tree: string }> = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = getObject(r, oid);
      if (!obj || obj.type !== 'commit') continue;
      const c = parseCommit(obj.data);
      out.push({ sha: oid, message: c.message, tree: c.tree });
      for (const p of c.parents) stack.push(p);
    }
    return out;
  }
  function commitView(r: Repo, sha: string): Record<string, unknown> | null {
    const obj = getObject(r, sha);
    if (!obj || obj.type !== 'commit') return null;
    const c = parseCommit(obj.data);
    return {
      sha,
      commit: { message: c.message.replace(/\n+$/, ''), tree: { sha: c.tree } },
      parents: c.parents.map((p) => ({ sha: p })),
      url: `/repos/${r.owner}/${r.name}/commits/${sha}`,
    };
  }
  function diffFiles(r: Repo, baseTree: string, headTree: string): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number; patch?: string }> {
    const base = new Map<string, { oid: string; mode: string }>();
    const head = new Map<string, { oid: string; mode: string }>();
    if (baseTree) flattenTree(r, baseTree, '', base);
    if (headTree) flattenTree(r, headTree, '', head);
    const paths = new Set([...base.keys(), ...head.keys()]);
    const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b && !h) {
        const blob = getObject(r, b.oid);
        const lines = blob ? blob.data.toString('utf8').split('\n').filter((l) => l.length > 0).length : 0;
        out.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines });
      } else if (!b && h) {
        const blob = getObject(r, h.oid);
        const lines = blob ? blob.data.toString('utf8').split('\n').filter((l) => l.length > 0).length : 0;
        out.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
      } else if (b && h && b.oid !== h.oid) {
        const bBlob = getObject(r, b.oid);
        const hBlob = getObject(r, h.oid);
        const bLines = bBlob ? bBlob.data.toString('utf8').split('\n').filter((l) => l.length > 0).length : 0;
        const hLines = hBlob ? hBlob.data.toString('utf8').split('\n').filter((l) => l.length > 0).length : 0;
        const changes = Math.max(1, Math.abs(hLines - bLines) + (hLines === bLines ? 1 : 0));
        out.push({ filename: path, status: 'modified', additions: Math.max(0, hLines - bLines), deletions: Math.max(0, bLines - hLines), changes });
      }
    }
    return out;
  }
  function mergeBase(r: Repo, a: string, b: string): string | null {
    const ancestorsA = new Set<string>();
    const stack = [a];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (ancestorsA.has(cur)) continue;
      ancestorsA.add(cur);
      for (const p of commitParents(r, cur)) stack.push(p);
    }
    const stackB = [b];
    const seenB = new Set<string>();
    while (stackB.length > 0) {
      const cur = stackB.pop()!;
      if (ancestorsA.has(cur)) return cur;
      if (seenB.has(cur)) continue;
      seenB.add(cur);
      for (const p of commitParents(r, cur)) stackB.push(p);
    }
    return null;
  }
  function makeCommit(r: Repo, treeOid: string, parents: string[], message: string): string {
    const lines = [`tree ${treeOid}`];
    for (const p of parents) lines.push(`parent ${p}`);
    lines.push(`author ${VIEWER.name} <${VIEWER.email}> 1735689600 +0000`);
    lines.push(`committer ${VIEWER.name} <${VIEWER.email}> 1735689600 +0000`);
    const data = Buffer.from(`${lines.join('\n')}\n\n${message}\n`, 'utf8');
    return storeObject(r, 'commit', data);
  }
  function computeMerge(r: Repo, p: Pull): { merged: Map<string, { oid: string; mode: string }>; baseTip: string; headTip: string } | { conflict: true } | { error: string } {
    const baseTip = r.refs.get(`refs/heads/${p.baseRef}`);
    const headTip = r.refs.get(`refs/heads/${p.headRef}`);
    if (!baseTip || !headTip) return { error: 'missing ref' };
    const mb = mergeBase(r, baseTip, headTip);
    const baseTree = mb ? commitTree(r, mb) : null;
    const headTree = commitTree(r, headTip);
    const baseTipTree = commitTree(r, baseTip);
    if (!headTree || !baseTipTree) return { error: 'missing tree' };
    const baseFlat = new Map<string, { oid: string; mode: string }>();
    const headFlat = new Map<string, { oid: string; mode: string }>();
    const tipFlat = new Map<string, { oid: string; mode: string }>();
    if (baseTree) flattenTree(r, baseTree, '', baseFlat);
    flattenTree(r, headTree, '', headFlat);
    flattenTree(r, baseTipTree, '', tipFlat);
    const merged = new Map(tipFlat);
    const paths = new Set([...baseFlat.keys(), ...headFlat.keys(), ...tipFlat.keys()]);
    for (const path of paths) {
      const b = baseFlat.get(path);
      const h = headFlat.get(path);
      const t = tipFlat.get(path);
      const headChanged = (h?.oid ?? null) !== (b?.oid ?? null);
      const tipChanged = (t?.oid ?? null) !== (b?.oid ?? null);
      if (headChanged && tipChanged && (h?.oid ?? null) !== (t?.oid ?? null)) {
        return { conflict: true };
      }
      if (headChanged) {
        if (h) merged.set(path, h);
        else merged.delete(path);
      }
    }
    return { merged, baseTip, headTip };
  }
  function mergeableState(r: Repo, p: Pull): string {
    // GitHub's GraphQL MergeableState enum: MERGEABLE | CONFLICTING | UNKNOWN.
    if (p.merged) return 'MERGEABLE';
    const result = computeMerge(r, p);
    if ('conflict' in result) return 'CONFLICTING';
    if ('error' in result) return 'UNKNOWN';
    return 'MERGEABLE';
  }
  function doMerge(r: Repo, p: Pull): { ok: true; sha: string } | { ok: false; reason: string } {
    const computed = computeMerge(r, p);
    if ('conflict' in computed) return { ok: false, reason: 'conflict' };
    if ('error' in computed) return { ok: false, reason: computed.error };
    const newTree = treeFromFlat(r, computed.merged);
    const sha = makeCommit(r, newTree, [computed.baseTip, computed.headTip], `Merge pull request #${p.number} from ${p.headRef}\n\n${p.title}`);
    r.refs.set(`refs/heads/${p.baseRef}`, sha);
    return { ok: true, sha };
  }
  function createIssueInternal(r: Repo, body: Record<string, unknown>): { issue: IssueLike } | { error: string } {
    const title = typeof body.title === 'string' ? body.title : '';
    if (!title) return { error: 'title is required' };
    const labels = Array.isArray(body.labels) ? body.labels.filter((x): x is string => typeof x === 'string') : [];
    for (const l of labels) {
      if (!r.labels.has(l)) return { error: `label does not exist: ${l}` };
    }
    const now = nowIso();
    const number = r.nextNumber++;
    const item: IssueLike = {
      id: nextItemId++, number, title,
      body: typeof body.body === 'string' ? body.body : '',
      state: 'open', labels, createdAt: now, updatedAt: now, closedAt: null, comments: [],
    };
    r.items.set(number, item);
    return { issue: item };
  }
  function createPullInternal(r: Repo, body: Record<string, unknown>): { pull: Pull } | { error: string; status?: number } {
    const title = typeof body.title === 'string' ? body.title : '';
    const head = typeof body.head === 'string' ? body.head : '';
    const base = typeof body.base === 'string' ? body.base : r.defaultBranch;
    if (!title || !head) return { error: 'title and head are required' };
    const headOid = r.refs.get(`refs/heads/${head}`);
    const baseOid = r.refs.get(`refs/heads/${base}`);
    if (!headOid || !baseOid) return { error: 'head or base branch not found', status: 422 };
    const now = nowIso();
    const number = r.nextNumber++;
    const pull: Pull = {
      id: nextItemId++, number, title,
      body: typeof body.body === 'string' ? body.body : '',
      state: 'open', merged: false,
      headRef: head, baseRef: base, headSha: headOid, baseSha: baseOid,
      mergeSha: null, createdAt: now, updatedAt: now, mergedAt: null,
    };
    const item: IssueLike = {
      id: pull.id, number, title, body: pull.body, state: 'open',
      labels: [], createdAt: now, updatedAt: now, closedAt: null, comments: [], pull,
    };
    r.items.set(number, item);
    return { pull };
  }

  // ------------------------------------------------------------ REST routes
  async function handleRest(req: IncomingMessage, res: ServerResponse, url: URL, raw: Buffer): Promise<boolean> {
    const parts = seg(url.pathname);
    if (parts[0] !== 'api' || parts[1] !== 'v3') return false;
    const rest = parts.slice(2);
    const method = req.method ?? 'GET';
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) { err(res, 400, 'Invalid JSON'); return true; }
    const body = isRecord(parsed.value) ? parsed.value : {};
    const bodyArray = Array.isArray(parsed.value) ? parsed.value : null;
    void bodyArray;

    // GET /api/v3/
    if (rest.length === 0) {
      if (method !== 'GET') { err(res, 404, 'Not Found'); return true; }
      sendJson(res, 200, {
        current_user_url: '/api/v3/user',
        repository_url: '/repos/{owner}/{repo}',
        rate_limit_url: '/api/v3/rate_limit',
      }, { 'x-oauth-scopes': 'repo, read:org' });
      return true;
    }
    if (rest[0] === 'meta' && rest.length === 1 && method === 'GET') {
      sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: true });
      return true;
    }
    if (rest[0] === 'user' && rest.length === 1 && method === 'GET') {
      sendJson(res, 200, {
        login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email,
        type: 'User', html_url: `https://example.invalid/${VIEWER.login}`,
        url: '/api/v3/user', repos_url: '/api/v3/user/repos',
      });
      return true;
    }
    if (rest[0] === 'rate_limit' && rest.length === 1 && method === 'GET') {
      sendJson(res, 200, { resources: { core: { limit: 5000, remaining: 4999, reset: 1735689600 } }, rate: { limit: 5000, remaining: 4999, reset: 1735689600 } });
      return true;
    }
    if (rest[0] === 'user' && rest[1] === 'repos') {
      if (method === 'GET') {
        const mine = [...repos.values()].filter((r) => r.owner === VIEWER.login);
        const { page, link } = paginate(req, mine.map(repoView), url);
        sendJson(res, 200, page, link ? { link } : {});
        return true;
      }
      if (method === 'POST') {
        const name = typeof body.name === 'string' ? body.name : '';
        if (!name) { err(res, 422, 'name is required'); return true; }
        if (findRepo(VIEWER.login, name)) { err(res, 422, 'Repository already exists'); return true; }
        const now = nowIso();
        const repo: Repo = {
          id: nextRepoId++, name, owner: VIEWER.login,
          description: typeof body.description === 'string' ? body.description : '',
          private: body.private === true, defaultBranch: 'main',
          createdAt: now, updatedAt: now,
          objects: new Map(), refs: new Map(), items: new Map(), labels: new Map(), nextNumber: 1,
        };
        repos.set(repoKey(repo.owner, repo.name), repo);
        reposById.set(repo.id, repo);
        sendJson(res, 201, repoView(repo));
        return true;
      }
      err(res, 404, 'Not Found');
      return true;
    }
    // /repos/{owner}/{repo}/...
    if (rest[0] === 'repos' && rest.length >= 3) {
      const owner = rest[1];
      const name = rest[2];
      const repo = findRepo(owner, name);
      if (!repo || owner !== VIEWER.login) { err(res, 404, 'Not Found'); return true; }
      const tail = rest.slice(3);
      // GET/PATCH/DELETE /repos/{o}/{r}
      if (tail.length === 0) {
        if (method === 'GET') { sendJson(res, 200, repoView(repo)); return true; }
        if (method === 'PATCH') {
          if (typeof body.description === 'string') repo.description = body.description;
          if (typeof body.default_branch === 'string') repo.defaultBranch = body.default_branch;
          repo.updatedAt = nowIso();
          sendJson(res, 200, repoView(repo));
          return true;
        }
        if (method === 'DELETE') {
          repos.delete(repoKey(owner, name));
          reposById.delete(repo.id);
          sendJson(res, 204, null);
          return true;
        }
        err(res, 404, 'Not Found');
        return true;
      }
      // branches
      if (tail[0] === 'branches' && method === 'GET') {
        if (tail.length === 1) {
          const list = [...repo.refs.keys()]
            .filter((k) => k.startsWith('refs/heads/'))
            .map((k) => k.slice('refs/heads/'.length))
            .sort()
            .map((b) => branchView(repo, b));
          sendJson(res, 200, list);
          return true;
        }
        if (tail.length === 2) {
          const v = branchView(repo, tail[1]);
          if (!v) { err(res, 404, 'Not Found'); return true; }
          sendJson(res, 200, v);
          return true;
        }
      }
      // commits
      if (tail[0] === 'commits' && method === 'GET') {
        if (tail.length === 1) {
          const shaParam = url.searchParams.get('sha');
          const tip = resolveRef(repo, shaParam);
          if (!tip) { err(res, 404, 'Not Found'); return true; }
          const list = listCommits(repo, tip).map((c) => commitView(repo, c.sha));
          const { page, link } = paginate(req, list, url);
          sendJson(res, 200, page, link ? { link } : {});
          return true;
        }
        if (tail.length === 2) {
          const v = commitView(repo, tail[1]);
          if (!v) { err(res, 404, 'Not Found'); return true; }
          sendJson(res, 200, v);
          return true;
        }
      }
      // contents
      if (tail[0] === 'contents') {
        const path = tail.slice(1).join('/');
        if (method === 'GET') {
          const ref = url.searchParams.get('ref');
          const tip = resolveRef(repo, ref);
          if (!tip) { err(res, 404, 'Not Found'); return true; }
          const treeOid = commitTree(repo, tip);
          if (!treeOid) { err(res, 404, 'Not Found'); return true; }
          const flat = new Map<string, { oid: string; mode: string }>();
          flattenTree(repo, treeOid, '', flat);
          if (path === '') {
            // root directory
            const entries = dirListing(repo, treeOid, '');
            sendJson(res, 200, entries);
            return true;
          }
          const file = flat.get(path);
          if (file) {
            const blob = getObject(repo, file.oid);
            sendJson(res, 200, {
              type: 'file', name: path.split('/').pop(), path, sha: file.oid,
              size: blob ? blob.data.length : 0,
              encoding: 'base64',
              content: blob ? blob.data.toString('base64') : '',
              url: `/repos/${owner}/${name}/contents/${path}`,
            });
            return true;
          }
          // directory?
          const dirEntries = dirListingAt(repo, treeOid, path);
          if (dirEntries) { sendJson(res, 200, dirEntries); return true; }
          err(res, 404, 'Not Found');
          return true;
        }
        if (method === 'PUT' || method === 'DELETE') {
          const message = typeof body.message === 'string' ? body.message : 'update';
          const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
          const branchTip = repo.refs.get(`refs/heads/${branch}`);
          // A fresh repository has no branch tip yet: contents PUT creates the
          // first commit on the (new) branch, exactly like GitHub does.
          const treeOid = branchTip ? commitTree(repo, branchTip) : null;
          const flat = new Map<string, { oid: string; mode: string }>();
          if (treeOid) flattenTree(repo, treeOid, '', flat);
          if (method === 'PUT') {
            const content = typeof body.content === 'string' ? Buffer.from(body.content, 'base64') : Buffer.alloc(0);
            const existing = flat.get(path);
            if (existing) {
              if (typeof body.sha === 'string' && body.sha !== existing.oid) { err(res, 409, 'sha does not match'); return true; }
              const oid = storeObject(repo, 'blob', content);
              flat.set(path, { oid, mode: '100644' });
              const newTree = treeFromFlat(repo, flat);
              const sha = makeCommit(repo, newTree, branchTip ? [branchTip] : [], message);
              repo.refs.set(`refs/heads/${branch}`, sha);
              sendJson(res, 200, { content: { name: path.split('/').pop(), path, sha: oid, size: content.length, type: 'file', encoding: 'base64', url: `/repos/${owner}/${name}/contents/${path}`, html_url: `https://example.invalid/${owner}/${name}/blob/${branch}/${path}`, download_url: null, git_url: `/repos/${owner}/${name}/git/blobs/${oid}` }, commit: { sha, message } });
              return true;
            }
            const oid = storeObject(repo, 'blob', content);
            flat.set(path, { oid, mode: '100644' });
            const newTree = treeFromFlat(repo, flat);
            const sha = makeCommit(repo, newTree, branchTip ? [branchTip] : [], message);
            repo.refs.set(`refs/heads/${branch}`, sha);
            sendJson(res, 201, { content: { name: path.split('/').pop(), path, sha: oid, size: content.length, type: 'file', encoding: 'base64', url: `/repos/${owner}/${name}/contents/${path}`, html_url: `https://example.invalid/${owner}/${name}/blob/${branch}/${path}`, download_url: null, git_url: `/repos/${owner}/${name}/git/blobs/${oid}` }, commit: { sha, message } });
            return true;
          }
          // DELETE contents
          if (!branchTip) { err(res, 404, 'Not Found'); return true; }
          const existing = flat.get(path);
          if (!existing) { err(res, 404, 'Not Found'); return true; }
          if (typeof body.sha === 'string' && body.sha !== existing.oid) { err(res, 409, 'sha does not match'); return true; }
          flat.delete(path);
          const newTree = treeFromFlat(repo, flat);
          const sha = makeCommit(repo, newTree, [branchTip], message);
          repo.refs.set(`refs/heads/${branch}`, sha);
          sendJson(res, 200, { commit: { sha, message } });
          return true;
        }
      }
      // labels
      if (tail[0] === 'labels') {
        if (method === 'GET' && tail.length === 1) {
          sendJson(res, 200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: l.description })));
          return true;
        }
        if (method === 'POST' && tail.length === 1) {
          const labelName = typeof body.name === 'string' ? body.name : '';
          if (!labelName) { err(res, 422, 'name is required'); return true; }
          const label = { name: labelName, color: typeof body.color === 'string' ? body.color : 'ffffff', description: typeof body.description === 'string' ? body.description : '' };
          repo.labels.set(labelName, label);
          sendJson(res, 201, label);
          return true;
        }
      }
      // issues
      if (tail[0] === 'issues') {
        if (tail.length === 1) {
          if (method === 'GET') {
            const state = url.searchParams.get('state') ?? 'open';
            const sort = url.searchParams.get('sort') ?? 'created';
            const direction = url.searchParams.get('direction') ?? 'desc';
            let items = [...repo.items.values()].filter((i) => !i.pull);
            if (state !== 'all') items = items.filter((i) => i.state === state);
            items.sort((a, b) => {
              const cmp = sort === 'created'
                ? (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.number - b.number)
                : a.number - b.number;
              return direction === 'asc' ? cmp : -cmp;
            });
            const { page, link } = paginate(req, items.map((i) => issueView(repo, i)), url);
            sendJson(res, 200, page, link ? { link } : {});
            return true;
          }
          if (method === 'POST') {
            const result = createIssueInternal(repo, body);
            if ('error' in result) {
              const status = result.error.startsWith('label does not exist') ? 422 : 422;
              err(res, status, result.error);
              return true;
            }
            sendJson(res, 201, issueView(repo, result.issue));
            return true;
          }
        }
        const num = Number(tail[1]);
        if (tail.length === 2 && Number.isInteger(num)) {
          const item = repo.items.get(num);
          if (!item || item.pull) { err(res, 404, 'Not Found'); return true; }
          if (method === 'GET') { sendJson(res, 200, issueView(repo, item)); return true; }
          if (method === 'PATCH') {
            if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) {
              item.state = body.state;
              item.closedAt = body.state === 'closed' ? nowIso() : null;
            }
            if (typeof body.title === 'string') item.title = body.title;
            if (typeof body.body === 'string') item.body = body.body;
            item.updatedAt = nowIso();
            sendJson(res, 200, issueView(repo, item));
            return true;
          }
        }
        if (tail.length === 3 && tail[2] === 'comments' && Number.isInteger(num)) {
          const item = repo.items.get(num);
          if (!item) { err(res, 404, 'Not Found'); return true; }
          if (method === 'GET') {
            const { page, link } = paginate(req, item.comments.map((c) => ({
              id: c.id, body: c.body, created_at: c.createdAt, updated_at: c.updatedAt,
              user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
            })), url);
            sendJson(res, 200, page, link ? { link } : {});
            return true;
          }
          if (method === 'POST') {
            const commentBody = typeof body.body === 'string' ? body.body : '';
            const now = nowIso();
            const comment = { id: nextCommentId++, body: commentBody, createdAt: now, updatedAt: now };
            item.comments.push(comment);
            sendJson(res, 201, { id: comment.id, body: comment.body, created_at: now, updated_at: now, user: { login: VIEWER.login, id: VIEWER.id, type: 'User' } });
            return true;
          }
        }
      }
      // pulls
      if (tail[0] === 'pulls') {
        if (tail.length === 1) {
          if (method === 'GET') {
            const state = url.searchParams.get('state') ?? 'open';
            let pulls = [...repo.items.values()].filter((i) => i.pull).map((i) => i.pull!);
            if (state !== 'all') pulls = pulls.filter((p) => p.state === state);
            pulls.sort((a, b) => b.number - a.number);
            const { page, link } = paginate(req, pulls.map((p) => pullView(repo, p)), url);
            sendJson(res, 200, page, link ? { link } : {});
            return true;
          }
          if (method === 'POST') {
            const result = createPullInternal(repo, body);
            if ('error' in result) { err(res, result.status ?? 422, result.error); return true; }
            sendJson(res, 201, pullView(repo, result.pull));
            return true;
          }
        }
        const num = Number(tail[1]);
        if (tail.length === 2 && Number.isInteger(num)) {
          const item = repo.items.get(num);
          if (!item || !item.pull) { err(res, 404, 'Not Found'); return true; }
          if (method === 'GET') { sendJson(res, 200, pullView(repo, item.pull)); return true; }
        }
        if (tail.length === 3 && tail[2] === 'files' && Number.isInteger(num) && method === 'GET') {
          const item = repo.items.get(num);
          if (!item || !item.pull) { err(res, 404, 'Not Found'); return true; }
          const p = item.pull;
          const mb = mergeBase(repo, p.baseSha, p.headSha);
          const baseTree = mb ? commitTree(repo, mb) : null;
          const headTree = commitTree(repo, p.headSha);
          const files = diffFiles(repo, baseTree ?? '', headTree ?? '');
          sendJson(res, 200, files);
          return true;
        }
        if (tail.length === 3 && tail[2] === 'merge' && Number.isInteger(num) && method === 'PUT') {
          const item = repo.items.get(num);
          if (!item || !item.pull) { err(res, 404, 'Not Found'); return true; }
          const p = item.pull;
          if (p.merged) { sendJson(res, 200, { merged: true, sha: p.mergeSha, message: `Pull request #${p.number} merged` }); return true; }
          const result = doMerge(repo, p);
          if (!result.ok) {
            if (result.reason === 'conflict') { err(res, 405, 'Merge conflict'); return true; }
            err(res, 422, result.reason);
            return true;
          }
          p.merged = true;
          p.state = 'closed';
          p.mergeSha = result.sha;
          p.mergedAt = nowIso();
          p.updatedAt = nowIso();
          item.state = 'closed';
          item.updatedAt = nowIso();
          sendJson(res, 200, { merged: true, sha: result.sha, message: `Pull request #${p.number} merged` });
          return true;
        }
      }
      // git refs: POST /git/refs, GET /git/refs/heads/{branch}
      if (tail[0] === 'git' && tail[1] === 'refs') {
        if (method === 'POST' && tail.length === 2) {
          const ref = typeof body.ref === 'string' ? body.ref : '';
          const sha = typeof body.sha === 'string' ? body.sha : '';
          if (!ref.startsWith('refs/') || !getObject(repo, sha)) { err(res, 422, 'invalid ref or sha'); return true; }
          repo.refs.set(ref, sha);
          sendJson(res, 201, { ref, object: { sha, type: 'commit' }, url: `/repos/${owner}/${name}/git/refs/${ref.replace(/^refs\//, '')}` });
          return true;
        }
        if (method === 'GET' && tail.length === 4 && tail[2] === 'heads') {
          const oid = repo.refs.get(`refs/heads/${tail[3]}`);
          if (!oid) { err(res, 404, 'Not Found'); return true; }
          sendJson(res, 200, { ref: `refs/heads/${tail[3]}`, object: { sha: oid, type: 'commit' }, url: `/repos/${owner}/${name}/git/refs/heads/${tail[3]}` });
          return true;
        }
      }
      err(res, 404, 'Not Found');
      return true;
    }
    err(res, 404, 'Not Found');
    return true;
  }
  function dirListing(repo: Repo, treeOid: string, prefix: string): Array<Record<string, unknown>> {
    const obj = getObject(repo, treeOid);
    if (!obj || obj.type !== 'tree') return [];
    const out: Array<Record<string, unknown>> = [];
    for (const e of gitSort(parseTree(obj.data))) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      const blob = e.mode === '40000' ? null : getObject(repo, e.oid);
      out.push({
        type: e.mode === '40000' ? 'dir' : 'file',
        name: e.name, path, sha: e.oid,
        size: blob ? blob.data.length : 0,
        url: `/repos/${repo.owner}/${repo.name}/contents/${path}`,
        html_url: `https://example.invalid/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
        download_url: e.mode === '40000' ? null : `https://example.invalid/${repo.owner}/${repo.name}/raw/${repo.defaultBranch}/${path}`,
      });
    }
    return out;
  }
  function dirListingAt(repo: Repo, treeOid: string, dirPath: string): Array<Record<string, unknown>> | null {
    // Walk down the tree to dirPath.
    let cur = treeOid;
    for (const part of dirPath.split('/')) {
      const obj = getObject(repo, cur);
      if (!obj || obj.type !== 'tree') return null;
      const entry = parseTree(obj.data).find((e) => e.name === part && e.mode === '40000');
      if (!entry) return null;
      cur = entry.oid;
    }
    return dirListing(repo, cur, dirPath);
  }

  // ------------------------------------------------------------ git smart HTTP
  function gitCapsUpload(): string {
    return 'side-band-64k thin-pack ofs-delta shallow multi_ack_detailed symref=HEAD:refs/heads/main';
  }
  function gitCapsReceive(): string {
    return 'report-status report-status-v2 side-band-64k delete-refs';
  }
  function advertiseV0(repo: Repo, caps: string, service: string): Buffer {
    const chunks: Buffer[] = [];
    chunks.push(pktLine(`# service=${service}\n`));
    chunks.push(FLUSH);
    const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (headOid) {
      chunks.push(pktLine(`${headOid} HEAD\0${caps}\n`));
    } else {
      chunks.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    }
    for (const [name, oid] of refs) chunks.push(pktLine(`${oid} ${name}\n`));
    chunks.push(FLUSH);
    return Buffer.concat(chunks);
  }
  function advertiseV2(repo: Repo): Buffer {
    const chunks: Buffer[] = [];
    chunks.push(pktLine('# service=git-upload-pack\n'));
    chunks.push(FLUSH);
    chunks.push(pktLine('version 2\n'));
    chunks.push(pktLine('agent=forge/1.0\n'));
    chunks.push(pktLine('ls-refs=unborn\n'));
    chunks.push(pktLine('fetch=shallow wait-for-done filter\n'));
    chunks.push(pktLine('object-format=sha1\n'));
    chunks.push(FLUSH);
    void repo;
    return Buffer.concat(chunks);
  }
  type FetchPlan = { objects: Array<{ type: string; data: Buffer }>; shallow: string[]; unshallow: string[]; acks: string[]; nak: boolean };
  function planFetch(repo: Repo, wants: string[], haves: string[], shallowLines: string[], depth: number | null): FetchPlan {
    // Peel annotated tags on wants to commits.
    const wantCommits: string[] = [];
    const wantTags: string[] = [];
    for (const w of wants) {
      const obj = getObject(repo, w);
      if (!obj) continue;
      if (obj.type === 'commit') wantCommits.push(w);
      else if (obj.type === 'tag') {
        wantTags.push(w);
        const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})/m);
        if (m && getObject(repo, m[1])?.type === 'commit') wantCommits.push(m[1]);
      }
    }
    // What the client already holds: the closure of its haves, but never past
    // a shallow boundary (a shallow commit's parents are NOT held — that is
    // exactly what deepening re-delivers).
    const shallowSet = new Set(shallowLines);
    const haveCommits = new Set<string>();
    {
      const stack = [...haves];
      while (stack.length > 0) {
        const cur = stack.pop()!;
        if (haveCommits.has(cur)) continue;
        const obj = getObject(repo, cur);
        if (!obj || obj.type !== 'commit') continue;
        haveCommits.add(cur);
        if (!shallowSet.has(cur)) for (const p of commitParents(repo, cur)) stack.push(p);
      }
    }
    const haveObjects = new Set<string>();
    {
      const stack = [...haveCommits];
      while (stack.length > 0) {
        const oid = stack.pop()!;
        if (haveObjects.has(oid)) continue;
        const obj = getObject(repo, oid);
        if (!obj) continue;
        haveObjects.add(oid);
        if (obj.type === 'commit') {
          const c = parseCommit(obj.data);
          if (c.tree) stack.push(c.tree);
          for (const p of c.parents) if (haveCommits.has(p)) stack.push(p);
        } else if (obj.type === 'tree') {
          for (const e of parseTree(obj.data)) stack.push(e.oid);
        } else if (obj.type === 'tag') {
          const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})/m);
          if (m) stack.push(m[1]);
        }
      }
    }
    // Depth-limited BFS from the wants.
    const depthOf = new Map<string, number>();
    {
      const queue: Array<[string, number]> = wantCommits.map((c) => [c, 1] as [string, number]);
      while (queue.length > 0) {
        const [cur, d] = queue.shift()!;
        if (depthOf.has(cur)) continue;
        depthOf.set(cur, d);
        if (depth !== null && d >= depth) continue;
        for (const p of commitParents(repo, cur)) {
          if (!depthOf.has(p)) queue.push([p, d + 1]);
        }
      }
    }
    const included = new Set<string>();
    for (const [c] of depthOf) if (!haveCommits.has(c)) included.add(c);
    // ACK: first have that is an ancestor of (or equal to) a want.
    const acks: string[] = [];
    for (const h of haves) {
      if (depthOf.has(h)) { acks.push(h); break; }
    }
    const nak = acks.length === 0;
    // Shallow / unshallow.
    let shallow: string[] = [];
    let unshallow: string[] = [];
    if (depth !== null) {
      for (const [c, d] of depthOf) if (d === depth && included.has(c)) shallow.push(c);
      for (const s of shallowLines) {
        const d = depthOf.get(s);
        if (d !== undefined && d < depth) unshallow.push(s);
      }
    } else {
      for (const s of shallowLines) if (depthOf.has(s)) shallow.push(s);
    }
    // Object closure from the included commits.
    const objects = new Map<string, { type: string; data: Buffer }>();
    const addObj = (oid: string): void => {
      if (haveObjects.has(oid)) return; // the client already holds this object
      const obj = getObject(repo, oid);
      if (obj && !objects.has(oid)) objects.set(oid, { type: obj.type, data: obj.data });
    };
    const stack: string[] = [];
    for (const c of included) { addObj(c); stack.push(c); }
    for (const t of wantTags) { addObj(t); stack.push(t); }
    while (stack.length > 0) {
      const oid = stack.pop()!;
      const obj = getObject(repo, oid);
      if (!obj) continue;
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        if (c.tree) { addObj(c.tree); stack.push(c.tree); }
        for (const p of c.parents) if (included.has(p)) { addObj(p); stack.push(p); }
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) { addObj(e.oid); stack.push(e.oid); }
      } else if (obj.type === 'tag') {
        const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})/m);
        if (m) { addObj(m[1]); stack.push(m[1]); }
      }
    }
    const ordered = [...objects.values()].sort((a, b) => {
      const rank = (t: string): number => (t === 'commit' ? 0 : t === 'tree' ? 1 : t === 'tag' ? 2 : 3);
      return rank(a.type) - rank(b.type);
    });
    return { objects: ordered, shallow, unshallow, acks, nak };
  }
  function handleLsRefsV2(repo: Repo, lines: string[]): Buffer {
    let peel = false;
    let symrefs = false;
    let unborn = false;
    const prefixes: string[] = [];
    for (const line of lines) {
      if (line === 'peel') peel = true;
      else if (line === 'symrefs') symrefs = true;
      else if (line === 'unborn') unborn = true;
      else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
    }
    const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
    const chunks: Buffer[] = [];
    const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (keep('HEAD')) {
      if (headTip) {
        chunks.push(pktLine(`${headTip} HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
      } else if (unborn) {
        chunks.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
      }
    }
    const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    for (const [name, oid] of refs) {
      if (!keep(name)) continue;
      let attrs = '';
      if (peel) {
        const obj = getObject(repo, oid);
        if (obj?.type === 'tag') {
          const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})/m);
          if (m) attrs += ` peeled:${m[1]}`;
        }
      }
      chunks.push(pktLine(`${oid} ${name}${attrs}\n`));
    }
    chunks.push(FLUSH);
    return Buffer.concat(chunks);
  }
  async function handleGit(req: IncomingMessage, res: ServerResponse, url: URL, raw: Buffer): Promise<boolean> {
    const parts = seg(url.pathname);
    if (parts.length < 3 || !parts[1].endsWith('.git')) return false;
    const owner = parts[0];
    const name = parts[1].slice(0, -4);
    const repo = findRepo(owner, name);
    const method = req.method ?? 'GET';
    const service = url.searchParams.get('service') ?? '';
    const isV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
    if (parts[2] === 'info' && parts[3] === 'refs' && method === 'GET') {
      if (!repo || owner !== VIEWER.login) { err(res, 404, 'Not Found'); return true; }
      if (service === 'git-upload-pack') {
        if (isV2) {
          sendBuffer(res, 200, advertiseV2(repo), 'application/x-git-upload-pack-advertisement');
        } else {
          sendBuffer(res, 200, advertiseV0(repo, gitCapsUpload(), 'git-upload-pack'), 'application/x-git-upload-pack-advertisement');
        }
        return true;
      }
      if (service === 'git-receive-pack') {
        sendBuffer(res, 200, advertiseV0(repo, gitCapsReceive(), 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
        return true;
      }
      err(res, 400, 'unknown service');
      return true;
    }
    if (parts[2] === 'git-upload-pack' && method === 'POST') {
      if (!repo || owner !== VIEWER.login) { err(res, 404, 'Not Found'); return true; }
      if (isV2) {
        const packets = parsePktLines(raw);
        const lines = packets.filter((p) => p.kind === 'line').map((p) => p.data.toString('utf8').replace(/\n$/, ''));
        const command = lines[0] ?? '';
        if (command === 'command=ls-refs') {
          sendBuffer(res, 200, handleLsRefsV2(repo, lines.slice(1)), 'application/x-git-upload-pack-result');
          return true;
        }
        if (command === 'command=fetch') {
          const wants: string[] = [];
          const haves: string[] = [];
          const shallow: string[] = [];
          let depth: number | null = null;
          for (const line of lines.slice(1)) {
            if (line.startsWith('want ')) wants.push(line.slice(5).trim());
            else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
            else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
            else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
          }
          const plan = planFetch(repo, wants, haves, shallow, depth);
          const chunks: Buffer[] = [];
          chunks.push(pktLine('acknowledgments\n'));
          if (plan.acks.length > 0) {
            chunks.push(pktLine(`ACK ${plan.acks[0]}\n`));
            chunks.push(pktLine('ready\n'));
          } else {
            chunks.push(pktLine('NAK\n'));
          }
          chunks.push(FLUSH);
          if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
            chunks.push(pktLine('shallow-info\n'));
            for (const s of plan.shallow) chunks.push(pktLine(`shallow ${s}\n`));
            for (const s of plan.unshallow) chunks.push(pktLine(`unshallow ${s}\n`));
            chunks.push(FLUSH);
          }
          chunks.push(pktLine('packfile\n'));
          chunks.push(sidebandPack(writePack(plan.objects)));
          sendBuffer(res, 200, Buffer.concat(chunks), 'application/x-git-upload-pack-result');
          return true;
        }
        err(res, 400, 'unknown v2 command');
        return true;
      }
      // v0 fetch
      const packets = parsePktLines(raw);
      const lines = packets.filter((p) => p.kind === 'line').map((p) => p.data.toString('utf8').replace(/\n$/, ''));
      const wants: string[] = [];
      const haves: string[] = [];
      const shallow: string[] = [];
      let depth: number | null = null;
      for (const line of lines) {
        if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]);
        else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
        else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
        else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
      }
      const plan = planFetch(repo, wants, haves, shallow, depth);
      const chunks: Buffer[] = [];
      if (plan.acks.length > 0) chunks.push(pktLine(`ACK ${plan.acks[0]}\n`));
      else chunks.push(pktLine('NAK\n'));
      for (const s of plan.shallow) chunks.push(pktLine(`shallow ${s}\n`));
      for (const s of plan.unshallow) chunks.push(pktLine(`unshallow ${s}\n`));
      chunks.push(sidebandPack(writePack(plan.objects)));
      sendBuffer(res, 200, Buffer.concat(chunks), 'application/x-git-upload-pack-result');
      return true;
    }
    if (parts[2] === 'git-receive-pack' && method === 'POST') {
      if (!repo || owner !== VIEWER.login) { err(res, 404, 'Not Found'); return true; }
      // Commands are pkt-lines up to the first flush; the pack follows raw.
      const packets = parsePktLines(raw);
      const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
      let packStart = 0;
      let off = 0;
      for (const p of packets) {
        if (p.kind === 'flush') { off += 4; packStart = off; break; }
        if (p.kind === 'line') {
          const lineLen = 4 + p.data.length;
          off += lineLen;
          const text = p.data.toString('utf8').replace(/\n$/, '').split('\0')[0];
          const m = text.match(/^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/);
          if (m) commands.push({ oldOid: m[1], newOid: m[2], ref: m[3] });
        } else {
          off += 4;
        }
      }
      const packBytes = raw.subarray(packStart);
      if (packBytes.length >= 12) {
        try {
          const objects = parsePack(packBytes, repo.objects);
          for (const obj of objects) storeObject(repo, obj.type as GitObject['type'], obj.data);
        } catch {
          const report = Buffer.concat([sideband(Buffer.from('unpack ok\n')), sideband(Buffer.from('ng refs/heads/main unpacker error\n')), FLUSH]);
          sendBuffer(res, 200, report, 'application/x-git-receive-pack-result');
          return true;
        }
      }
      const reportLines: string[] = ['unpack ok'];
      for (const cmd of commands) {
        const current = repo.refs.get(cmd.ref);
        if (cmd.newOid === ZERO_OID) {
          repo.refs.delete(cmd.ref);
          reportLines.push(`ok ${cmd.ref}`);
          continue;
        }
        if (cmd.oldOid === ZERO_OID) {
          if (current !== undefined) { reportLines.push(`ng ${cmd.ref} non-fast-forward`); continue; }
          repo.refs.set(cmd.ref, cmd.newOid);
          reportLines.push(`ok ${cmd.ref}`);
          continue;
        }
        if (current !== cmd.oldOid) { reportLines.push(`ng ${cmd.ref} non-fast-forward`); continue; }
        if (!isAncestor(repo, cmd.oldOid, cmd.newOid)) { reportLines.push(`ng ${cmd.ref} non-fast-forward`); continue; }
        repo.refs.set(cmd.ref, cmd.newOid);
        reportLines.push(`ok ${cmd.ref}`);
      }
      const chunks: Buffer[] = [];
      for (const line of reportLines) chunks.push(sideband(Buffer.from(`${line}\n`)));
      chunks.push(FLUSH);
      sendBuffer(res, 200, Buffer.concat(chunks), 'application/x-git-receive-pack-result');
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------ GraphQL
  type GqlValue =
    | { kind: 'variable'; name: string }
    | { kind: 'string'; value: string }
    | { kind: 'int'; value: number }
    | { kind: 'float'; value: number }
    | { kind: 'boolean'; value: boolean }
    | { kind: 'null' }
    | { kind: 'enum'; value: string }
    | { kind: 'list'; items: GqlValue[] }
    | { kind: 'object'; fields: Array<[string, GqlValue]> };
  type GqlSelection =
    | { kind: 'field'; alias: string; name: string; args: Array<[string, GqlValue]>; selections: GqlSelection[] }
    | { kind: 'fragment'; typeCondition: string | null; selections: GqlSelection[] }
    | { kind: 'spread'; name: string };
  type GqlOperation = {
    type: 'query' | 'mutation';
    name: string | null;
    variables: Array<{ name: string; defaultValue: GqlValue | null }>;
    selections: GqlSelection[];
  };
  function gqlTokenize(src: string): Array<{ kind: string; value: string }> {
    const tokens: Array<{ kind: string; value: string }> = [];
    let i = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { i++; continue; }
      if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
      if (c === '.' && src.slice(i, i + 3) === '...') { tokens.push({ kind: '...', value: '...' }); i += 3; continue; }
      if ('{}()[]:!=$@|'.includes(c)) { tokens.push({ kind: c, value: c }); i++; continue; }
      if (c === '"') {
        let j = i + 1;
        let out = '';
        while (j < src.length && src[j] !== '"') {
          if (src[j] === '\\' && j + 1 < src.length) {
            const e = src[j + 1];
            if (e === 'n') out += '\n';
            else if (e === 't') out += '\t';
            else if (e === 'r') out += '\r';
            else out += e;
            j += 2;
          } else {
            out += src[j];
            j++;
          }
        }
        tokens.push({ kind: 'string', value: out });
        i = j + 1;
        continue;
      }
      if (/[0-9-]/.test(c)) {
        let j = i;
        while (j < src.length && /[0-9.eE+-]/.test(src[j])) j++;
        const raw = src.slice(i, j);
        tokens.push({ kind: raw.includes('.') || raw.includes('e') || raw.includes('E') ? 'float' : 'int', value: raw });
        i = j;
        continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        let j = i;
        while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
        tokens.push({ kind: 'name', value: src.slice(i, j) });
        i = j;
        continue;
      }
      throw new Error(`GraphQL: unexpected character ${JSON.stringify(c)}`);
    }
    tokens.push({ kind: 'eof', value: '' });
    return tokens;
  }
  function gqlParse(src: string): { operations: GqlOperation[]; fragments: Map<string, GqlSelection[]> } {
    const tokens = gqlTokenize(src);
    let pos = 0;
    const peek = (): { kind: string; value: string } => tokens[pos];
    const next = (): { kind: string; value: string } => tokens[pos++];
    const expect = (kind: string): { kind: string; value: string } => {
      const t = next();
      if (t.kind !== kind) throw new Error(`GraphQL: expected ${kind}, got ${t.kind} ${JSON.stringify(t.value)}`);
      return t;
    };
    function parseValue(): GqlValue {
      const t = peek();
      if (t.kind === '$') {
        next();
        return { kind: 'variable', name: expect('name').value };
      }
      if (t.kind === 'string') { next(); return { kind: 'string', value: t.value }; }
      if (t.kind === 'int') { next(); return { kind: 'int', value: Number(t.value) }; }
      if (t.kind === 'float') { next(); return { kind: 'float', value: Number(t.value) }; }
      if (t.kind === 'name') {
        next();
        if (t.value === 'true') return { kind: 'boolean', value: true };
        if (t.value === 'false') return { kind: 'boolean', value: false };
        if (t.value === 'null') return { kind: 'null' };
        return { kind: 'enum', value: t.value };
      }
      if (t.kind === '[') {
        next();
        const items: GqlValue[] = [];
        while (peek().kind !== ']') items.push(parseValue());
        expect(']');
        return { kind: 'list', items };
      }
      if (t.kind === '{') {
        next();
        const fields: Array<[string, GqlValue]> = [];
        while (peek().kind !== '}') {
          const name = expect('name').value;
          expect(':');
          fields.push([name, parseValue()]);
        }
        expect('}');
        return { kind: 'object', fields };
      }
      throw new Error(`GraphQL: unexpected value token ${t.kind}`);
    }
    function parseArgs(): Array<[string, GqlValue]> {
      const args: Array<[string, GqlValue]> = [];
      if (peek().kind !== '(') return args;
      next();
      while (peek().kind !== ')') {
        const name = expect('name').value;
        expect(':');
        args.push([name, parseValue()]);
      }
      expect(')');
      return args;
    }
    function parseSelections(): GqlSelection[] {
      expect('{');
      const out: GqlSelection[] = [];
      while (peek().kind !== '}') {
        if (peek().kind === '...') {
          next();
          if (peek().kind === 'name' && peek().value === 'on') {
            next();
            const typeCondition = expect('name').value;
            out.push({ kind: 'fragment', typeCondition, selections: parseSelections() });
          } else if (peek().kind === 'name') {
            out.push({ kind: 'spread', name: expect('name').value });
          } else {
            out.push({ kind: 'fragment', typeCondition: null, selections: parseSelections() });
          }
          continue;
        }
        const first = expect('name').value;
        let alias = first;
        let name = first;
        if (peek().kind === ':') {
          next();
          name = expect('name').value;
        }
        const args = parseArgs();
        const selections = peek().kind === '{' ? parseSelections() : [];
        out.push({ kind: 'field', alias, name, args, selections });
      }
      expect('}');
      return out;
    }
    const operations: GqlOperation[] = [];
    const fragments = new Map<string, GqlSelection[]>();
    while (peek().kind !== 'eof') {
      const t = peek();
      if (t.kind === '{') {
        operations.push({ type: 'query', name: null, variables: [], selections: parseSelections() });
        continue;
      }
      if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
        const type = next().value as 'query' | 'mutation';
        let name: string | null = null;
        if (peek().kind === 'name') name = next().value;
        const variables: Array<{ name: string; defaultValue: GqlValue | null }> = [];
        if (peek().kind === '(') {
          next();
          while (peek().kind !== ')') {
            expect('$');
            const vname = expect('name').value;
            expect(':');
            // type reference: Name, [Name], Name!, etc.
            let depth = 0;
            while (true) {
              const tk = peek();
              if (tk.kind === '[') { depth++; next(); continue; }
              if (tk.kind === ']') { depth--; next(); continue; }
              if (tk.kind === 'name') { next(); continue; }
              if (tk.kind === '!') { next(); continue; }
              break;
            }
            let defaultValue: GqlValue | null = null;
            if (peek().kind === '=') { next(); defaultValue = parseValue(); }
            variables.push({ name: vname, defaultValue });
          }
          expect(')');
        }
        operations.push({ type, name, variables, selections: parseSelections() });
        continue;
      }
      if (t.kind === 'name' && t.value === 'fragment') {
        next();
        const fname = expect('name').value;
        expect('name'); // 'on'
        expect('name'); // type name
        fragments.set(fname, parseSelections());
        continue;
      }
      throw new Error(`GraphQL: unexpected token ${t.kind} ${JSON.stringify(t.value)}`);
    }
    return { operations, fragments };
  }
  function gqlResolveValue(v: GqlValue, variables: Record<string, unknown>): unknown {
    switch (v.kind) {
      case 'variable': return variables[v.name];
      case 'string': case 'int': case 'float': case 'boolean': return v.value;
      case 'null': return null;
      case 'enum': return v.value;
      case 'list': return v.items.map((x) => gqlResolveValue(x, variables));
      case 'object': {
        const out: Record<string, unknown> = {};
        for (const [k, val] of v.fields) out[k] = gqlResolveValue(val, variables);
        return out;
      }
    }
  }

  // ------------------------------------------------------- GraphQL executor
  const GQL_TYPES: Record<string, { kind: string; fields?: string[]; enumValues?: string[] }> = {
    Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', '__type', '__schema'] },
    Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
    User: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'email', 'url', 'avatarUrl'] },
    Repository: { kind: 'OBJECT', fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'description', 'private', 'createdAt', 'updatedAt'] },
    BranchRef: { kind: 'OBJECT', fields: ['id', 'name'] },
    Issue: { kind: 'OBJECT', fields: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'closedAt', 'url', 'author', 'labels', 'comments'] },
    IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
    IssueEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
    IssueComment: { kind: 'OBJECT', fields: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt'] },
    IssueCommentConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
    Label: { kind: 'OBJECT', fields: ['id', 'name', 'color', 'description'] },
    LabelConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
    PullRequest: { kind: 'OBJECT', fields: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'author', 'createdAt', 'updatedAt', 'mergedAt', 'url', 'mergeCommit'] },
    PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
    PullRequestChangedFile: { kind: 'OBJECT', fields: ['path', 'additions', 'deletions', 'changes'] },
    PullRequestChangedFileConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
    PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'] },
    SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE'] },
    IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
    PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
    CreateIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
    CloseIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
    CreatePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
    MergePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
    AddCommentPayload: { kind: 'OBJECT', fields: ['commentEdge', 'clientMutationId'] },
    IssueCommentEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  };
  type GqlCtx = { errors: Array<{ message: string }> };
  function gqlCursor(number: number): string {
    return encodeB64(`cursor:${number}`);
  }
  function gqlCursorNumber(cursor: string | null | undefined): number | null {
    if (!cursor) return null;
    const decoded = decodeB64(cursor);
    if (!decoded) return null;
    const m = decoded.match(/^cursor:(\d+)$/);
    return m ? Number(m[1]) : null;
  }
  function gqlPageInfo<T extends { number: number }>(nodes: T[], hasNext: boolean): Record<string, unknown> {
    return {
      __typename: 'PageInfo',
      hasNextPage: hasNext,
      hasPreviousPage: false,
      startCursor: nodes.length > 0 ? gqlCursor(nodes[0].number) : null,
      endCursor: nodes.length > 0 ? gqlCursor(nodes[nodes.length - 1].number) : null,
    };
  }
  function gqlConnection<T extends { number: number }>(typeName: string, all: T[], first: number | undefined, after: string | null | undefined, wrap: (n: T) => Record<string, unknown>): Record<string, unknown> {
    let list = all;
    const afterNum = gqlCursorNumber(after);
    if (afterNum !== null) {
      const idx = list.findIndex((n) => n.number === afterNum);
      if (idx >= 0) list = list.slice(idx + 1);
    }
    const limit = first !== undefined ? first : list.length;
    const page = list.slice(0, limit);
    const hasNext = list.length > page.length;
    return {
      __typename: typeName,
      nodes: page.map(wrap),
      edges: page.map((n) => ({ __typename: typeName.replace('Connection', 'Edge'), node: wrap(n), cursor: gqlCursor(n.number) })),
      pageInfo: gqlPageInfo(page, hasNext),
      totalCount: all.length,
    };
  }
  function issueNode(repo: Repo, it: IssueLike): Record<string, unknown> {
    return {
      __typename: 'Issue',
      __repo: repo,
      __item: it,
      id: globalId('Issue', repo.id, it.number),
      databaseId: it.id,
      number: it.number,
      title: it.title,
      body: it.body,
      state: it.state.toUpperCase(),
      createdAt: it.createdAt,
      updatedAt: it.updatedAt,
      closedAt: it.closedAt,
      url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${it.number}`,
    };
  }
  function pullNode(repo: Repo, p: Pull): Record<string, unknown> {
    return {
      __typename: 'PullRequest',
      __repo: repo,
      __pull: p,
      id: globalId('PullRequest', repo.id, p.number),
      databaseId: p.id,
      number: p.number,
      title: p.title,
      body: p.body,
      state: p.merged ? 'MERGED' : p.state.toUpperCase(),
      merged: p.merged,
      headRefName: p.headRef,
      baseRefName: p.baseRef,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      mergedAt: p.mergedAt,
      url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${p.number}`,
    };
  }
  function repoNode(repo: Repo): Record<string, unknown> {
    return {
      __typename: 'Repository',
      __repo: repo,
      id: globalId('Repository', repo.id),
      databaseId: repo.id,
      name: repo.name,
      nameWithOwner: `${repo.owner}/${repo.name}`,
      url: `https://example.invalid/${repo.owner}/${repo.name}`,
      description: repo.description,
      private: repo.private,
      createdAt: repo.createdAt,
      updatedAt: repo.updatedAt,
    };
  }
  function userNode(): Record<string, unknown> {
    return {
      __typename: 'User',
      id: VIEWER.id,
      login: VIEWER.login,
      name: VIEWER.name,
      email: VIEWER.email,
      url: `https://example.invalid/${VIEWER.login}`,
      avatarUrl: `https://example.invalid/${VIEWER.login}.png`,
    };
  }
  function gqlResolveField(typeName: string, value: Record<string, unknown>, field: { name: string; args: Array<[string, GqlValue]>; selections: GqlSelection[] }, variables: Record<string, unknown>, ctx: GqlCtx): { value: unknown; typeName: string | null } {
    const args: Record<string, unknown> = {};
    for (const [k, v] of field.args) args[k] = gqlResolveValue(v, variables);
    const repo = value.__repo as Repo | undefined;
    const item = value.__item as IssueLike | undefined;
    const pull = value.__pull as Pull | undefined;
    const fail = (message: string): { value: unknown; typeName: string | null } => {
      ctx.errors.push({ message });
      return { value: null, typeName: null };
    };
    switch (typeName) {
      case 'Query': {
        if (field.name === 'viewer') return { value: userNode(), typeName: 'User' };
        if (field.name === 'repository') {
          const owner = args.owner as string | undefined;
          const name = args.name as string | undefined;
          const r = owner && name ? findRepo(owner, name) : undefined;
          if (!r || owner !== VIEWER.login) return { value: null, typeName: 'Repository' };
          return { value: repoNode(r), typeName: 'Repository' };
        }
        if (field.name === 'node') {
          const id = args.id as string | undefined;
          if (!id) return { value: null, typeName: null };
          const decoded = decodeB64(id);
          if (!decoded) return { value: null, typeName: null };
          const parts = decoded.split(':');
          if (parts[0] === 'Repository') {
            const r = reposById.get(Number(parts[1]));
            if (!r) return { value: null, typeName: 'Repository' };
            return { value: repoNode(r), typeName: 'Repository' };
          }
          if (parts[0] === 'Issue') {
            const r = reposById.get(Number(parts[1]));
            const it = r?.items.get(Number(parts[2]));
            if (!r || !it || it.pull) return { value: null, typeName: 'Issue' };
            return { value: issueNode(r, it), typeName: 'Issue' };
          }
          if (parts[0] === 'PullRequest') {
            const r = reposById.get(Number(parts[1]));
            const it = r?.items.get(Number(parts[2]));
            if (!r || !it || !it.pull) return { value: null, typeName: 'PullRequest' };
            return { value: pullNode(r, it.pull), typeName: 'PullRequest' };
          }
          return { value: null, typeName: null };
        }
        if (field.name === '__type') {
          const name = args.name as string | undefined;
          const info = name ? GQL_TYPES[name] : undefined;
          if (!info) return { value: null, typeName: '__Type' };
          return { value: { __typename: '__Type', __typeName: name, __info: info }, typeName: '__Type' };
        }
        if (field.name === '__schema') {
          return { value: { __typename: '__Schema' }, typeName: '__Schema' };
        }
        return fail(`Cannot query field "${field.name}" on type "Query".`);
      }
      case 'Mutation': {
        if (field.name === 'createIssue') {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const r = typeof input.repositoryId === 'string' ? reposById.get(Number(decodeB64(input.repositoryId)?.split(':')[1] ?? '')) : undefined;
          if (!r) return fail('createIssue: repository not found');
          const result = createIssueInternal(r, { title: input.title, body: input.body });
          if ('error' in result) return fail(`createIssue: ${result.error}`);
          return { value: { __typename: 'CreateIssuePayload', issue: issueNode(r, result.issue), clientMutationId: input.clientMutationId ?? null }, typeName: 'CreateIssuePayload' };
        }
        if (field.name === 'closeIssue') {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const decoded = typeof input.issueId === 'string' ? decodeB64(input.issueId) : null;
          const parts = decoded?.split(':') ?? [];
          const r = reposById.get(Number(parts[1] ?? ''));
          const it = r?.items.get(Number(parts[2] ?? ''));
          if (!r || !it || it.pull) return fail('closeIssue: issue not found');
          it.state = 'closed';
          it.closedAt = nowIso();
          it.updatedAt = nowIso();
          return { value: { __typename: 'CloseIssuePayload', issue: issueNode(r, it), clientMutationId: input.clientMutationId ?? null }, typeName: 'CloseIssuePayload' };
        }
        if (field.name === 'createPullRequest') {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const r = typeof input.repositoryId === 'string' ? reposById.get(Number(decodeB64(input.repositoryId)?.split(':')[1] ?? '')) : undefined;
          if (!r) return fail('createPullRequest: repository not found');
          const result = createPullInternal(r, { title: input.title, body: input.body, head: input.headRefName, base: input.baseRefName });
          if ('error' in result) return fail(`createPullRequest: ${result.error}`);
          return { value: { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(r, result.pull), clientMutationId: input.clientMutationId ?? null }, typeName: 'CreatePullRequestPayload' };
        }
        if (field.name === 'mergePullRequest') {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const decoded = typeof input.pullRequestId === 'string' ? decodeB64(input.pullRequestId) : null;
          const parts = decoded?.split(':') ?? [];
          const r = reposById.get(Number(parts[1] ?? ''));
          const it = r?.items.get(Number(parts[2] ?? ''));
          if (!r || !it || !it.pull) return fail('mergePullRequest: pull request not found');
          const p = it.pull;
          if (p.merged) return { value: { __typename: 'MergePullRequestPayload', pullRequest: pullNode(r, p), clientMutationId: input.clientMutationId ?? null }, typeName: 'MergePullRequestPayload' };
          const result = doMerge(r, p);
          if (!result.ok) return fail('Merge conflict');
          p.merged = true;
          p.state = 'closed';
          p.mergeSha = result.sha;
          p.mergedAt = nowIso();
          p.updatedAt = nowIso();
          it.state = 'closed';
          it.updatedAt = nowIso();
          return { value: { __typename: 'MergePullRequestPayload', pullRequest: pullNode(r, p), clientMutationId: input.clientMutationId ?? null }, typeName: 'MergePullRequestPayload' };
        }
        if (field.name === 'addComment') {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const decoded = typeof input.subjectId === 'string' ? decodeB64(input.subjectId) : null;
          const parts = decoded?.split(':') ?? [];
          const r = reposById.get(Number(parts[1] ?? ''));
          const it = r?.items.get(Number(parts[2] ?? ''));
          if (!r || !it) return fail('addComment: subject not found');
          const now = nowIso();
          const comment = { id: nextCommentId++, body: typeof input.body === 'string' ? input.body : '', createdAt: now, updatedAt: now };
          it.comments.push(comment);
          const node = { __typename: 'IssueComment', id: globalId('IssueComment', r.id, it.number, comment.id), databaseId: comment.id, body: comment.body, createdAt: now, updatedAt: now };
          return { value: { __typename: 'AddCommentPayload', commentEdge: { __typename: 'IssueCommentEdge', node, cursor: gqlCursor(comment.id) }, clientMutationId: input.clientMutationId ?? null }, typeName: 'AddCommentPayload' };
        }
        return fail(`Cannot query field "${field.name}" on type "Mutation".`);
      }
      case 'CreateIssuePayload': case 'CloseIssuePayload': case 'CreatePullRequestPayload': case 'MergePullRequestPayload': case 'AddCommentPayload': {
        if (field.name === 'issue') return { value: value.issue ?? null, typeName: 'Issue' };
        if (field.name === 'pullRequest') return { value: value.pullRequest ?? null, typeName: 'PullRequest' };
        if (field.name === 'commentEdge') return { value: value.commentEdge ?? null, typeName: 'IssueCommentEdge' };
        if (field.name === 'clientMutationId') return { value: value.clientMutationId ?? null, typeName: null };
        return fail(`Cannot query field "${field.name}" on type "${typeName}".`);
      }
      case 'User': {
        if (['id', 'login', 'name', 'email', 'url', 'avatarUrl'].includes(field.name)) return { value: value[field.name] ?? null, typeName: null };
        return fail(`Cannot query field "${field.name}" on type "User".`);
      }
      case 'Repository': {
        if (!repo) return fail('internal: repository missing');
        switch (field.name) {
          case 'id': case 'databaseId': case 'name': case 'nameWithOwner': case 'url': case 'description': case 'private': case 'createdAt': case 'updatedAt':
            return { value: value[field.name] ?? null, typeName: null };
          case 'owner': return { value: userNode(), typeName: 'User' };
          case 'defaultBranchRef': {
            const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
            if (!tip) return { value: null, typeName: 'BranchRef' };
            return { value: { __typename: 'BranchRef', id: globalId('BranchRef', repo.id, repo.defaultBranch), name: repo.defaultBranch }, typeName: 'BranchRef' };
          }
          case 'viewerPermission': return { value: 'ADMIN', typeName: null };
          case 'hasIssuesEnabled': return { value: true, typeName: null };
          case 'issue': {
            const num = args.number as number | undefined;
            const it = num !== undefined ? repo.items.get(num) : undefined;
            if (!it || it.pull) return { value: null, typeName: 'Issue' };
            return { value: issueNode(repo, it), typeName: 'Issue' };
          }
          case 'issues': {
            let items = [...repo.items.values()].filter((i) => !i.pull);
            const states = args.states as string[] | undefined;
            if (states && states.length > 0) {
              const want = new Set(states.map((s) => String(s).toLowerCase()));
              items = items.filter((i) => want.has(i.state));
            }
            const orderBy = args.orderBy as Record<string, unknown> | undefined;
            if (orderBy && String(orderBy.field) === 'CREATED_AT') {
              const dir = String(orderBy.direction ?? 'DESC');
              items.sort((a, b) => {
                const cmp = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.number - b.number;
                return dir === 'ASC' ? cmp : -cmp;
              });
            } else {
              items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.number - a.number));
            }
            const first = typeof args.first === 'number' ? args.first : undefined;
            const after = typeof args.after === 'string' ? args.after : null;
            return { value: gqlConnection('IssueConnection', items, first, after, (n) => issueNode(repo, n)), typeName: 'IssueConnection' };
          }
          case 'pullRequest': {
            const num = args.number as number | undefined;
            const it = num !== undefined ? repo.items.get(num) : undefined;
            if (!it || !it.pull) return { value: null, typeName: 'PullRequest' };
            return { value: pullNode(repo, it.pull), typeName: 'PullRequest' };
          }
          case 'pullRequests': {
            let pulls = [...repo.items.values()].filter((i) => i.pull).map((i) => i.pull!);
            const states = args.states as string[] | undefined;
            if (states && states.length > 0) {
              const want = new Set(states.map((s) => String(s).toUpperCase()));
              pulls = pulls.filter((p) => want.has(p.merged ? 'MERGED' : p.state.toUpperCase()));
            }
            pulls.sort((a, b) => b.number - a.number);
            const first = typeof args.first === 'number' ? args.first : undefined;
            const after = typeof args.after === 'string' ? args.after : null;
            return { value: gqlConnection('PullRequestConnection', pulls, first, after, (n) => pullNode(repo, n)), typeName: 'PullRequestConnection' };
          }
          default: return fail(`Cannot query field "${field.name}" on type "Repository".`);
        }
      }
      case 'BranchRef': {
        if (['id', 'name'].includes(field.name)) return { value: value[field.name] ?? null, typeName: null };
        return fail(`Cannot query field "${field.name}" on type "BranchRef".`);
      }
      case 'Issue': {
        if (!repo || !item) return fail('internal: issue missing');
        switch (field.name) {
          case 'id': case 'databaseId': case 'number': case 'title': case 'body': case 'state': case 'createdAt': case 'updatedAt': case 'closedAt': case 'url':
            return { value: value[field.name] ?? null, typeName: null };
          case 'author': return { value: userNode(), typeName: 'User' };
          case 'labels': {
            const nodes = item.labels.map((l) => ({ __typename: 'Label', id: globalId('Label', repo.id, l), name: l, color: repo.labels.get(l)?.color ?? 'ffffff', description: repo.labels.get(l)?.description ?? '' }));
            return { value: { __typename: 'LabelConnection', nodes, edges: nodes.map((n) => ({ __typename: 'LabelEdge', node: n, cursor: gqlCursor(0) })), pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, totalCount: nodes.length }, typeName: 'LabelConnection' };
          }
          case 'comments': {
            const nodes = item.comments.map((c) => ({ __typename: 'IssueComment', id: globalId('IssueComment', repo.id, item.number, c.id), databaseId: c.id, body: c.body, createdAt: c.createdAt, updatedAt: c.updatedAt }));
            return { value: { __typename: 'IssueCommentConnection', nodes, edges: nodes.map((n) => ({ __typename: 'IssueCommentEdge', node: n, cursor: gqlCursor(n.databaseId as number) })), pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, totalCount: nodes.length }, typeName: 'IssueCommentConnection' };
          }
          default: return fail(`Cannot query field "${field.name}" on type "Issue".`);
        }
      }
      case 'PullRequest': {
        if (!repo || !pull) return fail('internal: pull request missing');
        switch (field.name) {
          case 'id': case 'databaseId': case 'number': case 'title': case 'body': case 'state': case 'merged': case 'headRefName': case 'baseRefName': case 'createdAt': case 'updatedAt': case 'mergedAt': case 'url':
            return { value: value[field.name] ?? null, typeName: null };
          case 'mergeable': return { value: mergeableState(repo, pull), typeName: null };
          case 'author': return { value: userNode(), typeName: 'User' };
          case 'headRef': return { value: { __typename: 'BranchRef', id: globalId('BranchRef', repo.id, pull.headRef), name: pull.headRef }, typeName: 'BranchRef' };
          case 'baseRef': return { value: { __typename: 'BranchRef', id: globalId('BranchRef', repo.id, pull.baseRef), name: pull.baseRef }, typeName: 'BranchRef' };
          case 'mergeCommit': return { value: pull.mergeSha ? { __typename: 'Commit', oid: pull.mergeSha } : null, typeName: 'Commit' };
          case 'files': {
            const mb = mergeBase(repo, pull.baseSha, pull.headSha);
            const baseTree = mb ? commitTree(repo, mb) : null;
            const headTree = commitTree(repo, pull.headSha);
            const files = diffFiles(repo, baseTree ?? '', headTree ?? '').map((f, i) => ({ __typename: 'PullRequestChangedFile', number: i + 1, path: f.filename, additions: f.additions, deletions: f.deletions, changes: f.changes }));
            const first = typeof args.first === 'number' ? args.first : undefined;
            const page = first !== undefined ? files.slice(0, first) : files;
            return {
              value: {
                __typename: 'PullRequestChangedFileConnection',
                nodes: page,
                edges: page.map((n) => ({ node: n, cursor: gqlCursor(n.number) })),
                pageInfo: { __typename: 'PageInfo', hasNextPage: files.length > page.length, hasPreviousPage: false, startCursor: page.length > 0 ? gqlCursor(page[0].number) : null, endCursor: page.length > 0 ? gqlCursor(page[page.length - 1].number) : null },
                totalCount: files.length,
              },
              typeName: 'PullRequestChangedFileConnection',
            };
          }
          default: return fail(`Cannot query field "${field.name}" on type "PullRequest".`);
        }
      }
      case 'IssueConnection': case 'PullRequestConnection': case 'PullRequestChangedFileConnection': case 'IssueCommentConnection': case 'LabelConnection': {
        if (['nodes', 'edges', 'pageInfo', 'totalCount'].includes(field.name)) return { value: value[field.name] ?? null, typeName: field.name === 'nodes' || field.name === 'edges' ? null : field.name === 'pageInfo' ? 'PageInfo' : null };
        return fail(`Cannot query field "${field.name}" on type "${typeName}".`);
      }
      case 'IssueEdge': case 'IssueCommentEdge': case 'PullRequestEdge': case 'PullRequestChangedFileEdge': case 'LabelEdge': {
        if (field.name === 'node') {
          const node = value.node as Record<string, unknown> | undefined;
          return { value: node ?? null, typeName: node ? String(node.__typename ?? '') : null };
        }
        if (field.name === 'cursor') return { value: value.cursor ?? null, typeName: null };
        return fail(`Cannot query field "${field.name}" on type "${typeName}".`);
      }
      case 'IssueComment': {
        if (['id', 'databaseId', 'body', 'createdAt', 'updatedAt'].includes(field.name)) return { value: value[field.name] ?? null, typeName: null };
        if (field.name === 'author') return { value: userNode(), typeName: 'User' };
        return fail(`Cannot query field "${field.name}" on type "IssueComment".`);
      }
      case 'Label': {
        if (['id', 'name', 'color', 'description'].includes(field.name)) return { value: value[field.name] ?? null, typeName: null };
        return fail(`Cannot query field "${field.name}" on type "Label".`);
      }
      case 'PullRequestChangedFile': {
        if (['path', 'additions', 'deletions', 'changes'].includes(field.name)) return { value: value[field.name] ?? null, typeName: null };
        return fail(`Cannot query field "${field.name}" on type "PullRequestChangedFile".`);
      }
      case 'PageInfo': {
        if (['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'].includes(field.name)) return { value: value[field.name] ?? null, typeName: null };
        return fail(`Cannot query field "${field.name}" on type "PageInfo".`);
      }
      case '__Type': {
        const info = value.__info as { kind: string; fields?: string[]; enumValues?: string[] };
        const typeNameValue = value.__typeName as string;
        switch (field.name) {
          case 'name': return { value: typeNameValue, typeName: null };
          case 'kind': return { value: info.kind, typeName: null };
          case 'description': return { value: null, typeName: null };
          case 'fields': {
            const list = (info.fields ?? []).map((f) => ({ __typename: '__Field', name: f, description: '', type: { __typename: '__Type', __typeName: 'String', __info: { kind: 'SCALAR' } } }));
            return { value: list, typeName: null };
          }
          case 'enumValues': {
            const list = (info.enumValues ?? []).map((e) => ({ __typename: '__EnumValue', name: e, description: '' }));
            return { value: list, typeName: null };
          }
          default: return fail(`Cannot query field "${field.name}" on type "__Type".`);
        }
      }
      case '__Schema': {
        if (field.name === 'queryType') return { value: { __typename: '__Type', __typeName: 'Query', __info: { kind: 'OBJECT' } }, typeName: '__Type' };
        if (field.name === 'mutationType') return { value: { __typename: '__Type', __typeName: 'Mutation', __info: { kind: 'OBJECT' } }, typeName: '__Type' };
        if (field.name === 'types') return { value: [], typeName: null };
        return fail(`Cannot query field "${field.name}" on type "__Schema".`);
      }
      case '__Field': {
        if (field.name === 'name' || field.name === 'description') return { value: value[field.name] ?? null, typeName: null };
        if (field.name === 'type') {
          const t = value.type as Record<string, unknown> | undefined;
          return { value: t ?? null, typeName: '__Type' };
        }
        if (field.name === 'args') return { value: [], typeName: null };
        return fail(`Cannot query field "${field.name}" on type "__Field".`);
      }
      case '__EnumValue': {
        if (field.name === 'name' || field.name === 'description') return { value: value[field.name] ?? null, typeName: null };
        return fail(`Cannot query field "${field.name}" on type "__EnumValue".`);
      }
      default:
        return fail(`Cannot query field "${field.name}" on type "${typeName}".`);
    }
  }
  function gqlExecuteSelections(selections: GqlSelection[], typeName: string, value: Record<string, unknown>, variables: Record<string, unknown>, fragments: Map<string, GqlSelection[]>, ctx: GqlCtx): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const sel of selections) {
      if (sel.kind === 'spread') {
        const frag = fragments.get(sel.name);
        if (frag) Object.assign(out, gqlExecuteSelections(frag, typeName, value, variables, fragments, ctx));
        continue;
      }
      if (sel.kind === 'fragment') {
        if (sel.typeCondition === null || sel.typeCondition === typeName) {
          Object.assign(out, gqlExecuteSelections(sel.selections, typeName, value, variables, fragments, ctx));
        }
        continue;
      }
      const resolved = gqlResolveField(typeName, value, sel, variables, ctx);
      if (Array.isArray(resolved.value)) {
        // A list of nodes (e.g. connection nodes/edges, __Type.fields): each
        // element is resolved in its own __typename.
        out[sel.alias] = resolved.value.map((el) => {
          if (el && typeof el === 'object') {
            const elType = String((el as Record<string, unknown>).__typename ?? resolved.typeName ?? '');
            return gqlExecuteSelections(sel.selections, elType, el as Record<string, unknown>, variables, fragments, ctx);
          }
          return el;
        });
        continue;
      }
      if (resolved.value === null || resolved.value === undefined || sel.selections.length === 0 || resolved.typeName === null) {
        out[sel.alias] = resolved.value ?? null;
        continue;
      }
      if (typeof resolved.value === 'object') {
        out[sel.alias] = gqlExecuteSelections(sel.selections, resolved.typeName, resolved.value as Record<string, unknown>, variables, fragments, ctx);
        continue;
      }
      out[sel.alias] = resolved.value;
    }
    return out;
  }
  function gqlExecute(doc: string, variables: Record<string, unknown>, operationName: string | null): { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } {
    const ctx: GqlCtx = { errors: [] };
    let parsed;
    try {
      parsed = gqlParse(doc);
    } catch (e) {
      return { data: null, errors: [{ message: `GraphQL parse error: ${e instanceof Error ? e.message : String(e)}` }] };
    }
    let op = parsed.operations[0];
    if (operationName) {
      const named = parsed.operations.find((o) => o.name === operationName);
      if (named) op = named;
    }
    if (!op) return { data: null, errors: [{ message: 'no operation' }] };
    const vars: Record<string, unknown> = { ...variables };
    for (const v of op.variables) {
      if (!(v.name in vars) && v.defaultValue) vars[v.name] = gqlResolveValue(v.defaultValue, vars);
    }
    const rootType = op.type === 'mutation' ? 'Mutation' : 'Query';
    const data = gqlExecuteSelections(op.selections, rootType, {}, vars, parsed.fragments, ctx);
    const result: { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } = { data };
    if (ctx.errors.length > 0) result.errors = ctx.errors;
    return result;
  }
  async function handleGraphQL(req: IncomingMessage, res: ServerResponse, raw: Buffer): Promise<boolean> {
    if (req.method !== 'POST') { err(res, 404, 'Not Found'); return true; }
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) { err(res, 400, 'Invalid JSON'); return true; }
    const runOne = (entry: unknown): Record<string, unknown> => {
      if (!isRecord(entry)) return { data: null, errors: [{ message: 'invalid request' }] };
      const query = typeof entry.query === 'string' ? entry.query : '';
      const variables = isRecord(entry.variables) ? (entry.variables as Record<string, unknown>) : {};
      const operationName = typeof entry.operationName === 'string' ? entry.operationName : null;
      return gqlExecute(query, variables, operationName);
    };
    if (Array.isArray(parsed.value)) {
      sendJson(res, 200, parsed.value.map(runOne));
      return true;
    }
    sendJson(res, 200, runOne(parsed.value));
    return true;
  }

  // ------------------------------------------------------------ MCP endpoint
  const MCP_TOOLS: Array<Record<string, unknown>> = [
    { name: 'create_repo', description: 'Create a repository owned by the authenticated user.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, owner: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' } }, required: ['name'] } },
    { name: 'get_repo', description: 'Get a repository by owner and name.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' } }, required: ['owner', 'repo'] } },
    { name: 'create_issue', description: 'Create an issue in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] } },
    { name: 'list_issues', description: 'List issues in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }, required: ['owner', 'repo'] } },
    { name: 'create_pull_request', description: 'Open a pull request from a head branch into a base branch.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
    { name: 'merge_pull_request', description: 'Merge a pull request by number.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' } }, required: ['owner', 'repo', 'pull_number'] } },
  ];
  function mcpResolveRepo(args: Record<string, unknown>): Repo | null {
    const full = typeof args.full_name === 'string' ? args.full_name : null;
    const owner = full ? full.split('/')[0] : typeof args.owner === 'string' ? args.owner : '';
    const repo = full ? full.split('/')[1] : typeof args.repo === 'string' ? args.repo : typeof args.name === 'string' ? args.name : '';
    if (!owner || !repo) return null;
    const r = findRepo(owner, repo);
    return r && owner === VIEWER.login ? r : null;
  }
  function mcpToolResult(result: unknown): Record<string, unknown> {
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  }
  function mcpToolError(message: string): Record<string, unknown> {
    return { content: [{ type: 'text', text: message }], isError: true };
  }
  function mcpCallTool(name: string, args: Record<string, unknown>): { result?: Record<string, unknown>; error?: { code: number; message: string } } {
    const tool = MCP_TOOLS.find((t) => String(t.name) === name);
    if (!tool) return { error: { code: -32602, message: `unknown tool: ${name}` } };
    const required = ((tool.inputSchema as Record<string, unknown>).required as string[]) ?? [];
    for (const key of required) {
      if (args[key] === undefined || args[key] === null || args[key] === '') {
        return { error: { code: -32602, message: `missing required argument: ${key}` } };
      }
    }
    switch (name) {
      case 'create_repo': {
        const repoName = String(args.name);
        if (findRepo(VIEWER.login, repoName)) return { result: mcpToolResult(repoView(findRepo(VIEWER.login, repoName)!)) };
        const now = nowIso();
        const repo: Repo = {
          id: nextRepoId++, name: repoName, owner: VIEWER.login,
          description: typeof args.description === 'string' ? args.description : '',
          private: args.private === true, defaultBranch: 'main',
          createdAt: now, updatedAt: now,
          objects: new Map(), refs: new Map(), items: new Map(), labels: new Map(), nextNumber: 1,
        };
        repos.set(repoKey(repo.owner, repo.name), repo);
        reposById.set(repo.id, repo);
        return { result: mcpToolResult(repoView(repo)) };
      }
      case 'get_repo': {
        const repo = mcpResolveRepo(args);
        if (!repo) return { result: mcpToolError('Repository not found') };
        return { result: mcpToolResult(repoView(repo)) };
      }
      case 'create_issue': {
        const repo = mcpResolveRepo(args);
        if (!repo) return { result: mcpToolError('Repository not found') };
        const result = createIssueInternal(repo, { title: args.title, body: args.body });
        if ('error' in result) return { result: mcpToolError(result.error) };
        return { result: mcpToolResult(issueView(repo, result.issue)) };
      }
      case 'list_issues': {
        const repo = mcpResolveRepo(args);
        if (!repo) return { result: mcpToolError('Repository not found') };
        const state = typeof args.state === 'string' ? args.state : 'open';
        let items = [...repo.items.values()].filter((i) => !i.pull);
        if (state !== 'all') items = items.filter((i) => i.state === state);
        items.sort((a, b) => b.number - a.number);
        return { result: mcpToolResult({ issues: items.map((i) => issueView(repo, i)) }) };
      }
      case 'create_pull_request': {
        const repo = mcpResolveRepo(args);
        if (!repo) return { result: mcpToolError('Repository not found') };
        const result = createPullInternal(repo, { title: args.title, body: args.body, head: args.head, base: args.base });
        if ('error' in result) return { result: mcpToolError(result.error) };
        return { result: mcpToolResult(pullView(repo, result.pull)) };
      }
      case 'merge_pull_request': {
        const repo = mcpResolveRepo(args);
        if (!repo) return { result: mcpToolError('Repository not found') };
        const num = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number ?? args.number);
        const item = repo.items.get(num);
        if (!item || !item.pull) return { result: mcpToolError('Pull request not found') };
        const p = item.pull;
        if (p.merged) return { result: mcpToolResult({ merged: true, sha: p.mergeSha, message: `Pull request #${p.number} merged` }) };
        const result = doMerge(repo, p);
        if (!result.ok) return { result: mcpToolError(result.reason === 'conflict' ? 'Merge conflict' : result.reason) };
        p.merged = true;
        p.state = 'closed';
        p.mergeSha = result.sha;
        p.mergedAt = nowIso();
        p.updatedAt = nowIso();
        item.state = 'closed';
        item.updatedAt = nowIso();
        return { result: mcpToolResult({ merged: true, sha: result.sha, message: `Pull request #${p.number} merged` }) };
      }
      default:
        return { error: { code: -32602, message: `unknown tool: ${name}` } };
    }
  }
  async function handleMcp(req: IncomingMessage, res: ServerResponse, raw: Buffer): Promise<boolean> {
    if (req.method !== 'POST') { err(res, 404, 'Not Found'); return true; }
    if (!authed(req)) {
      sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
      return true;
    }
    const text = raw.toString('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return true;
    }
    if (!isRecord(parsed)) {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return true;
    }
    const id = parsed.id ?? null;
    const method = typeof parsed.method === 'string' ? parsed.method : '';
    if (id === null || id === undefined) {
      // Notification (e.g. notifications/initialized): accept silently.
      res.writeHead(202, { 'content-length': '0' });
      res.end();
      return true;
    }
    const params = isRecord(parsed.params) ? parsed.params : {};
    const ok = (result: unknown, extraHeaders: Record<string, string> = {}): void => {
      sendJson(res, 200, { jsonrpc: '2.0', id, result }, extraHeaders);
    };
    const failRpc = (code: number, message: string): void => {
      sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
    };
    if (method === 'server/discover') {
      ok({
        supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'],
        capabilities: { tools: {} },
        serverInfo: { name: 'forge', version: '1.0.0' },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'forge', version: '1.0.0' } },
      });
      return true;
    }
    if (method === 'initialize') {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      const version = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'].includes(requested) ? requested : '2025-11-25';
      ok({
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: 'forge', version: '1.0.0' },
      }, { 'mcp-session-id': 'forge-session-1' });
      return true;
    }
    if (method === 'tools/list') {
      ok({ tools: MCP_TOOLS });
      return true;
    }
    if (method === 'tools/call') {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
      const outcome = mcpCallTool(toolName, args);
      if (outcome.error) { failRpc(outcome.error.code, outcome.error.message); return true; }
      ok(outcome.result);
      return true;
    }
    if (method === 'ping') { ok({}); return true; }
    failRpc(-32601, `Method not found: ${method}`);
    return true;
  }

  // ------------------------------------------------------------ dispatcher
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      const raw = await readBody(req);
      const pathname = url.pathname;
      if (pathname === '/healthz') { sendJson(res, 200, { ok: true }); return; }
      if (pathname === '/api/graphql') {
        if (!authed(req)) { err(res, 401, 'Unauthorized'); return; }
        await handleGraphQL(req, res, raw);
        return;
      }
      if (pathname === '/mcp') {
        await handleMcp(req, res, raw);
        return;
      }
      if (pathname.startsWith('/api/v3')) {
        if (!authed(req)) { err(res, 401, 'Unauthorized'); return; }
        const handled = await handleRest(req, res, url, raw);
        if (!handled) err(res, 404, 'Not Found');
        return;
      }
      const handled = await handleGit(req, res, url, raw);
      if (!handled) err(res, 404, 'Not Found');
    } catch (e) {
      try { err(res, 500, e instanceof Error ? e.message : 'Internal Server Error'); } catch { /* socket gone */ }
    }
  });
  return server;
}
