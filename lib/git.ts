// lib/git.ts — git smart HTTP (protocol v2 + v0 upload-pack, v0 receive-pack) on the Store.
//
// Implements, from scratch and with Node stdlib only:
//   - pkt-line framing (flush / delim / response-end, 65520-byte max)
//   - packfile encode (plain objects) and decode (OFS_DELTA + REF_DELTA, delta apply)
//   - upload-pack v2: `version 2` advertisement, ls-refs (peel / symrefs / unborn /
//     ref-prefix), fetch with sections (acknowledgments, shallow-info, packfile), shallow
//     clone (depth 1) and deepen, side-band-64k pack delivery
//   - upload-pack v0 fallback: `# service=...` preamble, ref advertisement, want/have/done
//   - receive-pack v0: report-status + side-band-64k, fast-forward-only updates, per-ref
//     ok/ng reporting, mixed pushes apply only the fast-forward half
//
// Auth and the shared Handler contract are honoured here: every git route requires
// `Authorization: Bearer ${MAKEFUN_SHOP_TOKEN}` (401 JSON otherwise); a missing repo
// answers 404 on GET /info/refs; every reply carries X-GitHub-Request-Id.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { Store, hashObject, parseCommit, parseTag, parseTree } from './store.ts';
import type { GitObj, ObjType, Repo } from './store.ts';

// ---------------------------------------------------------------------------
// shared handler contract (identical shape to lib/types.ts; defined here so
// this module stands alone — structural typing makes the two interchangeable)
// ---------------------------------------------------------------------------

export interface Ctx {
  store: Store;
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Map<string, string>;
  rawBody: Buffer;
  json: unknown;
  jsonValid: boolean;
  authed: boolean;
  login: string;
  requestId: string;
}

export interface Resp {
  status: number;
  headers?: Record<string, string>;
  body: string | Buffer;
}

export type Handler = (ctx: Ctx) => Promise<Resp | null>;

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

export const ZERO_OID = '0'.repeat(40);
const PKT_LINE_MAX = 65520;
const AGENT = 'makefun-git/1.0';
const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

let requestCounter = 0;

function headerOf(ctx: Ctx, name: string): string | undefined {
  const exact = ctx.headers.get(name);
  if (exact !== undefined) return exact;
  return ctx.headers.get(name.toLowerCase());
}

function isAuthed(ctx: Ctx): boolean {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (token === '') return false;
  if (ctx.authed === true) return true;
  return headerOf(ctx, 'authorization') === `Bearer ${token}`;
}

function requestIdOf(ctx: Ctx): string {
  if (ctx.requestId !== undefined && ctx.requestId !== '') return ctx.requestId;
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function jsonResp(ctx: Ctx, status: number, body: unknown): Resp {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': requestIdOf(ctx) },
    body: `${JSON.stringify(body)}\n`,
  };
}

function gitResp(ctx: Ctx, status: number, contentType: string, body: Buffer): Resp {
  return {
    status,
    headers: { 'content-type': contentType, 'x-github-request-id': requestIdOf(ctx) },
    body,
  };
}

// ---------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------

export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_LINE_MAX - 4) throw new Error(`pkt-line payload is ${data.length} bytes, over the limit`);
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

const HEX4 = /^[0-9a-fA-F]{4}$/;

/**
 * Decode pkt-lines from `buf`. Stops at the first flush packet when `stopAtFlush` is set
 * and returns the bytes after it as `rest` (the receive-pack pack follows its flush).
 * Throws on a malformed header or a truncated packet.
 */
export function decodePackets(buf: Buffer, stopAtFlush = false): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line header');
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(head)) throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      if (stopAtFlush) return { packets, rest: buf.subarray(offset) };
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3 || length > PKT_LINE_MAX) throw new Error(`invalid pkt-line length ${length}`);
    if (offset + length > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: Buffer.alloc(0) };
}

function dataLines(packets: readonly Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// packfile encode / decode
// ---------------------------------------------------------------------------

const TYPE_CODE: Readonly<Record<ObjType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, ObjType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas); trailer is SHA-1 over the rest. */
export function writePack(objects: Iterable<{ type: ObjType; data: Buffer }>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start] as number;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset] as number;
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start] as number;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset] as number;
    offset += 1;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta (copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

/**
 * Read a packfile (version 2/3) and resolve every object, including OFS_DELTA and REF_DELTA.
 * `resolveBase` supplies a base object a thin pack leaves out. Throws on any corruption.
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObj | undefined): Map<string, GitObj> {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: ObjType;
    resolved?: Buffer;
    oid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset`);
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);

  const objects = new Map<string, GitObj>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): { type: ObjType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: ObjType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (!baseEntry) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid as string;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor supplied`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode] as ObjType;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

// ---------------------------------------------------------------------------
// object-set computation for a fetch
// ---------------------------------------------------------------------------

/** Reachable objects from `roots`, tolerating ids the store does not hold. */
function reachableTolerant(store: Store, repo: Repo, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (/^[0-9a-f]{40}$/.test(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}

interface FetchPlan {
  /** Object ids to send, in a stable order (commits, trees, blobs as stored). */
  oids: string[];
  /** New shallow boundary commits (only when depth was requested). */
  shallow: string[];
  /** Old shallow boundaries that are now fully held. */
  unshallow: string[];
}

/**
 * What a fetch sends. No depth: reachable(wants) minus reachable(haves) — including blobs
 * shared with the old history, which the client already holds. With depth: the depth-limited
 * closure of the wants, minus the have commits themselves, expanded to their trees/blobs;
 * the boundary is the commits at distance depth-1, unshallow the old boundaries now inside.
 */
function planFetch(
  store: Store,
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  depth: number | null,
  oldShallow: readonly string[],
): FetchPlan {
  if (depth === null) {
    const wanted = reachableTolerant(store, repo, wants);
    const held = reachableTolerant(store, repo, haves);
    for (const oid of held) wanted.delete(oid);
    return { oids: [...wanted], shallow: [], unshallow: [] };
  }
  // BFS with distances from the wants.
  const dist = new Map<string, number>();
  const queue: Array<[string, number]> = [];
  for (const want of wants) {
    const commit = store.peelToCommit(repo, want);
    if (commit !== undefined && !dist.has(commit)) {
      dist.set(commit, 0);
      queue.push([commit, 0]);
    }
  }
  while (queue.length) {
    const [oid, d] = queue.shift() as [string, number];
    if (d + 1 >= depth) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (!dist.has(parent)) {
        dist.set(parent, d + 1);
        queue.push([parent, d + 1]);
      }
    }
  }
  const haveCommits = new Set<string>();
  for (const have of haves) {
    const commit = store.peelToCommit(repo, have);
    if (commit !== undefined) haveCommits.add(commit);
  }
  const included = new Set<string>();
  for (const [oid, d] of dist) {
    if (d < depth && !haveCommits.has(oid)) included.add(oid);
  }
  const boundary = new Set<string>();
  for (const [oid, d] of dist) {
    if (d === depth - 1 && included.has(oid)) boundary.add(oid);
  }
  const objects = store.expandFromCommits(repo, included);
  // An old boundary is unshallow when it now lies inside the new depth closure (so its
  // parents are held or it is itself sent) and is not itself the new boundary.
  const unshallow: string[] = [];
  for (const old of oldShallow) {
    if (dist.has(old) && !boundary.has(old)) unshallow.push(old);
  }
  return { oids: [...objects], shallow: [...boundary], unshallow };
}

function packForOids(repo: Repo, oids: Iterable<string>): Buffer {
  const objects: Array<{ type: ObjType; data: Buffer }> = [];
  for (const oid of oids) {
    const obj = repo.objects.get(oid);
    if (obj) objects.push({ type: obj.type, data: obj.data });
  }
  return writePack(objects);
}

/** Split pack bytes into sideband band-1 pkt-lines (each <= the 65520-byte pkt-line max). */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = PKT_LINE_MAX - 4 - 1;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (pack.length === 0) parts.push(pktLine(Buffer.from([1])));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const refs = [...repo.refs.entries()].map(([name, oid]) => ({ name, oid }));
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return refs;
}

function peeledOid(store: Store, repo: Repo, oid: string): string | undefined {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'tag') return undefined;
  return store.peelToCommit(repo, oid);
}

function v2Advertisement(): Buffer {
  const lines = ['version 2\n', `agent=${AGENT}\n`, 'ls-refs=unborn\n', 'fetch=shallow\n', 'object-format=sha1\n'];
  return Buffer.concat([...lines.map((line) => pktLine(line)), PKT_FLUSH]);
}

function v0Advertisement(store: Store, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const defaultBranch = repo.default_branch;
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k ofs-delta thin-pack shallow multi_ack_detailed symref=HEAD:refs/heads/${defaultBranch} agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta thin-pack symref=HEAD:refs/heads/${defaultBranch} agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`)];
  const refs = sortedRefs(repo);
  const headOid = repo.refs.get(`refs/heads/${defaultBranch}`);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    const emit = (oid: string, name: string): void => {
      parts.push(pktLine(first ? `${oid} ${name}\0${caps}\n` : `${oid} ${name}\n`));
      first = false;
    };
    emit(headOid ?? ZERO_OID, 'HEAD');
    for (const ref of refs) {
      emit(ref.oid, ref.name);
      const peeled = peeledOid(store, repo, ref.oid);
      if (peeled !== undefined) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// ls-refs (v2)
// ---------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function lsRefsResponse(store: Store, repo: Repo, args: LsRefsArgs): Buffer {
  const parts: Buffer[] = [];
  const keep = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const defaultBranch = repo.default_branch;
  const headOid = repo.refs.get(`refs/heads/${defaultBranch}`);
  if (keep('HEAD')) {
    if (headOid !== undefined) {
      parts.push(pktLine(args.symrefs ? `${headOid} HEAD symref-target:refs/heads/${defaultBranch}\n` : `${headOid} HEAD\n`));
    } else if (args.unborn) {
      parts.push(pktLine(`unborn HEAD symref-target:refs/heads/${defaultBranch}\n`));
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel) {
      const peeled = peeledOid(store, repo, ref.oid);
      if (peeled !== undefined) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// fetch responses
// ---------------------------------------------------------------------------

function acksFor(store: Store, repo: Repo, wants: readonly string[], haves: readonly string[]): string[] {
  if (haves.length === 0) return [];
  const reachable = reachableTolerant(store, repo, wants);
  return haves.filter((have) => reachable.has(have));
}

function v2FetchResponse(
  store: Store,
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  depth: number | null,
  oldShallow: readonly string[],
): Buffer {
  const plan = planFetch(store, repo, wants, haves, depth, oldShallow);
  const acks = acksFor(store, repo, wants, haves);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (acks.length === 0) {
    parts.push(pktLine('NAK\n'));
  } else {
    for (const ack of acks) parts.push(pktLine(`ACK ${ack}\n`));
    parts.push(pktLine('ready\n'));
  }
  parts.push(PKT_DELIM);
  if (depth !== null) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPack(packForOids(repo, plan.oids)));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v0FetchResponse(
  store: Store,
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  depth: number | null,
  oldShallow: readonly string[],
): Buffer {
  const plan = planFetch(store, repo, wants, haves, depth, oldShallow);
  const acks = acksFor(store, repo, wants, haves);
  const parts: Buffer[] = [];
  if (acks.length === 0) parts.push(pktLine('NAK\n'));
  else for (const ack of acks) parts.push(pktLine(`ACK ${ack}\n`));
  if (depth !== null) {
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  }
  parts.push(sidebandPack(packForOids(repo, plan.oids)));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// request parsing
// ---------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  depth: number | null;
  shallow: string[];
}

function parseV2Args(lines: readonly string[]): { command: string; fetch: FetchArgs; lsRefs: LsRefsArgs } {
  let command = '';
  const fetch: FetchArgs = { wants: [], haves: [], depth: null, shallow: [] };
  const lsRefs: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const raw of lines) {
    const line = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    if (line.startsWith('command=')) command = line.slice('command='.length);
    else if (line.startsWith('want ')) fetch.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) fetch.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) fetch.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isSafeInteger(n) && n > 0) fetch.depth = n;
    } else if (line === 'peel') lsRefs.peel = true;
    else if (line === 'symrefs') lsRefs.symrefs = true;
    else if (line === 'unborn') lsRefs.unborn = true;
    else if (line.startsWith('ref-prefix ')) lsRefs.prefixes.push(line.slice('ref-prefix '.length));
  }
  return { command, fetch, lsRefs };
}

function parseV0Fetch(packets: readonly Packet[]): FetchArgs {
  const fetch: FetchArgs = { wants: [], haves: [], depth: null, shallow: [] };
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8');
    const text = line.endsWith('\n') ? line.slice(0, -1) : line;
    if (section === 0) {
      if (text.startsWith('want ')) {
        const rest = text.slice(5);
        const space = rest.indexOf(' ');
        fetch.wants.push(space < 0 ? rest.trim() : rest.slice(0, space));
      } else if (text.startsWith('shallow ')) fetch.shallow.push(text.slice(8).trim());
      else if (text.startsWith('deepen ')) {
        const n = Number.parseInt(text.slice(7).trim(), 10);
        if (Number.isSafeInteger(n) && n > 0) fetch.depth = n;
      }
    } else if (text.startsWith('have ')) {
      fetch.haves.push(text.slice(5).trim());
    }
  }
  return fetch;
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function parsePushCommands(packets: readonly Packet[]): { commands: PushCommand[]; capabilities: Set<string> } {
  const commands: PushCommand[] = [];
  const capabilities = new Set<string>();
  let first = true;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8');
    if (line.endsWith('\n')) line = line.slice(0, -1);
    if (first) {
      first = false;
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        for (const token of line.slice(nul + 1).split(' ')) {
          if (token !== '') capabilities.add(token);
        }
        line = line.slice(0, nul);
      }
    }
    const parts = line.split(' ');
    if (parts.length !== 3) throw new Error(`bad receive-pack command ${JSON.stringify(line.slice(0, 60))}`);
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!/^[0-9a-f]{40}$/.test(oldOid) || !/^[0-9a-f]{40}$/.test(newOid)) {
      throw new Error('receive-pack command has a bad object id');
    }
    commands.push({ oldOid, newOid, ref });
  }
  if (commands.length === 0) throw new Error('receive-pack sent no commands');
  return { commands, capabilities };
}

/** Rebuild a branch's flat file map from its tip commit (keeps REST contents in sync). */
function syncBranchFiles(store: Store, repo: Repo, branch: string): void {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) {
    repo.files.delete(branch);
    return;
  }
  const files = store.flatFilesOfCommit(repo, tip);
  if (files) repo.files.set(branch, files);
  else repo.files.delete(branch);
}

function reportResponse(lines: string[], sideband: boolean): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    const framed = pktLine(line);
    parts.push(sideband ? pktLine(Buffer.concat([Buffer.from([1]), framed])) : framed);
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function handleReceivePack(ctx: Ctx, store: Store, repo: Repo): Resp {
  let parsed: { commands: PushCommand[]; capabilities: Set<string> };
  let pack: Buffer;
  try {
    const decoded = decodePackets(ctx.rawBody, true);
    parsed = parsePushCommands(decoded.packets);
    pack = decoded.rest;
  } catch {
    return {
      status: 400,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'x-github-request-id': requestIdOf(ctx) },
      body: 'bad request\n',
    };
  }
  const { commands, capabilities } = parsed;
  const sideband = capabilities.has('side-band-64k');
  let unpackError: string | null = null;
  if (pack.length > 0) {
    try {
      const objects = readPack(pack, (oid) => repo.objects.get(oid));
      for (const [oid, obj] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch (err) {
      unpackError = (err as Error).message;
    }
  }
  const lines: string[] = [];
  if (unpackError !== null) {
    lines.push(`unpack ${unpackError.replace(/[\r\n]+/g, ' ')}\n`);
    return gitResp(ctx, 200, RECEIVE_RESULT, reportResponse(lines, sideband));
  }
  lines.push('unpack ok\n');
  let anyChange = false;
  for (const command of parsed.commands) {
    const current = repo.refs.get(command.ref);
    let result: { ok: true } | { ok: false; reason: string };
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) result = { ok: false, reason: 'no such ref' };
      else if (command.oldOid !== ZERO_OID && command.oldOid !== current) result = { ok: false, reason: 'old value mismatch' };
      else {
        repo.refs.delete(command.ref);
        result = { ok: true };
      }
    } else if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) result = { ok: false, reason: 'already exists' };
      else if (!repo.objects.has(command.newOid)) result = { ok: false, reason: 'object not found' };
      else {
        repo.refs.set(command.ref, command.newOid);
        result = { ok: true };
      }
    } else {
      // Update: fast-forward only.
      if (current === undefined) result = { ok: false, reason: 'no such ref' };
      else if (current !== command.oldOid) result = { ok: false, reason: 'old value mismatch' };
      else if (!repo.objects.has(command.newOid)) result = { ok: false, reason: 'object not found' };
      else if (!store.isAncestor(repo, command.oldOid, command.newOid)) result = { ok: false, reason: 'non-fast-forward' };
      else {
        repo.refs.set(command.ref, command.newOid);
        result = { ok: true };
      }
    }
    if (result.ok) {
      anyChange = true;
      lines.push(`ok ${command.ref}\n`);
      if (command.ref.startsWith('refs/heads/')) syncBranchFiles(store, repo, command.ref.slice('refs/heads/'.length));
    } else {
      lines.push(`ng ${command.ref} ${result.reason}\n`);
    }
  }
  if (anyChange) {
    repo.updated_at = store.nowIso();
    repo.pushed_at = store.nowIso();
  }
  return gitResp(ctx, 200, RECEIVE_RESULT, reportResponse(lines, sideband));
}

// ---------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------

function handleUploadPack(ctx: Ctx, store: Store, repo: Repo): Resp {
  const wantsV2 = headerOf(ctx, 'git-protocol') === 'version=2';
  let packets: Packet[];
  try {
    packets = decodePackets(ctx.rawBody).packets;
  } catch {
    return {
      status: 400,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'x-github-request-id': requestIdOf(ctx) },
      body: 'bad request\n',
    };
  }
  if (wantsV2) {
    const { command, fetch, lsRefs } = parseV2Args(dataLines(packets));
    if (command === 'ls-refs') {
      return gitResp(ctx, 200, UPLOAD_RESULT, lsRefsResponse(store, repo, lsRefs));
    }
    if (command === 'fetch') {
      if (fetch.wants.length === 0) {
        return gitResp(ctx, 200, UPLOAD_RESULT, v2FetchResponse(store, repo, [], [], null, []));
      }
      return gitResp(ctx, 200, UPLOAD_RESULT, v2FetchResponse(store, repo, fetch.wants, fetch.haves, fetch.depth, fetch.shallow));
    }
    return {
      status: 400,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'x-github-request-id': requestIdOf(ctx) },
      body: 'bad request\n',
    };
  }
  const fetch = parseV0Fetch(packets);
  return gitResp(ctx, 200, UPLOAD_RESULT, v0FetchResponse(store, repo, fetch.wants, fetch.haves, fetch.depth, fetch.shallow));
}

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

const GIT_ROUTE = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

const gitHandler: Handler = async (ctx) => {
  let path = ctx.path;
  try {
    path = decodeURIComponent(path);
  } catch {
    return null;
  }
  const match = GIT_ROUTE.exec(path);
  if (!match) return null;
  const [, ownerRaw, repoRaw, service] = match as unknown as [string, string, string, string];
  let owner = ownerRaw as string;
  let repoName = repoRaw as string;
  try {
    owner = decodeURIComponent(owner);
    repoName = decodeURIComponent(repoName);
  } catch {
    return jsonResp(ctx, 404, { message: 'Not Found' });
  }
  if (!isAuthed(ctx)) return jsonResp(ctx, 401, { message: 'Requires authentication' });
  const repo = ctx.store.getRepo(owner, repoName);
  if (service === 'info/refs') {
    if (ctx.method !== 'GET') return jsonResp(ctx, 404, { message: 'Not Found' });
    const serviceParam = ctx.query.get('service') ?? '';
    if (serviceParam !== 'git-upload-pack' && serviceParam !== 'git-receive-pack') {
      return jsonResp(ctx, 400, { message: 'Missing or invalid service parameter' });
    }
    if (!repo) return jsonResp(ctx, 404, { message: 'Not Found' });
    if (serviceParam === 'git-receive-pack') {
      return gitResp(ctx, 200, RECEIVE_AD, v0Advertisement(ctx.store, repo, 'git-receive-pack'));
    }
    if (headerOf(ctx, 'git-protocol') === 'version=2') {
      return gitResp(ctx, 200, UPLOAD_AD, v2Advertisement());
    }
    return gitResp(ctx, 200, UPLOAD_AD, v0Advertisement(ctx.store, repo, 'git-upload-pack'));
  }
  if (ctx.method !== 'POST') return jsonResp(ctx, 404, { message: 'Not Found' });
  if (!repo) return jsonResp(ctx, 404, { message: 'Not Found' });
  if (service === 'git-upload-pack') return handleUploadPack(ctx, ctx.store, repo);
  return handleReceivePack(ctx, ctx.store, repo);
};

export const gitHandlers: Handler[] = [gitHandler];
