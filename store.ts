// In-memory store for the forge: repositories, issues, pull requests, labels and
// the git object database. Everything is deterministic: timestamps come from a
// counter clock seeded by MAKEFUN_TRIAL_NOW, ids from counters, so two runs of
// the same request sequence produce byte-identical observable output.
import { createHash } from "node:crypto";

export type ObjType = "commit" | "tree" | "blob" | "tag";

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export interface Clock {
  nextMs(): number;
  nextIso(): string;
  nextEpoch(): number;
}

export function makeClock(): Clock {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  const parsed = raw ? Date.parse(raw) : NaN;
  const baseMs = Number.isFinite(parsed) ? parsed : Date.now();
  let tick = 0;
  const next = (): number => baseMs + tick++ * 1000;
  return {
    nextMs: next,
    nextIso: (): string => new Date(next()).toISOString(),
    nextEpoch: (): number => Math.floor(next() / 1000),
  };
}

export function hashObject(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, "utf8");
  return createHash("sha1").update(head).update(data).digest("hex");
}

export function userObject(login: string, id: number): Record<string, unknown> {
  return {
    login,
    id,
    node_id: Buffer.from(`User:${id}`).toString("base64"),
    avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4`,
    gravatar_id: "",
    url: `https://api.github.com/users/${login}`,
    html_url: `https://github.com/${login}`,
    type: "User",
    site_admin: false,
  };
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  nodeId: string;
  issueNumber: number;
  body: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  nodeId: string;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: Label[];
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: number;
}

export interface PullRequest {
  id: number;
  nodeId: string;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Repo {
  id: number;
  nodeId: string;
  name: string;
  ownerLogin: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  pushedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  issueComments: Map<number, IssueComment[]>;
  pulls: Map<number, PullRequest>;
  nextNumber: number;
  issueJsonCache: Map<number, string>;
  packCache: Map<string, Buffer>;
  // Parsed-object caches: git objects are immutable once stored, so a commit
  // or tree parsed once never needs re-parsing.
  commitCache: Map<string, CommitInfo>;
  treeCache: Map<string, TreeEntry[]>;
  // Ancestor set of each ref's tip, maintained incrementally on ref moves.
  refAncestors: Map<string, Set<string>>;
  // Shas of the tag objects in the db, so tag lookups never scan all objects.
  tagShas: Set<string>;
  // Advertisement caches, invalidated on any ref change.
  uploadV0Adv: Buffer | null;
  receiveV0Adv: Buffer | null;
  lsRefsCache: Map<string, Buffer>;
}

export interface Store {
  login: string;
  userId: number;
  repos: Map<string, Repo>;
  nextRepoId: number;
  nextObjectId: number;
  nextLabelId: number;
  clock: Clock;
  reqCounter: number;
}

export function makeStore(login: string): Store {
  return {
    login,
    userId: 1,
    repos: new Map(),
    nextRepoId: 1,
    nextObjectId: 1,
    nextLabelId: 1,
    clock: makeClock(),
    reqCounter: 0,
  };
}

export function nextRequestId(store: Store): string {
  store.reqCounter += 1;
  return `req-${store.reqCounter}`;
}

export function createRepo(store: Store, name: string, description: string, isPrivate: boolean): Repo {
  const id = store.nextRepoId++;
  const now = store.clock.nextIso();
  const repo: Repo = {
    id,
    nodeId: Buffer.from(`Repository:${id}`).toString("base64"),
    name,
    ownerLogin: store.login,
    description,
    isPrivate,
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
    pushedAt: now,
    objects: new Map(),
    refs: new Map(),
    labels: new Map(),
    issues: new Map(),
    issueComments: new Map(),
    pulls: new Map(),
    nextNumber: 1,
    issueJsonCache: new Map(),
    packCache: new Map(),
    commitCache: new Map(),
    treeCache: new Map(),
    refAncestors: new Map(),
    tagShas: new Set(),
    uploadV0Adv: null,
    receiveV0Adv: null,
    lsRefsCache: new Map(),
  };
  store.repos.set(name, repo);
  return repo;
}

export function deleteRepo(store: Store, name: string): boolean {
  return store.repos.delete(name);
}

// ---------------------------------------------------------------------------
// Git object helpers
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp < 0) break;
    const nul = data.indexOf(0x00, sp + 1);
    if (nul < 0) break;
    const mode = data.subarray(off, sp).toString("utf8");
    const name = data.subarray(sp + 1, nul).toString("utf8");
    const sha = data.subarray(nul + 1, nul + 21).toString("hex");
    entries.push({ mode, name, sha });
    off = nul + 21;
  }
  return entries;
}

function treeSortKey(e: TreeEntry): string {
  return e.mode === "40000" ? `${e.name}/` : e.name;
}

export function serializeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) =>
    treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0,
  );
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, "utf8"));
    parts.push(Buffer.from(e.sha, "hex"));
  }
  return Buffer.concat(parts);
}

export function storeObject(repo: Repo, type: ObjType, data: Buffer): string {
  const sha = hashObject(type, data);
  if (!repo.objects.has(sha)) {
    repo.objects.set(sha, { type, data });
    if (type === "tag") repo.tagShas.add(sha);
  }
  return sha;
}

// Store an object whose sha is already known (e.g. parsed out of a packfile):
// no re-hash, just insert-if-absent and keep the tag set current.
export function putObject(repo: Repo, type: ObjType, data: Buffer, sha: string): void {
  if (repo.objects.has(sha)) return;
  repo.objects.set(sha, { type, data });
  if (type === "tag") repo.tagShas.add(sha);
}

export function getObject(repo: Repo, sha: string): GitObject | undefined {
  return repo.objects.get(sha);
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString("utf8");
  const headEnd = text.indexOf("\n\n");
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : "";
  const parents: string[] = [];
  let tree = "";
  let author = "";
  let committer = "";
  for (const line of head.split("\n")) {
    if (line.startsWith("tree ")) tree = line.slice(5).trim();
    else if (line.startsWith("parent ")) parents.push(line.slice(7).trim());
    else if (line.startsWith("author ")) author = line.slice(7);
    else if (line.startsWith("committer ")) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function serializeCommit(info: CommitInfo): Buffer {
  const lines: string[] = [`tree ${info.tree}`];
  for (const p of info.parents) lines.push(`parent ${p}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  return Buffer.from(`${lines.join("\n")}\n\n${info.message}`, "utf8");
}

// Cached commit/tree parsing: objects are immutable once stored, so a commit
// or tree parsed once never needs re-parsing. Returns null when the object
// is missing or of another type.
export function commitInfo(repo: Repo, sha: string): CommitInfo | null {
  const cached = repo.commitCache.get(sha);
  if (cached) return cached;
  const obj = getObject(repo, sha);
  if (!obj || obj.type !== "commit") return null;
  const info = parseCommit(obj.data);
  repo.commitCache.set(sha, info);
  return info;
}

export function treeEntries(repo: Repo, sha: string): TreeEntry[] | null {
  const cached = repo.treeCache.get(sha);
  if (cached) return cached;
  const obj = getObject(repo, sha);
  if (!obj || obj.type !== "tree") return null;
  const entries = parseTree(obj.data);
  repo.treeCache.set(sha, entries);
  return entries;
}

export function gitActor(store: Store): string {
  const epoch = store.clock.nextEpoch();
  return `${store.login} <${store.login}@users.noreply.github.com> ${epoch} +0000`;
}

export function createCommit(
  store: Store,
  repo: Repo,
  treeSha: string,
  parents: string[],
  message: string,
): string {
  const actor = gitActor(store);
  const data = serializeCommit({ tree: treeSha, parents, author: actor, committer: actor, message });
  return storeObject(repo, "commit", data);
}

// Build a new root tree by writing one file (blobSha) at path over the tree of
// baseCommitSha (or an empty tree when null). Returns the new root tree sha.
export function treeWithFile(
  repo: Repo,
  baseCommitSha: string | null,
  path: string,
  blobSha: string,
): string {
  const parts = path.split("/").filter((p) => p.length > 0);
  const baseTreeSha = baseCommitSha ? commitInfo(repo, baseCommitSha)!.tree : null;
  const recurse = (treeSha: string | null, depth: number): string => {
    const entries = treeSha ? treeEntries(repo, treeSha)! : [];
    const name = parts[depth];
    if (depth === parts.length - 1) {
      const next = entries.filter((e) => e.name !== name);
      next.push({ mode: "100644", name, sha: blobSha });
      return storeObject(repo, "tree", serializeTree(next));
    }
    const existing = entries.find((e) => e.name === name);
    const childSha = recurse(existing ? existing.sha : null, depth + 1);
    const next = entries.filter((e) => e.name !== name);
    next.push({ mode: "40000", name, sha: childSha });
    return storeObject(repo, "tree", serializeTree(next));
  };
  return recurse(baseTreeSha, 0);
}

// Remove one file at path from the tree of baseCommitSha. Returns the new root
// tree sha, or null when the path does not exist.
export function treeWithoutFile(
  repo: Repo,
  baseCommitSha: string,
  path: string,
): string | null {
  const parts = path.split("/").filter((p) => p.length > 0);
  const baseTreeSha = commitInfo(repo, baseCommitSha)!.tree;
  const recurse = (treeSha: string, depth: number): string | null => {
    const entries = treeEntries(repo, treeSha)!;
    const name = parts[depth];
    if (depth === parts.length - 1) {
      const found = entries.some((e) => e.name === name);
      if (!found) return null;
      const next = entries.filter((e) => e.name !== name);
      return storeObject(repo, "tree", serializeTree(next));
    }
    const existing = entries.find((e) => e.name === name && e.mode === "40000");
    if (!existing) return null;
    const child = recurse(existing.sha, depth + 1);
    if (child === null) return null;
    const next = entries.filter((e) => e.name !== name);
    // Keep the directory even when it becomes empty; git prunes it on commit,
    // but an empty tree entry is harmless for our checks.
    next.push({ mode: "40000", name, sha: child });
    return storeObject(repo, "tree", serializeTree(next));
  };
  const out = recurse(baseTreeSha, 0);
  return out;
}

// Flat map of path -> {mode, sha} for the tree at commitSha (recursive).
export function flatTree(
  repo: Repo,
  commitSha: string | null,
): Map<string, { mode: string; sha: string }> {
  const out = new Map<string, { mode: string; sha: string }>();
  if (!commitSha) return out;
  const info = commitInfo(repo, commitSha);
  if (!info) return out;
  const walk = (treeSha: string, prefix: string): void => {
    const entries = treeEntries(repo, treeSha);
    if (!entries) return;
    for (const e of entries) {
      const p = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === "40000") walk(e.sha, p);
      else out.set(p, { mode: e.mode, sha: e.sha });
    }
  };
  walk(info.tree, "");
  return out;
}

// Build nested trees from a flat path map. Returns the root tree sha.
export function treeFromFlat(repo: Repo, flat: Map<string, { mode: string; sha: string }>): string {
  interface Node {
    files: Map<string, { mode: string; sha: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, v] of flat) {
    const parts = path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let child = node.dirs.get(parts[i]);
      if (!child) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(parts[i], child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1], v);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, v] of node.files) entries.push({ mode: v.mode, name, sha: v.sha });
    for (const [name, child] of node.dirs) entries.push({ mode: "40000", name, sha: build(child) });
    return storeObject(repo, "tree", serializeTree(entries));
  };
  return build(root);
}

export function getFileAt(
  repo: Repo,
  commitSha: string,
  path: string,
): { blobSha: string; data: Buffer } | null {
  const flat = flatTree(repo, commitSha);
  const hit = flat.get(path);
  if (!hit) return null;
  const obj = getObject(repo, hit.sha);
  if (!obj || obj.type !== "blob") return null;
  return { blobSha: hit.sha, data: obj.data };
}

export function ancestors(repo: Repo, tip: string): Set<string> {
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const info = commitInfo(repo, sha);
    if (!info) continue;
    for (const p of info.parents) stack.push(p);
  }
  return seen;
}

export function isAncestor(repo: Repo, anc: string, desc: string): boolean {
  if (anc === desc) return true;
  return ancestors(repo, desc).has(anc);
}

// Nearest common ancestor of a and b (by commit depth, BFS from both sides).
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  if (a === b) return a;
  const aAnc = ancestors(repo, a);
  if (aAnc.has(b)) return b;
  const bAnc = ancestors(repo, b);
  if (bAnc.has(a)) return a;
  // BFS from b upward, first commit that is also an ancestor of a.
  const queue: string[] = [b];
  const seen = new Set<string>([b]);
  for (let qi = 0; qi < queue.length; qi++) {
    const sha = queue[qi];
    const info = commitInfo(repo, sha);
    if (!info) continue;
    for (const p of info.parents) {
      if (aAnc.has(p)) return p;
      if (!seen.has(p)) {
        seen.add(p);
        queue.push(p);
      }
    }
  }
  return null;
}

export function refName(branch: string): string {
  return `refs/heads/${branch}`;
}

export function branchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(refName(branch)) ?? null;
}

// Every ref change invalidates the caches derived from refs: packfiles,
// both v0 advertisements, and cached ls-refs responses.
export function invalidateRefCaches(repo: Repo): void {
  repo.packCache.clear();
  repo.uploadV0Adv = null;
  repo.receiveV0Adv = null;
  repo.lsRefsCache.clear();
}

// Walk the ancestors of tip, stopping at commits already in base: their
// ancestors are already in base (it is ancestor-closed), so they add nothing
// new. Returns the visited commits plus whether oldTip was reached.
function walkNewAncestors(
  repo: Repo,
  tip: string,
  base: Set<string>,
  oldTip: string | undefined,
): { added: Set<string>; sawOld: boolean } {
  const added = new Set<string>();
  const stack = [tip];
  let sawOld = tip === oldTip;
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (added.has(sha)) continue;
    added.add(sha);
    if (sha === oldTip) {
      sawOld = true;
      continue;
    }
    if (base.has(sha)) continue;
    const info = commitInfo(repo, sha);
    if (!info) continue;
    for (const p of info.parents) stack.push(p);
  }
  return { added, sawOld };
}

// Move a ref to a new tip, maintaining its ancestor set incrementally and
// invalidating the ref-derived caches. All ref writes go through here (or
// deleteRef) so the caches and ancestor sets cannot drift from refs.
// Fast-forward moves (the common case: the old tip is an ancestor of the new
// one) cost only the walk over the new commits; any other move recomputes
// the set from scratch so the invariant refAncestors[ref] == ancestors(tip)
// stays exact.
export function setRef(repo: Repo, ref: string, sha: string): void {
  const oldTip = repo.refs.get(ref);
  let base = repo.refAncestors.get(ref);
  if (!base && oldTip) base = ancestors(repo, oldTip);
  let next: Set<string>;
  if (!base || base.size === 0) {
    next = ancestors(repo, sha);
  } else {
    const { added, sawOld } = walkNewAncestors(repo, sha, base, oldTip);
    if (sawOld) {
      next = new Set([...base, ...added]);
    } else {
      next = ancestors(repo, sha);
    }
  }
  repo.refs.set(ref, sha);
  repo.refAncestors.set(ref, next);
  invalidateRefCaches(repo);
}

export function deleteRef(repo: Repo, ref: string): void {
  repo.refs.delete(ref);
  repo.refAncestors.delete(ref);
  invalidateRefCaches(repo);
}

// Fast-forward check for a push to ref: is oldSha an ancestor of newSha?
// Walks from newSha only, pruning at commits already known to be ancestors
// of the ref's current tip: such a commit's ancestors are all in that set,
// and oldSha is not among them unless the commit IS oldSha (a commit in the
// set other than oldSha is a strict ancestor of oldSha, so oldSha cannot be
// reached through it). Falls back to the full walk when no set is tracked.
export function isFastForward(repo: Repo, ref: string, oldSha: string, newSha: string): boolean {
  if (oldSha === newSha) return true;
  const known = repo.refAncestors.get(ref);
  if (!known) return isAncestor(repo, oldSha, newSha);
  const stack = [newSha];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (sha === oldSha) return true;
    if (seen.has(sha)) continue;
    seen.add(sha);
    if (known.has(sha)) continue;
    const info = commitInfo(repo, sha);
    if (!info) continue;
    for (const p of info.parents) stack.push(p);
  }
  return false;
}

// Squash-merge pr into its base branch. Returns the new commit sha, or null
// when the merge conflicts. Caller checks the PR state first.
// The current tip of the PR's base branch. pr.baseSha is the tip recorded
// when the PR was created; the branch may have moved since (e.g. another PR
// merged first), and a merge must be attempted against the live tip, or a
// conflict the second merge should hit is silently missed.
export function prBaseTip(repo: Repo, pr: PullRequest): string {
  return repo.refs.get(refName(pr.baseRef)) ?? pr.baseSha;
}

export function squashMerge(
  store: Store,
  repo: Repo,
  pr: PullRequest,
): { sha: string } | { conflict: true } {
  const headTip = pr.headSha;
  const baseTip = prBaseTip(repo, pr);
  const base = mergeBase(repo, headTip, baseTip);
  const baseFlat = flatTree(repo, base);
  const headFlat = flatTree(repo, headTip);
  const tipFlat = flatTree(repo, baseTip);
  const merged = new Map<string, { mode: string; sha: string }>();
  const allPaths = new Set<string>([...baseFlat.keys(), ...headFlat.keys(), ...tipFlat.keys()]);
  for (const path of allPaths) {
    const b = baseFlat.get(path);
    const h = headFlat.get(path);
    const t = tipFlat.get(path);
    const same = (
      x: { mode: string; sha: string } | undefined,
      y: { mode: string; sha: string } | undefined,
    ): boolean => (x === undefined && y === undefined) || (x !== undefined && y !== undefined && x.sha === y.sha);
    if (same(h, b)) {
      if (t) merged.set(path, t);
    } else if (same(t, b)) {
      if (h) merged.set(path, h);
    } else if (same(h, t)) {
      if (t) merged.set(path, t);
    } else {
      return { conflict: true };
    }
  }
  const treeSha = treeFromFlat(repo, merged);
  const message = `${pr.title} (#${pr.number})\n\n${pr.body}`.trimEnd();
  const sha = createCommit(store, repo, treeSha, baseTip ? [baseTip] : [], message);
  setRef(repo, refName(pr.baseRef), sha);
  return { sha };
}

export function prMergeable(repo: Repo, pr: PullRequest): boolean {
  const headTip = pr.headSha;
  const baseTip = prBaseTip(repo, pr);
  const base = mergeBase(repo, headTip, baseTip);
  const baseFlat = flatTree(repo, base);
  const headFlat = flatTree(repo, headTip);
  const tipFlat = flatTree(repo, baseTip);
  const allPaths = new Set<string>([...baseFlat.keys(), ...headFlat.keys(), ...tipFlat.keys()]);
  for (const path of allPaths) {
    const b = baseFlat.get(path);
    const h = headFlat.get(path);
    const t = tipFlat.get(path);
    const same = (
      x: { mode: string; sha: string } | undefined,
      y: { mode: string; sha: string } | undefined,
    ): boolean => (x === undefined && y === undefined) || (x !== undefined && y !== undefined && x.sha === y.sha);
    if (same(h, b) || same(t, b) || same(h, t)) continue;
    return false;
  }
  return true;
}

// Files changed between base and head (for the PR files list).
export function prChangedFiles(repo: Repo, pr: PullRequest): string[] {
  const baseFlat = flatTree(repo, pr.baseSha);
  const headFlat = flatTree(repo, pr.headSha);
  const out: string[] = [];
  const allPaths = new Set<string>([...baseFlat.keys(), ...headFlat.keys()]);
  for (const path of allPaths) {
    const b = baseFlat.get(path);
    const h = headFlat.get(path);
    if (!b || !h || b.sha !== h.sha) out.push(path);
  }
  return out.sort();
}
