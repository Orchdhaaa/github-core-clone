// Git smart-HTTP handlers: info/refs advertisements, upload-pack (v0 and v2)
// and receive-pack (v0). Speaks the protocol from the spec; no git binary.
import type { Repo } from "./store.ts";
import { commitInfo, deleteRef, getObject, isAncestor, isFastForward, putObject, setRef } from "./store.ts";
import {
  buildPack,
  collectPackObjects,
  parsePack,
  parsePktLines,
  pktDelim,
  pktFlush,
  pktLine,
  sideband64k,
  type PktItem,
} from "./gitpack.ts";

const ZERO = "0000000000000000000000000000000000000000";

const UPLOAD_V0_CAPS =
  "thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-relative no-progress include-tag allow-tip-sha1-in-want allow-reachable-sha1-in-want symref=HEAD:refs/heads/main filter agent=forge/1.0";

const RECEIVE_V0_CAPS = "report-status side-band-64k delete-refs ofs-delta agent=forge/1.0";

// The v2 capability advertisement never varies, so it is one shared constant.
const V2_ADVERTISEMENT: Buffer = Buffer.concat([
  pktLine("version 2\n"),
  pktLine("ls-refs=unborn\n"),
  pktLine("fetch=shallow wait-for-done filter\n"),
  pktLine("server-option\n"),
  pktLine("object-format=sha1\n"),
  pktLine("object-info\n"),
  pktLine("agent=forge/1.0\n"),
  pktFlush(),
]);

function sortedRefs(repo: Repo): { name: string; sha: string }[] {
  const out: { name: string; sha: string }[] = [];
  for (const [name, sha] of repo.refs) out.push({ name, sha });
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

function refTip(repo: Repo): string {
  const tip = repo.refs.get("refs/heads/main");
  return tip ?? ZERO;
}

// ---------------------------------------------------------------------------
// Advertisements (GET /info/refs)
// ---------------------------------------------------------------------------

export function uploadPackAdvertisement(repo: Repo, v2: boolean): Buffer {
  if (v2) return V2_ADVERTISEMENT;
  // A v0 advertisement depends only on the ref set, so it is cached per repo
  // and invalidated by setRef/deleteRef on any ref change.
  const cached = repo.uploadV0Adv;
  if (cached) return cached;
  const parts: Buffer[] = [pktLine("# service=git-upload-pack\n"), pktFlush()];
  if (repo.refs.size === 0) {
    // An empty repository advertises the capabilities on a capabilities^{} line.
    parts.push(pktLine(`${ZERO} capabilities^{}\0${UPLOAD_V0_CAPS}\n`));
    parts.push(pktFlush());
    const out = Buffer.concat(parts);
    repo.uploadV0Adv = out;
    return out;
  }
  const tip = refTip(repo);
  parts.push(pktLine(`${tip} HEAD\0${UPLOAD_V0_CAPS}\n`));
  for (const r of sortedRefs(repo)) parts.push(pktLine(`${r.sha} ${r.name}\n`));
  parts.push(pktFlush());
  const out = Buffer.concat(parts);
  repo.uploadV0Adv = out;
  return out;
}

export function receivePackAdvertisement(repo: Repo): Buffer {
  const cached = repo.receiveV0Adv;
  if (cached) return cached;
  const parts: Buffer[] = [pktLine("# service=git-receive-pack\n"), pktFlush()];
  if (repo.refs.size === 0) {
    parts.push(pktLine(`${ZERO} capabilities^{}\0${RECEIVE_V0_CAPS}\n`));
    parts.push(pktFlush());
    const out = Buffer.concat(parts);
    repo.receiveV0Adv = out;
    return out;
  }
  const tip = refTip(repo);
  parts.push(pktLine(`${tip} HEAD\0${RECEIVE_V0_CAPS}\n`));
  for (const r of sortedRefs(repo)) parts.push(pktLine(`${r.sha} ${r.name}\n`));
  parts.push(pktFlush());
  const out = Buffer.concat(parts);
  repo.receiveV0Adv = out;
  return out;
}

// ---------------------------------------------------------------------------
// upload-pack v0
// ---------------------------------------------------------------------------

interface UploadRequest {
  wants: string[];
  haves: string[];
  caps: Set<string>;
  deepen: number | null;
  done: boolean;
}

function parseUploadV0(items: PktItem[]): UploadRequest {
  const req: UploadRequest = { wants: [], haves: [], caps: new Set(), deepen: null, done: false };
  for (const item of items) {
    if (item.kind !== "line") continue;
    const text = item.text;
    if (text.startsWith("want ")) {
      const rest = text.slice(5).trimEnd();
      const [sha, ...caps] = rest.split(" ");
      req.wants.push(sha);
      for (const c of caps) if (c) req.caps.add(c);
    } else if (text.startsWith("have ")) {
      req.haves.push(text.slice(5).trim());
    } else if (text.startsWith("deepen ")) {
      const n = parseInt(text.slice(7).trim(), 10);
      if (Number.isFinite(n)) req.deepen = n;
    } else if (text.trim() === "done") {
      req.done = true;
    }
  }
  return req;
}

function packResponse(
  repo: Repo,
  req: UploadRequest,
  pack: Buffer,
  shallow: string[],
): Buffer {
  const parts: Buffer[] = [];
  // Acknowledgement: one ACK for the first have that is an ancestor of a want.
  let ack: string | null = null;
  for (const have of req.haves) {
    for (const want of req.wants) {
      if (have === want || isAncestor(repo, have, want)) {
        ack = have;
        break;
      }
    }
    if (ack) break;
  }
  if (ack) parts.push(pktLine(`ACK ${ack}\n`));
  else parts.push(pktLine("NAK\n"));
  for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
  if (req.caps.has("side-band-64k")) {
    parts.push(sideband64k(pack));
  } else if (req.caps.has("side-band")) {
    // side-band (not 64k): 1000-byte frames.
    for (let off = 0; off < pack.length; off += 995) {
      const piece = pack.subarray(off, Math.min(off + 995, pack.length));
      const len = piece.length + 5;
      parts.push(Buffer.concat([Buffer.from(len.toString(16).padStart(4, "0"), "utf8"), Buffer.from([0x01]), piece]));
    }
  } else {
    parts.push(pack);
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// Commits at the depth boundary of a shallow fetch (cheap walk, no pack build).
function shallowBoundary(repo: Repo, wants: string[], maxDepth: number | null): string[] {
  if (maxDepth === null) return [];
  // Ground truth (real git 2.43 deepen fetch): the "shallow" lines name the
  // deepest commits the client RECEIVES — the tip itself for depth 1 — not
  // their parents. A commit is a boundary when it is included but its
  // parents are not (depth limit reached) or it has no parents (root).
  const out = new Set<string>();
  const queue: { sha: string; depth: number }[] = wants.map((sha) => ({ sha, depth: 0 }));
  const seen = new Set<string>();
  for (let qi = 0; qi < queue.length; qi++) {
    const { sha, depth } = queue[qi];
    if (seen.has(sha)) continue;
    const info = commitInfo(repo, sha);
    if (!info) continue;
    seen.add(sha);
    if (depth >= maxDepth) continue;
    const parents = info.parents;
    if (depth + 1 >= maxDepth || parents.length === 0) out.add(sha);
    for (const p of parents) queue.push({ sha: p, depth: depth + 1 });
  }
  return [...out];
}

export function handleUploadPackV0(repo: Repo, body: Buffer): Buffer {
  const { items } = parsePktLines(body);
  const req = parseUploadV0(items);
  const cacheKey = `v0:${req.wants.sort().join(",")}|${req.haves.sort().join(",")}|${req.deepen ?? ""}`;
  const cached = repo.packCache.get(cacheKey);
  const shallow = shallowBoundary(repo, req.wants, req.deepen);
  if (cached) return packResponse(repo, req, cached, shallow);
  const { objects } = collectPackObjects(repo, req.wants, req.haves, req.deepen);
  const pack = buildPack(objects);
  repo.packCache.set(cacheKey, pack);
  return packResponse(repo, req, pack, shallow);
}

// ---------------------------------------------------------------------------
// upload-pack v2
// ---------------------------------------------------------------------------

function parseV2Command(items: PktItem[]): { command: string; args: string[] } {
  let command = "";
  const args: string[] = [];
  let pastDelim = false;
  for (const item of items) {
    if (item.kind === "delim") {
      pastDelim = true;
      continue;
    }
    if (item.kind !== "line") continue;
    const text = item.text.trimEnd();
    if (!pastDelim) {
      if (text.startsWith("command=")) command = text.slice(8);
    } else {
      args.push(text);
    }
  }
  return { command, args };
}

function peeledSha(repo: Repo, tagSha: string): string | null {
  const obj = getObject(repo, tagSha);
  if (!obj || obj.type !== "tag") return null;
  const m = obj.data.toString("utf8").match(/^object ([0-9a-f]{40})$/m);
  return m ? m[1] : null;
}

export function handleUploadPackV2(repo: Repo, body: Buffer): Buffer {
  const { items } = parsePktLines(body);
  const { command, args } = parseV2Command(items);
  if (command === "ls-refs") {
    let peel = false;
    let symrefs = false;
    let unborn = false;
    const prefixes: string[] = [];
    let limit = -1;
    for (const a of args) {
      if (a === "peel") peel = true;
      else if (a === "symrefs") symrefs = true;
      else if (a === "unborn") unborn = true;
      else if (a.startsWith("ref-prefix ")) prefixes.push(a.slice(11));
      else if (a.startsWith("ref-limit ")) limit = parseInt(a.slice(10), 10) || -1;
    }
    // ls-refs output depends only on the ref set and these args, so it is
    // cached per repo and invalidated by setRef/deleteRef on any ref change.
    const lsKey = JSON.stringify({ peel, symrefs, unborn, prefixes, limit });
    const lsCached = repo.lsRefsCache.get(lsKey);
    if (lsCached) return lsCached;
    const parts: Buffer[] = [];
    const tip = refTip(repo);
    const headIncluded = prefixes.length === 0 || prefixes.some((p) => "HEAD".startsWith(p));
    if (headIncluded) {
      if (tip === ZERO) {
        // An unborn ref is advertised as `unborn HEAD ...`, with no sha.
        if (unborn) {
          let line = "unborn HEAD";
          if (symrefs) line += " symref-target:refs/heads/main";
          parts.push(pktLine(`${line}\n`));
        }
      } else {
        // Ground truth (real git 2.43 v2 ls-refs): lines are
        // "<sha> HEAD symref-target:refs/heads/main" — NO "ref: " prefix.
        let line = `${tip} HEAD`;
        if (symrefs) line += " symref-target:refs/heads/main";
        parts.push(pktLine(`${line}\n`));
      }
    }
    let count = 0;
    for (const r of sortedRefs(repo)) {
      if (prefixes.length > 0 && !prefixes.some((p) => r.name.startsWith(p))) continue;
      if (limit >= 0 && count >= limit) break;
      let line = `${r.sha} ${r.name}`;
      if (peel) {
        const peeled = peeledSha(repo, r.sha);
        if (peeled) line += ` peeled:${peeled}`;
      }
      parts.push(pktLine(`${line}\n`));
      count++;
    }
    // Annotated tags that peel: the peeled target is an attribute, already added.
    parts.push(pktFlush());
    const lsOut = Buffer.concat(parts);
    repo.lsRefsCache.set(lsKey, lsOut);
    return lsOut;
  }
  if (command === "fetch") {
    const wants: string[] = [];
    const haves: string[] = [];
    const clientShallow: string[] = [];
    let deepen: number | null = null;
    let done = false;
    for (const a of args) {
      if (a.startsWith("want ")) wants.push(a.slice(5).trim());
      else if (a.startsWith("have ")) haves.push(a.slice(5).trim());
      else if (a.startsWith("shallow ")) clientShallow.push(a.slice(8).trim());
      else if (a === "done") done = true;
      else if (a.startsWith("deepen ")) {
        const n = parseInt(a.slice(7).trim(), 10);
        if (Number.isFinite(n)) deepen = n;
      }
    }
    const clientShallowSet = new Set(clientShallow);
    const cacheKey = `v2:${wants.sort().join(",")}|${haves.sort().join(",")}|${deepen ?? ""}|${clientShallow.sort().join(",")}`;
    let pack = repo.packCache.get(cacheKey);
    const shallow = shallowBoundary(repo, wants, deepen);
    if (!pack) {
      const collected = collectPackObjects(repo, wants, haves, deepen, clientShallowSet);
      pack = buildPack(collected.objects);
      repo.packCache.set(cacheKey, pack);
    }
    // Unshallow: a commit the client held as a shallow boundary is no
    // longer shallow once this fetch delivers its parent. That is, a
    // clientShallow commit reachable from a want that is not in the new
    // boundary. (For a full fetch with no deepen, every reachable old
    // boundary is unshallowed.)
    const unshallow: string[] = [];
    if (clientShallow.length > 0) {
      const newBoundary = new Set(shallow);
      for (const c of clientShallow) {
        if (newBoundary.has(c)) continue;
        for (const want of wants) {
          if (c === want || isAncestor(repo, c, want)) {
            unshallow.push(c);
            break;
          }
        }
      }
    }
    const parts: Buffer[] = [];
    // Ground truth (real git 2.43 v2 fetch, via git-http-backend):
    // - No haves, or "done" present: NO acknowledgment section — straight to
    //   the packfile (or shallow-info) section.
    // - Haves present WITHOUT "done": the client waits for an acknowledgment
    //   section. Header is "acknowledgments" (plural). If a common base
    //   (a have that is an ancestor of / equal to a want) exists, send
    //   "ACK <sha>\n" + "ready\n" + delimiter, then the packfile section.
    //   If no common base, send "NAK\n" + flush and NO packfile (the client
    //   will send more haves or "done" in a follow-up request).
    // - Shallow: a "shallow-info" section (header "shallow-info\n", then one
    //   "shallow <sha>" pkt-line per boundary commit with NO trailing
    //   newline, plus "unshallow <sha>" lines for old boundaries this fetch
    //   resolves, then a delimiter), then "packfile\n", then the packfile as
    //   sideband channel-1 frames, then a flush.
    if (haves.length > 0 && !done) {
      let ack: string | null = null;
      for (const have of haves) {
        for (const want of wants) {
          if (have === want || isAncestor(repo, have, want)) {
            ack = have;
            break;
          }
        }
        if (ack) break;
      }
      parts.push(pktLine("acknowledgments\n"));
      if (!ack) {
        parts.push(pktLine("NAK\n"));
        parts.push(pktFlush());
        return Buffer.concat(parts);
      }
      parts.push(pktLine(`ACK ${ack}\n`));
      parts.push(pktLine("ready\n"));
      parts.push(pktDelim());
    }
    if (shallow.length > 0 || unshallow.length > 0) {
      parts.push(pktLine("shallow-info\n"));
      for (const s of shallow) parts.push(pktLine(`shallow ${s}`));
      for (const u of unshallow) parts.push(pktLine(`unshallow ${u}`));
      parts.push(pktDelim());
    }
    parts.push(pktLine("packfile\n"));
    parts.push(sideband64k(pack));
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }
  // Unknown command: empty response.
  return pktFlush();
}

// ---------------------------------------------------------------------------
// receive-pack v0
// ---------------------------------------------------------------------------

interface RefUpdate {
  oldSha: string;
  newSha: string;
  ref: string;
}

export function handleReceivePack(repo: Repo, body: Buffer): { status: number; body: Buffer } {
  const { items, rest } = parsePktLines(body);
  const updates: RefUpdate[] = [];
  const caps = new Set<string>();
  let first = true;
  for (const item of items) {
    if (item.kind !== "line") continue;
    const text = item.text;
    const nul = text.indexOf("\0");
    let line = text;
    if (first && nul >= 0) {
      line = text.slice(0, nul);
      for (const c of text.slice(nul + 1).trim().split(" ")) if (c) caps.add(c);
      first = false;
    }
    const parts = line.trim().split(" ");
    if (parts.length >= 3) updates.push({ oldSha: parts[0], newSha: parts[1], ref: parts[2] });
  }
  const report: string[] = [];
  let unpackOk = true;
  let unpackError = "";
  // A delete-only push carries no packfile at all (rest is empty); that is
  // a valid unpack, not an error.
  if (rest.length > 0) {
    try {
      const objects = parsePack(rest);
      for (const obj of objects) putObject(repo, obj.type, obj.data, obj.sha);
    } catch (e) {
      unpackOk = false;
      unpackError = e instanceof Error ? e.message : "unpack failed";
    }
  }
  if (unpackOk) {
    report.push("unpack ok\n");
    for (const u of updates) {
      const current = repo.refs.get(u.ref);
      if (u.oldSha === ZERO && u.newSha === ZERO) {
        report.push(`ng ${u.ref} invalid update\n`);
      } else if (u.oldSha === ZERO) {
        if (current !== undefined) {
          report.push(`ng ${u.ref} ref already exists\n`);
        } else if (!getObject(repo, u.newSha) && u.newSha !== ZERO) {
          report.push(`ng ${u.ref} new object missing\n`);
        } else {
          setRef(repo, u.ref, u.newSha);
          report.push(`ok ${u.ref}\n`);
        }
      } else if (u.newSha === ZERO) {
        if (current === undefined) {
          report.push(`ng ${u.ref} ref does not exist\n`);
        } else if (current !== u.oldSha) {
          report.push(`ng ${u.ref} stale\n`);
        } else {
          deleteRef(repo, u.ref);
          report.push(`ok ${u.ref}\n`);
        }
      } else {
        if (current === undefined) {
          report.push(`ng ${u.ref} ref does not exist\n`);
        } else if (current !== u.oldSha) {
          report.push(`ng ${u.ref} stale\n`);
        } else if (!isFastForward(repo, u.ref, u.oldSha, u.newSha)) {
          report.push(`ng ${u.ref} non-fast-forward\n`);
        } else {
          setRef(repo, u.ref, u.newSha);
          report.push(`ok ${u.ref}\n`);
        }
      }
    }
    repo.packCache.clear();
  } else {
    report.push(`unpack ${unpackError}\n`);
    for (const u of updates) report.push(`ng ${u.ref} unpack failed\n`);
  }
  // Ground truth (real git-http-backend POST /git-receive-pack response):
  // the ENTIRE report — plain pkt-lines for "unpack ok"/"ok"/"ng" plus its
  // own trailing flush — is wrapped as the data of ONE sideband channel-1
  // frame, followed by a final flush. Framing each line separately delivers
  // raw text without length prefixes, so the client reads "unpa" as a length.
  const reportBuf = Buffer.concat([...report.map((r) => pktLine(r)), pktFlush()]);
  const frameLen = reportBuf.length + 5;
  const frame = Buffer.concat([
    Buffer.from(frameLen.toString(16).padStart(4, "0"), "utf8"),
    Buffer.from([0x01]),
    reportBuf,
  ]);
  const out = Buffer.concat([frame, pktFlush()]);
  return { status: 200, body: out };
}
