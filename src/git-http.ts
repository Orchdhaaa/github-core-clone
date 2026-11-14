// Git smart-HTTP: upload-pack (protocol v2 with a v0 fallback) and
// receive-pack (v0 only). Repositories come from the store; a push can never
// invent one. Every update must fast-forward, or the ref is refused.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  PKT_FLUSH,
  ZERO_OID,
  decodePktAt,
  decodePktLines,
  hashObject,
  isAncestor,
  isOid,
  pktLine,
  pktLines,
  readPack,
  sidebandPacket,
  writePack,
} from './git.ts';
import { DEFAULT_BRANCH, Store, ApiError, type Repo } from './store.ts';
import { readBody } from './http-util.ts';

const AGENT = 'github-core-clone/1.0.0';
const UPLOAD_CAPS_V0 =
  'side-band-64k shallow thin-pack ofs-delta multi_ack multi_ack_detailed ' +
  `symref=HEAD:refs/heads/${DEFAULT_BRANCH} agent=${AGENT} object-format=sha1`;
const RECEIVE_CAPS_V0 = `report-status side-band-64k delete-refs agent=${AGENT}`;
const SIDEBAND_MAX = 32768;

function wantsV2(req: IncomingMessage): boolean {
  const header = req.headers['git-protocol'];
  return typeof header === 'string' && header.includes('version=2');
}

/** Ref lines in git's advertisement order: HEAD first, then refs sorted. */
function refLines(repo: Repo, caps: string | null): Buffer[] {
  const lines: Buffer[] = [];
  const names = [...repo.refs.keys()].sort();
  const headTip = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`);
  let first = true;
  const emit = (oid: string, name: string): void => {
    const suffix = first && caps !== null ? `\0${caps}` : '';
    lines.push(pktLine(`${oid} ${name}${suffix}\n`));
    first = false;
  };
  if (headTip !== undefined) emit(headTip, 'HEAD');
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    emit(oid, name);
    const obj = repo.objects.get(oid);
    if (obj !== undefined && obj.type === 'tag') {
      lines.push(pktLine(`${peelTarget(repo, oid)} ${name}^{}\n`));
    }
  }
  if (lines.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps ?? ''}\n`));
  }
  return lines;
}

function advertisementV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0;
  return Buffer.concat([
    pktLine(`# service=${service}\n`),
    PKT_FLUSH,
    ...refLines(repo, caps),
    PKT_FLUSH,
  ]);
}

function advertisementV2(): Buffer {
  return pktLines([
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    `agent=${AGENT}\n`,
    'flush',
  ]);
}

/** Peel a tag object down to the object it ultimately points at. */
function peelTarget(repo: Repo, oid: string): string {
  let current = oid;
  for (let hops = 0; hops < 8; hops += 1) {
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'tag') return current;
    const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
    if (match === null) return current;
    current = match[1] as string;
  }
  return current;
}

/** The ls-refs response: refs filtered by prefix, plus HEAD when it matches. */
function lsRefsResponse(
  repo: Repo,
  prefixes: string[],
  wantPeel: boolean,
  wantSymrefs: boolean,
  wantUnborn: boolean,
): Buffer {
  const lines: Buffer[] = [];
  const headTip = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`);
  const matches = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  if (headTip !== undefined) {
    if (matches('HEAD')) {
      const attr = wantSymrefs ? ` symref-target:refs/heads/${DEFAULT_BRANCH}` : '';
      lines.push(pktLine(`${headTip} HEAD${attr}\n`));
    }
  } else if (wantUnborn && matches('HEAD')) {
    const attr = wantSymrefs ? ` symref-target:refs/heads/${DEFAULT_BRANCH}` : '';
    lines.push(pktLine(`unborn HEAD${attr}\n`));
  }
  for (const name of [...repo.refs.keys()].sort()) {
    if (!matches(name)) continue;
    const oid = repo.refs.get(name) as string;
    let line = `${oid} ${name}`;
    if (wantPeel) {
      const obj = repo.objects.get(oid);
      if (obj !== undefined && obj.type === 'tag') {
        line += ` peeled:${peelTarget(repo, oid)}`;
      }
    }
    lines.push(pktLine(`${line}\n`));
  }
  lines.push(PKT_FLUSH);
  return Buffer.concat(lines);
}

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
}

/** Parse a v2 fetch request body into wants, haves, shallow lines and depth. */
function parseV2Fetch(body: Buffer): FetchRequest {
  const out: FetchRequest = { wants: [], haves: [], shallow: [] };
  let offset = 0;
  let afterDelim = false;
  while (offset < body.length) {
    const decoded = decodePktAt(body, offset);
    if (decoded === null) break;
    offset = decoded.next;
    if (decoded.kind === 'flush') break;
    if (decoded.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (!afterDelim) continue;
    const line = decoded.payload.toString('utf8').trim();
    if (line.startsWith('want ')) out.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) out.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) out.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) out.depth = Number(line.slice(7).trim());
  }
  return out;
}

/** Parse a v0 fetch request body (two flush-separated sections). */
function parseV0Fetch(body: Buffer): FetchRequest {
  const out: FetchRequest = { wants: [], haves: [], shallow: [] };
  const first = decodePktLines(body);
  for (const packet of first.packets) {
    if (packet.kind !== 'data') continue;
    const raw = packet.payload.toString('utf8');
    const nul = raw.indexOf('\0');
    const line = (nul < 0 ? raw : raw.slice(0, nul)).trim();
    if (line.startsWith('want ')) out.wants.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) out.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) out.depth = Number(line.slice(7).trim());
  }
  const second = decodePktLines(first.rest);
  for (const packet of second.packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').trim();
    if (line.startsWith('have ')) out.haves.push(line.slice(5).trim());
  }
  return out;
}

/** Split pack bytes into sideband band-1 frames (at most 32 KiB of data each). */
function packSideband(pack: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  for (let off = 0; off < pack.length; off += SIDEBAND_MAX) {
    frames.push(sidebandPacket(1, pack.subarray(off, Math.min(off + SIDEBAND_MAX, pack.length))));
  }
  if (pack.length === 0) frames.push(sidebandPacket(1, Buffer.alloc(0)));
  return frames;
}

function buildPack(store: Store, repo: Repo, req: FetchRequest): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  const key = `${repo.version}|${[...req.wants].sort().join(',')}|${[...req.haves].sort().join(',')}|${req.depth ?? ''}|${[...req.shallow].sort().join(',')}`;
  const cached = repo.packCache.get(key);
  if (cached !== undefined) return cached;
  const { objects, shallow, unshallow } = store.objectsForFetch(repo, req.wants, req.haves, req.depth, req.shallow);
  const entry = { pack: writePack(objects), shallow, unshallow };
  repo.packCache.set(key, entry);
  return entry;
}

function v2FetchResponse(store: Store, repo: Repo, req: FetchRequest): Buffer {
  const { pack, shallow, unshallow } = buildPack(store, repo, req);
  const shallowLines: (string | Buffer | 'flush' | 'delim')[] = ['shallow-info\n'];
  for (const oid of shallow) shallowLines.push(`shallow ${oid}\n`);
  for (const oid of unshallow) shallowLines.push(`unshallow ${oid}\n`);
  shallowLines.push('delim');
  return Buffer.concat([
    pktLines(['acknowledgments\n', 'NAK\n', 'delim']),
    pktLines(shallowLines),
    pktLine('packfile\n'),
    ...packSideband(pack),
    PKT_FLUSH,
  ]);
}

function v0FetchResponse(store: Store, repo: Repo, req: FetchRequest): Buffer {
  const { pack, shallow, unshallow } = buildPack(store, repo, req);
  const lines: (string | Buffer | 'flush' | 'delim')[] = ['NAK\n'];
  for (const oid of shallow) lines.push(`shallow ${oid}\n`);
  for (const oid of unshallow) lines.push(`unshallow ${oid}\n`);
  return Buffer.concat([pktLines(lines), ...packSideband(pack), PKT_FLUSH]);
}

function handleLsRefs(repo: Repo, body: Buffer): Buffer {
  const prefixes: string[] = [];
  let wantPeel = false;
  let wantSymrefs = false;
  let wantUnborn = false;
  let offset = 0;
  let afterDelim = false;
  while (offset < body.length) {
    const decoded = decodePktAt(body, offset);
    if (decoded === null) break;
    offset = decoded.next;
    if (decoded.kind === 'flush') break;
    if (decoded.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (!afterDelim) continue;
    const line = decoded.payload.toString('utf8').trim();
    if (line === 'peel') wantPeel = true;
    else if (line === 'symrefs') wantSymrefs = true;
    else if (line === 'unborn') wantUnborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length).trim());
  }
  return lsRefsResponse(repo, prefixes, wantPeel, wantSymrefs, wantUnborn);
}

/** The command line of a v2 request body, e.g. `command=fetch`. */
function v2Command(body: Buffer): string {
  let offset = 0;
  while (offset < body.length) {
    const decoded = decodePktAt(body, offset);
    if (decoded === null) return '';
    offset = decoded.next;
    if (decoded.kind === 'flush' || decoded.kind === 'delim') break;
    const line = decoded.payload.toString('utf8').trim();
    if (line.startsWith('command=')) return line.slice('command='.length);
  }
  return '';
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

interface PushCommand {
  old: string;
  next: string;
  ref: string;
}

/** Apply one ref update from a push; returns its report line. */
function applyPush(store: Store, repo: Repo, command: PushCommand): string {
  const current = repo.refs.get(command.ref);
  if (command.next === ZERO_OID) {
    if (current === undefined) return `ng ${command.ref} no such ref\n`;
    if (command.old !== ZERO_OID && command.old !== current) return `ng ${command.ref} non-fast-forward\n`;
    store.deleteRef(repo, command.ref);
    return `ok ${command.ref}\n`;
  }
  if (!isOid(command.next)) return `ng ${command.ref} invalid object\n`;
  const obj = repo.objects.get(command.next);
  if (obj === undefined) return `ng ${command.ref} invalid object\n`;
  if (current === undefined) {
    if (command.old !== ZERO_OID) return `ng ${command.ref} non-fast-forward\n`;
    store.setRef(repo, command.ref, command.next);
    return `ok ${command.ref}\n`;
  }
  if (command.old !== current) return `ng ${command.ref} non-fast-forward\n`;
  if (!isAncestor(current, command.next, (oid) => repo.objects.get(oid))) {
    return `ng ${command.ref} non-fast-forward\n`;
  }
  store.setRef(repo, command.ref, command.next);
  return `ok ${command.ref}\n`;
}

export async function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  owner: string,
  repoName: string,
  servicePath: string,
): Promise<void> {
  let repo: Repo;
  try {
    repo = store.lookupRepo(owner, repoName);
  } catch (error) {
    if (error instanceof ApiError) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    throw error;
  }
  try {
    if (req.method === 'GET' && servicePath === 'info/refs') {
      const isReceive = req.url !== undefined && req.url.includes('service=git-receive-pack');
      if (isReceive) {
        const cacheKey = `recv-ad|${repo.version}`;
        let body = repo.adCache.get(cacheKey);
        if (body === undefined) {
          body = advertisementV0(repo, 'git-receive-pack');
          repo.adCache.set(cacheKey, body);
        }
        sendBuffer(res, 200, 'application/x-git-receive-pack-advertisement', body);
        return;
      }
      if (wantsV2(req)) {
        const cacheKey = `up-ad-v2|${repo.version}`;
        let body = repo.adCache.get(cacheKey);
        if (body === undefined) {
          body = advertisementV2();
          repo.adCache.set(cacheKey, body);
        }
        sendBuffer(res, 200, 'application/x-git-upload-pack-advertisement', body);
        return;
      }
      const cacheKey = `up-ad-v0|${repo.version}`;
      let body = repo.adCache.get(cacheKey);
      if (body === undefined) {
        body = advertisementV0(repo, 'git-upload-pack');
        repo.adCache.set(cacheKey, body);
      }
      sendBuffer(res, 200, 'application/x-git-upload-pack-advertisement', body);
      return;
    }
    if (req.method === 'POST' && servicePath === 'git-upload-pack') {
      const body = await readBody(req);
      if (wantsV2(req)) {
        const command = v2Command(body);
        if (command === 'ls-refs') {
          sendBuffer(res, 200, 'application/x-git-upload-pack-result', handleLsRefs(repo, body));
          return;
        }
        if (command === 'fetch') {
          const fetchReq = parseV2Fetch(body);
          sendBuffer(res, 200, 'application/x-git-upload-pack-result', v2FetchResponse(store, repo, fetchReq));
          return;
        }
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('unknown command');
        return;
      }
      const fetchReq = parseV0Fetch(body);
      sendBuffer(res, 200, 'application/x-git-upload-pack-result', v0FetchResponse(store, repo, fetchReq));
      return;
    }
    if (req.method === 'POST' && servicePath === 'git-receive-pack') {
      const body = await readBody(req);
      const { packets, rest } = decodePktLines(body);
      const commands: PushCommand[] = [];
      for (const packet of packets) {
        if (packet.kind !== 'data') continue;
        const raw = packet.payload.toString('utf8');
        const nul = raw.indexOf('\0');
        const line = (nul < 0 ? raw : raw.slice(0, nul)).trim();
        const parts = line.split(' ');
        if (parts.length !== 3) continue;
        const [old, next, ref] = parts as [string, string, string];
        commands.push({ old, next, ref });
      }
      if (commands.length === 0 && rest.length === 0) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('no commands');
        return;
      }
      if (rest.length > 0) {
        const objects = readPack(rest);
        for (const obj of objects) {
          const oid = hashObject(obj.type, obj.data);
          if (!repo.objects.has(oid)) {
            repo.objects.set(oid, obj);
            repo.version += 1;
            repo.packCache.clear();
            repo.adCache.clear();
          }
        }
      }
      const report: string[] = ['unpack ok\n'];
      for (const command of commands) {
        report.push(applyPush(store, repo, command));
      }
      const frames = report.map((line) => sidebandPacket(1, Buffer.from(line, 'utf8')));
      sendBuffer(res, 200, 'application/x-git-receive-pack-result', Buffer.concat([...frames, PKT_FLUSH]));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not Found');
  } catch {
    // A malformed git request must never take the server down.
    if (!res.headersSent) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad request');
    }
  }
}
