// Git wire formats: pkt-lines and packfiles. No git binary is used anywhere;
// everything here is built from the protocol definitions.
import { inflateSync, deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import type { ObjType, Repo } from "./store.ts";
import { commitInfo, getObject, treeEntries } from "./store.ts";

// ---------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------

export function pktLine(text: string): Buffer {
  const body = Buffer.from(text, "utf8");
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, "0"), "utf8");
  return Buffer.concat([head, body]);
}

export function pktFlush(): Buffer {
  return Buffer.from("0000", "utf8");
}

export function pktDelim(): Buffer {
  return Buffer.from("0001", "utf8");
}

export function pktResponseEnd(): Buffer {
  return Buffer.from("0002", "utf8");
}

export type PktItem =
  | { kind: "line"; text: string }
  | { kind: "flush" }
  | { kind: "delim" }
  | { kind: "end" };

// Parse pkt-lines from the front of buf. Returns the items and the leftover
// bytes after the last complete pkt-line (for upload-pack v0 this is the
// packfile; for receive-pack the same).
export function parsePktLines(buf: Buffer): { items: PktItem[]; rest: Buffer } {
  const items: PktItem[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const lenHex = buf.subarray(off, off + 4).toString("utf8");
    if (lenHex === "0000") {
      items.push({ kind: "flush" });
      off += 4;
      continue;
    }
    if (lenHex === "0001") {
      items.push({ kind: "delim" });
      off += 4;
      continue;
    }
    if (lenHex === "0002") {
      items.push({ kind: "end" });
      off += 4;
      continue;
    }
    const len = parseInt(lenHex, 16);
    if (!Number.isFinite(len) || len < 4 || off + len > buf.length) break;
    const text = buf.subarray(off + 4, off + len).toString("utf8");
    items.push({ kind: "line", text });
    off += len;
  }
  return { items, rest: buf.subarray(off) };
}

// Frame raw bytes as side-band channel 1 (pack data) in 64k chunks.
export function sideband64k(data: Buffer): Buffer {
  const chunks: Buffer[] = [];
  const maxData = 65515;
  for (let off = 0; off < data.length; off += maxData) {
    const piece = data.subarray(off, Math.min(off + maxData, data.length));
    const len = piece.length + 5;
    const head = Buffer.from(len.toString(16).padStart(4, "0"), "utf8");
    chunks.push(Buffer.concat([head, Buffer.from([0x01]), piece]));
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Packfile
// ---------------------------------------------------------------------------

const OBJ_COMMIT = 1;
const OBJ_TREE = 2;
const OBJ_BLOB = 3;
const OBJ_TAG = 4;
const OBJ_OFS_DELTA = 6;
const OBJ_REF_DELTA = 7;

const TYPE_TO_NUM: Record<ObjType, number> = {
  commit: OBJ_COMMIT,
  tree: OBJ_TREE,
  blob: OBJ_BLOB,
  tag: OBJ_TAG,
};

const NUM_TO_TYPE: Record<number, ObjType> = {
  [OBJ_COMMIT]: "commit",
  [OBJ_TREE]: "tree",
  [OBJ_BLOB]: "blob",
  [OBJ_TAG]: "tag",
};

function encodeObjectHeader(typeNum: number, size: number): Buffer {
  const out: number[] = [];
  let b = (typeNum << 4) | (size & 0x0f);
  size >>= 4;
  while (size > 0) {
    out.push(b | 0x80);
    b = size & 0x7f;
    size >>= 7;
  }
  out.push(b);
  return Buffer.from(out);
}

export function buildPack(objects: { type: ObjType; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write("PACK", 0, "utf8");
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  parts.push(head);
  for (const obj of objects) {
    const deflated = deflateSync(obj.data);
    parts.push(encodeObjectHeader(TYPE_TO_NUM[obj.type], obj.data.length));
    parts.push(deflated);
  }
  const body = Buffer.concat(parts);
  const trailer = createHash("sha1").update(body).digest();
  return Buffer.concat([body, trailer]);
}

// Inflate one zlib stream starting at buf[0]. One inflateSync call handles
// the whole stream (it stops at the stream end and ignores trailing bytes),
// so the only unknown is how many bytes the stream consumed. That length is
// recovered by re-deflating the inflated data: zlib output is deterministic
// for a given level, so the re-deflated bytes equal the original stream
// exactly when the level matches. The common levels are tried first; when
// none matches (an exotic producer), fall back to the binary search.
function inflateOne(buf: Buffer): { data: Buffer; consumed: number } {
  let data: Buffer;
  try {
    data = inflateSync(buf);
  } catch {
    return inflateOneBinarySearch(buf);
  }
  // Git packs use levels 0-9 (default 6); try the most common first.
  for (const level of [6, 1, 9, 0, 2, 3, 4, 5, 7, 8]) {
    const re = deflateSync(data, { level });
    if (re.length <= buf.length && buf.subarray(0, re.length).equals(re)) {
      return { data, consumed: re.length };
    }
  }
  return inflateOneBinarySearch(buf);
}

// Binary search for the stream end: a truncated deflate stream throws, a
// complete one succeeds and ignores trailing bytes, so the predicate is
// monotonic.
function inflateOneBinarySearch(buf: Buffer): { data: Buffer; consumed: number } {
  let lo = 1;
  let hi = buf.length;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(buf.subarray(0, mid));
      best = mid;
      hi = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  if (best < 0) throw new Error("packfile: corrupt zlib stream");
  return { data: inflateSync(buf.subarray(0, best)), consumed: best };
}

function readDeltaVarint(buf: Buffer, off: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let i = off;
  for (;;) {
    const b = buf[i++];
    value |= (b & 0x7f) << shift;
    shift += 7;
    if (!(b & 0x80)) break;
  }
  return { value, next: i };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const baseSize = readDeltaVarint(delta, off);
  off = baseSize.next;
  const resultSize = readDeltaVarint(delta, off);
  off = resultSize.next;
  if (baseSize.value !== base.length) throw new Error("packfile: delta base size mismatch");
  const out: Buffer[] = [];
  let total = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      for (let i = 0; i < 4; i++) {
        if (op & (1 << i)) cpOff |= delta[off++] << (8 * i);
      }
      for (let i = 0; i < 3; i++) {
        if (op & (0x10 << i)) cpSize |= delta[off++] << (8 * i);
      }
      if (cpSize === 0) cpSize = 0x10000;
      out.push(base.subarray(cpOff, cpOff + cpSize));
      total += cpSize;
    } else if (op > 0) {
      out.push(delta.subarray(off, off + op));
      total += op;
      off += op;
    } else {
      throw new Error("packfile: delta op 0");
    }
  }
  if (total !== resultSize.value) throw new Error("packfile: delta result size mismatch");
  return Buffer.concat(out);
}

export interface ParsedObject {
  type: ObjType;
  data: Buffer;
  sha: string;
}

export function parsePack(buf: Buffer): ParsedObject[] {
  if (buf.length < 12 || buf.subarray(0, 4).toString("utf8") !== "PACK") {
    throw new Error("packfile: bad header");
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2) throw new Error(`packfile: unsupported version ${version}`);
  const count = buf.readUInt32BE(8);
  const raw: { typeNum: number; data: Buffer; pos: number }[] = [];
  let off = 12;
  for (let i = 0; i < count; i++) {
    const startPos = off;
    const first = buf[off++];
    const typeNum = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    while (buf[off - 1] & 0x80) {
      const b = buf[off++];
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    if (typeNum === OBJ_OFS_DELTA) {
      let b = buf[off++];
      let offset = b & 0x7f;
      while (b & 0x80) {
        b = buf[off++];
        offset = ((offset + 1) << 7) | (b & 0x7f);
      }
      const inflated = inflateOne(buf.subarray(off));
      off += inflated.consumed;
      raw.push({ typeNum, data: inflated.data, pos: startPos - offset });
      void size;
    } else if (typeNum === OBJ_REF_DELTA) {
      const baseSha = buf.subarray(off, off + 20).toString("hex");
      off += 20;
      const inflated = inflateOne(buf.subarray(off));
      off += inflated.consumed;
      raw.push({ typeNum, data: inflated.data, pos: -1 });
      (raw[raw.length - 1] as unknown as { baseSha: string }).baseSha = baseSha;
      void size;
    } else {
      const inflated = inflateOne(buf.subarray(off));
      off += inflated.consumed;
      if (inflated.data.length !== size) throw new Error("packfile: object size mismatch");
      raw.push({ typeNum, data: inflated.data, pos: startPos });
    }
  }
  // Resolve deltas in order (a delta's base always precedes it in the pack).
  const byPos = new Map<number, ParsedObject>();
  const bySha = new Map<string, ParsedObject>();
  const out: ParsedObject[] = [];
  for (const r of raw) {
    let obj: ParsedObject;
    if (r.typeNum === OBJ_OFS_DELTA) {
      const base = byPos.get(r.pos);
      if (!base) throw new Error("packfile: ofs-delta base not found");
      const data = applyDelta(base.data, r.data);
      obj = { type: base.type, data, sha: "" };
    } else if (r.typeNum === OBJ_REF_DELTA) {
      const baseSha = (r as unknown as { baseSha: string }).baseSha;
      const base = bySha.get(baseSha);
      if (!base) throw new Error("packfile: ref-delta base not found");
      const data = applyDelta(base.data, r.data);
      obj = { type: base.type, data, sha: "" };
    } else {
      const type = NUM_TO_TYPE[r.typeNum];
      if (!type) throw new Error(`packfile: unknown object type ${r.typeNum}`);
      obj = { type, data: r.data, sha: "" };
    }
    const head = Buffer.from(`${obj.type} ${obj.data.length}\0`, "utf8");
    obj.sha = createHash("sha1").update(head).update(obj.data).digest("hex");
    byPos.set(r.pos, obj);
    bySha.set(obj.sha, obj);
    out.push(obj);
  }
  return out;
}

// All objects reachable from the given commit tips, minus those reachable
// from the excluded tips. When maxDepth is set, only commits within that many
// steps of a tip are included (their trees and blobs still are), and the
// boundary commits are returned as shallow.
export function collectPackObjects(
  repo: Repo,
  wants: string[],
  haves: string[],
  maxDepth: number | null,
  clientShallow?: Set<string>,
): { objects: { type: ObjType; data: Buffer }[]; shallow: string[] } {
  // A commit in clientShallow is one the client holds but whose parents it
  // does NOT hold (a shallow boundary). When excluding objects the client
  // already has, never traverse past such a commit: its ancestors must
  // still be sent (that is how a deepen delivers the parent).
  const walkCommits = (tips: string[], collect: Set<string>, depthLimit: number | null, stopAt?: Set<string>): Set<string> => {
    const seen = new Set<string>();
    const queue: { sha: string; depth: number }[] = tips.map((sha) => ({ sha, depth: 0 }));
    for (let qi = 0; qi < queue.length; qi++) {
      const { sha, depth } = queue[qi];
      if (seen.has(sha)) continue;
      const info = commitInfo(repo, sha);
      if (!info) continue;
      seen.add(sha);
      collect.add(sha);
      if (depthLimit !== null && depth >= depthLimit) continue;
      if (stopAt && stopAt.has(sha)) continue;
      for (const p of info.parents) queue.push({ sha: p, depth: depth + 1 });
    }
    return seen;
  };
  const excludedCommits = new Set<string>();
  walkCommits(haves, excludedCommits, null, clientShallow);
  // Excluded objects: everything reachable from excluded commits, but
  // never past a shallow boundary commit: the client holds that commit
  // and its tree, but NOT its ancestors (that is how a deepen delivers
  // the parent).
  const excludedObjects = new Set<string>();
  {
    const stack = [...excludedCommits];
    while (stack.length > 0) {
      const sha = stack.pop()!;
      if (excludedObjects.has(sha)) continue;
      excludedObjects.add(sha);
      const obj = getObject(repo, sha);
      if (!obj) continue;
      if (obj.type === "commit") {
        const c = commitInfo(repo, sha)!;
        stack.push(c.tree);
        if (!(clientShallow && clientShallow.has(sha))) {
          for (const p of c.parents) stack.push(p);
        }
      } else if (obj.type === "tree") {
        for (const e of treeEntries(repo, sha)!) stack.push(e.sha);
      } else if (obj.type === "tag") {
        const m = obj.data.toString("utf8").match(/^object ([0-9a-f]{40})$/m);
        if (m) stack.push(m[1]);
      }
    }
  }
  const wantedCommits = new Set<string>();
  const shallow = new Set<string>();
  const queue: { sha: string; depth: number }[] = wants.map((sha) => ({ sha, depth: 0 }));
  const seenCommits = new Set<string>();
  for (let qi = 0; qi < queue.length; qi++) {
    const { sha, depth } = queue[qi];
    if (seenCommits.has(sha)) continue;
    const info = commitInfo(repo, sha);
    if (!info) continue;
    seenCommits.add(sha);
    // Commits at or beyond the depth limit are NOT sent in the packfile.
    // The boundary (reported as "shallow") is the deepest commit that IS
    // sent: one whose parents fall outside the depth limit, or a root
    // commit with no parents.
    if (maxDepth !== null && depth >= maxDepth) continue;
    wantedCommits.add(sha);
    const parents = info.parents;
    if (maxDepth !== null && (depth + 1 >= maxDepth || parents.length === 0)) shallow.add(sha);
    for (const p of parents) queue.push({ sha: p, depth: depth + 1 });
  }
  const objects: { type: ObjType; data: Buffer }[] = [];
  const added = new Set<string>();
  const addObject = (sha: string): void => {
    if (added.has(sha) || excludedObjects.has(sha)) return;
    const obj = getObject(repo, sha);
    if (!obj) return;
    added.add(sha);
    objects.push({ type: obj.type, data: obj.data });
    if (obj.type === "commit") {
      const c = commitInfo(repo, sha)!;
      addObject(c.tree);
    } else if (obj.type === "tree") {
      for (const e of treeEntries(repo, sha)!) addObject(e.sha);
    } else if (obj.type === "tag") {
      const m = obj.data.toString("utf8").match(/^object ([0-9a-f]{40})$/m);
      if (m) addObject(m[1]);
    }
  };
  for (const sha of wantedCommits) addObject(sha);
  // Annotated tags pointing at wanted commits: include the tag objects.
  // repo.tagShas tracks exactly the tag objects, so no full-db scan.
  for (const sha of repo.tagShas) {
    const obj = getObject(repo, sha);
    if (!obj || obj.type !== "tag") continue;
    const m = obj.data.toString("utf8").match(/^object ([0-9a-f]{40})$/m);
    if (m && wantedCommits.has(m[1])) addObject(sha);
  }
  return { objects, shallow: [...shallow] };
}
