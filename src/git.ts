// Git object and packfile primitives, written for this forge.
// Everything here is plain SHA-1 git storage: loose objects live in memory,
// packs are plain (no deltas) on the way out and plain-only on the way in.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObj {
  type: ObjType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** The SHA-1 git assigns to `<type> <size>\0<data>`. */
export function hashObject(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(head).update(data).digest('hex');
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's raw bytes into its entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) break;
    const mode = data.subarray(off, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

/** Git's tree sort: directory names compare with a trailing slash. */
function treeSortKey(entry: TreeEntry): Buffer {
  return Buffer.from(entry.mode === '40000' ? `${entry.name}/` : entry.name, 'utf8');
}

/** Serialise entries into a tree object's bytes, sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => Buffer.compare(treeSortKey(a), treeSortKey(b)));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    const head = Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8');
    const oid = Buffer.from(entry.oid, 'hex');
    parts.push(Buffer.concat([head, oid]));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- commits and tags

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object's raw bytes. */
export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

/** Serialise a commit object. */
export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`, `committer ${fields.committer}`, '', fields.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object's raw bytes. */
export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'object') object = value;
    else if (key === 'type') type = value;
    else if (key === 'tag') tag = value;
    else if (key === 'tagger') tagger = value;
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------- reachability

/**
 * Walk from `roots` through commits, tags and trees, collecting every reachable
 * object id. `lookup` answers an object or undefined for a missing one; a
 * missing object throws, so a caller that tolerates gaps passes allowMissing.
 */
export function collectReachable(
  roots: Iterable<string>,
  lookup: (oid: string) => GitObj | undefined,
  opts: { allowMissing?: boolean } = {},
): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const root of roots) if (isOid(root) && root !== ZERO_OID) stack.push(root);
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = lookup(oid);
    if (obj === undefined) {
      if (opts.allowMissing === true) continue;
      throw new Error(`missing object ${oid}`);
    }
    seen.add(oid);
    if (obj.type === 'commit') {
      const view = parseCommit(obj.data);
      stack.push(view.tree);
      for (const parent of view.parents) stack.push(parent);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    }
  }
  return seen;
}

/** True when `ancestor` is reachable from `tip` (or equals it). */
export function isAncestor(
  ancestor: string,
  tip: string,
  lookup: (oid: string) => GitObj | undefined,
): boolean {
  if (ancestor === tip) return true;
  const stack: string[] = [tip];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = lookup(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (parent === ancestor) return true;
      stack.push(parent);
    }
  }
  return false;
}

/** The first commit reachable from both `a` and `b`, walking breadth-first from `a`. */
export function mergeBase(
  a: string,
  b: string,
  lookup: (oid: string) => GitObj | undefined,
): string | null {
  const bAncestors = new Set<string>();
  const stackB: string[] = [b];
  while (stackB.length > 0) {
    const oid = stackB.pop() as string;
    if (bAncestors.has(oid)) continue;
    bAncestors.add(oid);
    const obj = lookup(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) stackB.push(parent);
  }
  const queue: string[] = [a];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (bAncestors.has(oid)) return oid;
    const obj = lookup(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return null;
}

// ---------------------------------------------------------------- packfiles

function packObjectHeader(type: ObjType, size: number): Buffer {
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

/** Build a version-2 packfile from plain objects (no deltas). */
export function writePack(objects: Iterable<GitObj>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const obj of list) {
    parts.push(packObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Read a packfile's entries (plain objects only); throws on a delta or bad data. */
export function readPack(pack: Buffer): GitObj[] {
  if (pack.length < 32) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');
  const objects: GitObj[] = [];
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    if (offset >= trailerStart) throw new Error('pack is truncated');
    let byte = pack[offset];
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    offset += 1;
    while (byte & 0x80) {
      if (offset >= trailerStart) throw new Error('pack entry size varint is truncated');
      byte = pack[offset];
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    if (typeCode === 6 || typeCode === 7) throw new Error('delta pack entries are not accepted here');
    const type = CODE_TYPE[typeCode];
    if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
    const inflated = inflateSync(pack.subarray(offset), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (inflated.buffer.length !== size) throw new Error('pack entry inflated to the wrong size');
    offset += inflated.engine.bytesWritten;
    objects.push({ type, data: inflated.buffer });
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');
  return objects;
}

// ---------------------------------------------------------------- pkt-line

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

/** One pkt-line frame: 4 hex length bytes, then the payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.alloc(4);
  head.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

/** Encode a mixed list of payloads and control markers into pkt-lines. */
export function pktLines(items: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(PKT_FLUSH);
    else if (item === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

export interface DecodedPkt {
  kind: PktKind;
  payload: Buffer;
  /** Byte offset just past this packet in the source buffer. */
  next: number;
}

/** Decode one pkt-line at `offset`; null when fewer than 4 bytes remain. */
export function decodePktAt(buf: Buffer, offset: number): DecodedPkt | null {
  if (buf.length - offset < 4) return null;
  const head = buf.subarray(offset, offset + 4).toString('ascii');
  if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
  const length = Number.parseInt(head, 16);
  if (length === 0) return { kind: 'flush', payload: Buffer.alloc(0), next: offset + 4 };
  if (length === 1) return { kind: 'delim', payload: Buffer.alloc(0), next: offset + 4 };
  if (length === 2) return { kind: 'response-end', payload: Buffer.alloc(0), next: offset + 4 };
  if (length < 4 || offset + length > buf.length) throw new Error('truncated pkt-line');
  return { kind: 'data', payload: buf.subarray(offset + 4, offset + length), next: offset + length };
}

/** Decode every pkt-line in `buf` until the first flush (or the end). */
export function decodePktLines(buf: Buffer): { packets: DecodedPkt[]; rest: Buffer } {
  const packets: DecodedPkt[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const decoded = decodePktAt(buf, offset);
    if (decoded === null) break;
    packets.push(decoded);
    offset = decoded.next;
    if (decoded.kind === 'flush') break;
  }
  return { packets, rest: buf.subarray(offset) };
}

/** One sideband frame: band byte + chunk, wrapped as a pkt-line. */
export function sidebandPacket(band: 1 | 2, chunk: Buffer): Buffer {
  return pktLine(Buffer.concat([Buffer.from([band]), chunk]));
}
