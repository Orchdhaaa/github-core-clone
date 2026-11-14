// The forge's whole state: repositories, git objects, issues and pull
// requests, all in memory. One Store instance serves every surface, so a
// repository created over MCP reads back over REST with the same ids.
//
// Determinism: every timestamp comes from MAKEFUN_TRIAL_NOW (parsed once
// here) and every ordering counter is a plain increment. No wall clock and
// no randomness anywhere in this module.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  mergeBase,
  parseCommit,
  parseTag,
  parseTree,
  type GitObj,
  type ObjType,
  type TreeEntry,
} from './git.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const VIEWER_ID = 1000;
export const DEFAULT_BRANCH = 'main';

/** Parse an ISO instant the trial hands us into epoch seconds, without a clock. */
function epochOf(iso: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(iso);
  if (match === null) return 1_769_900_400;
  const parts = match.slice(1).map((piece) => Number(piece));
  return Math.floor(
    Date.UTC(parts[0] as number, (parts[1] as number) - 1, parts[2] as number, parts[3] as number, parts[4] as number, parts[5] as number) / 1000,
  );
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
  seq: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  seq: number;
  closedAt: string | null;
  /** Cached serialised view; cleared whenever the issue changes. */
  viewBuf: Buffer | null;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  seq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  priv: boolean;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  refs: Map<string, string>;
  objects: Map<string, GitObj>;
  nextIssue: number;
  nextPull: number;
  seq: number;
  /** Bumped on every ref or object change; caches key off it. */
  version: number;
  packCache: Map<string, { pack: Buffer; shallow: string[]; unshallow: string[] }>;
  adCache: Map<string, Buffer>;
}

export interface UserView {
  login: string;
  id: number;
  node_id: string;
  avatar_url: string;
  type: string;
  name: string;
  email: string;
}

export function gid(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64url');
}

export function ungid(value: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(value, 'base64url').toString('utf8');
    const split = text.split(':');
    if (split.length < 2) return null;
    return { kind: split[0] as string, parts: split.slice(1) };
  } catch {
    return null;
  }
}

export class Store {
  readonly token: string;
  readonly nowIso: string;
  readonly nowEpoch: number;
  readonly repos = new Map<string, Repo>();
  private repoSeq = 0;
  private objectSeq = 0;
  private requestSeq = 0;
  private commitSeq = new Map<string, number>();

  constructor() {
    this.token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
    const now = process.env.MAKEFUN_TRIAL_NOW ?? '2026-11-14T06:00:00Z';
    this.nowIso = now;
    this.nowEpoch = epochOf(now);
  }

  nextRequestId(): string {
    this.requestSeq += 1;
    return `req-${this.requestSeq}`;
  }

  nextCommentId(): number {
    this.objectSeq += 1;
    return this.objectSeq;
  }

  userView(): UserView {
    return {
      login: VIEWER_LOGIN,
      id: VIEWER_ID,
      node_id: gid('U', VIEWER_ID),
      avatar_url: '',
      type: 'User',
      name: VIEWER_NAME,
      email: VIEWER_EMAIL,
    };
  }

  authorLine(): string {
    this.objectSeq += 1;
    const stamp = this.nowEpoch + this.objectSeq;
    return `${VIEWER_NAME} <${VIEWER_EMAIL}> ${stamp} +0000`;
  }

  // ------------------------------------------------------------ repositories

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(name: string, description: string, priv: boolean): Repo {
    const key = this.repoKey(VIEWER_LOGIN, name);
    const existing = this.repos.get(key);
    if (existing !== undefined) throw new ApiError(422, 'Repository already exists');
    this.repoSeq += 1;
    const repo: Repo = {
      id: this.repoSeq,
      name,
      owner: VIEWER_LOGIN,
      description,
      priv,
      labels: new Map(),
      issues: [],
      pulls: [],
      refs: new Map(),
      objects: new Map(),
      nextIssue: 1,
      nextPull: 1,
      seq: this.repoSeq,
      version: 0,
      packCache: new Map(),
      adCache: new Map(),
    };
    this.repos.set(key, repo);
    return repo;
  }

  /** A repository only when `owner` is the token's login and the name exists. */
  lookupRepo(owner: string, name: string): Repo {
    if (owner !== VIEWER_LOGIN) throw new ApiError(404, 'Not Found');
    const repo = this.repos.get(this.repoKey(owner, name));
    if (repo === undefined) throw new ApiError(404, 'Not Found');
    return repo;
  }

  findRepoById(id: number): Repo | undefined {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return undefined;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.repoKey(repo.owner, repo.name));
  }

  listRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === VIEWER_LOGIN) out.push(repo);
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  repoView(repo: Repo): Record<string, unknown> {
    return {
      id: repo.id,
      node_id: gid('R', repo.id),
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: {
        login: repo.owner,
        id: VIEWER_ID,
        node_id: gid('U', VIEWER_ID),
        avatar_url: '',
        type: 'User',
      },
      private: repo.priv,
      description: repo.description,
      default_branch: DEFAULT_BRANCH,
      html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
      url: `/api/v3/repos/${repo.owner}/${repo.name}`,
      created_at: this.nowIso,
      updated_at: this.nowIso,
      pushed_at: this.nowIso,
      has_issues: true,
      has_projects: true,
      has_wiki: true,
      forks_count: 0,
      open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
      watchers_count: 0,
      license: null,
      visibility: repo.priv ? 'private' : 'public',
      fork: false,
    };
  }

  // ------------------------------------------------------------ git objects

  putObject(repo: Repo, type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, { type, data });
      if (type === 'commit') this.commitSeq.set(oid, this.objectSeq + 1);
      repo.version += 1;
      repo.packCache.clear();
      repo.adCache.clear();
    }
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObj | undefined {
    return repo.objects.get(oid);
  }

  lookupObject(repo: Repo, oid: string): GitObj | undefined {
    return repo.objects.get(oid);
  }

  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  setRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
    repo.version += 1;
    repo.packCache.clear();
    repo.adCache.clear();
  }

  deleteRef(repo: Repo, ref: string): void {
    repo.refs.delete(ref);
    repo.version += 1;
    repo.packCache.clear();
    repo.adCache.clear();
  }

  /** Peel an annotated tag to its commit, following tag objects. */
  peel(repo: Repo, oid: string): string {
    let current = oid;
    for (let hops = 0; hops < 8; hops += 1) {
      const obj = repo.objects.get(current);
      if (obj === undefined || obj.type !== 'tag') return current;
      const text = obj.data.toString('utf8');
      const match = /^object ([0-9a-f]{40})$/m.exec(text);
      if (match === null) return current;
      current = match[1] as string;
    }
    return current;
  }

  /** A ref's oid plus its peeled target when it points at a tag object. */
  refPeel(repo: Repo, ref: string): { oid: string; peeled?: string } | undefined {
    const oid = repo.refs.get(ref);
    if (oid === undefined) return undefined;
    const obj = repo.objects.get(oid);
    if (obj !== undefined && obj.type === 'tag') return { oid, peeled: this.peel(repo, oid) };
    return { oid };
  }

  // ------------------------------------------------------------ trees

  /** Flatten a tree into path -> {oid, mode}, walking subtrees. */
  flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, base: string): void => {
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'tree') return;
      for (const entry of parseTree(obj.data)) {
        const path = base === '' ? entry.name : `${base}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, prefix);
    return out;
  }

  /** Build (and store) a tree from a flat path map, returning its oid. */
  treeFromFlat(repo: Repo, flat: Map<string, { oid: string; mode: string }>): string {
    const build = (paths: { path: string; oid: string; mode: string }[]): string => {
      const groups = new Map<string, { path: string; oid: string; mode: string }[]>();
      const files: TreeEntry[] = [];
      for (const entry of paths) {
        const slash = entry.path.indexOf('/');
        if (slash < 0) {
          files.push({ mode: entry.mode, name: entry.path, oid: entry.oid });
        } else {
          const dir = entry.path.slice(0, slash);
          const rest = entry.path.slice(slash + 1);
          const list = groups.get(dir) ?? [];
          list.push({ path: rest, oid: entry.oid, mode: entry.mode });
          groups.set(dir, list);
        }
      }
      const entries: TreeEntry[] = [...files];
      for (const [dir, list] of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        entries.push({ mode: '40000', name: dir, oid: build(list) });
      }
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    const paths = [...flat.entries()].map(([path, value]) => ({ path, oid: value.oid, mode: value.mode }));
    if (paths.length === 0) return this.putObject(repo, 'tree', buildTree([]));
    return build(paths);
  }

  /** Store a commit object and return its oid. */
  makeCommit(repo: Repo, treeOid: string, parents: readonly string[], message: string): string {
    const who = this.authorLine();
    const text = message.endsWith('\n') ? message : `${message}\n`;
    const data = buildCommit({ tree: treeOid, parents, author: who, committer: who, message: text });
    return this.putObject(repo, 'commit', data);
  }

  /**
   * Commit one file change on `branch`: `content` null deletes the path.
   * A missing branch is created from the default branch's tip (or empty).
   */
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer | null,
    message: string,
  ): { commitSha: string; contentSha: string | null } {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`);
    let flat = new Map<string, { oid: string; mode: string }>();
    const parents: string[] = [];
    if (tip !== undefined) {
      const commit = repo.objects.get(tip);
      if (commit !== undefined && commit.type === 'commit') {
        flat = this.flattenTree(repo, parseCommit(commit.data).tree);
        parents.push(tip);
      }
    }
    let contentSha: string | null = null;
    if (content === null) {
      flat.delete(path);
    } else {
      contentSha = this.putObject(repo, 'blob', content);
      flat.set(path, { oid: contentSha, mode: '100644' });
    }
    const treeOid = this.treeFromFlat(repo, flat);
    const commitSha = this.makeCommit(repo, treeOid, parents, message);
    this.setRef(repo, ref, commitSha);
    return { commitSha, contentSha };
  }

  /** The file's blob at a ref tip, or undefined when the path is absent. */
  fileAt(repo: Repo, refName: string, path: string): { oid: string; data: Buffer } | undefined {
    const tip = repo.refs.get(`refs/heads/${refName}`);
    if (tip === undefined) return undefined;
    const commit = repo.objects.get(tip);
    if (commit === undefined || commit.type !== 'commit') return undefined;
    const flat = this.flattenTree(repo, parseCommit(commit.data).tree);
    const entry = flat.get(path);
    if (entry === undefined) return undefined;
    const blob = repo.objects.get(entry.oid);
    if (blob === undefined) return undefined;
    return { oid: entry.oid, data: blob.data };
  }

  /** Commits reachable from a ref, newest first (depth-first, parents in order). */
  commitsFrom(repo: Repo, refName: string): { sha: string; message: string; tree: string; parents: string[] }[] {
    const tip = repo.refs.get(`refs/heads/${refName}`) ?? repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`);
    if (tip === undefined) return [];
    const out: { sha: string; message: string; tree: string; parents: string[] }[] = [];
    const seen = new Set<string>();
    const walk = (oid: string): void => {
      if (seen.has(oid)) return;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') return;
      const view = parseCommit(obj.data);
      out.push({ sha: oid, message: view.message.replace(/\n$/, ''), tree: view.tree, parents: view.parents });
      for (const parent of view.parents) walk(parent);
    };
    walk(tip);
    return out;
  }

  // ------------------------------------------------------------ issues

  createIssue(repo: Repo, title: string, body: string, labelNames: readonly string[]): Issue {
    for (const name of labelNames) {
      if (!repo.labels.has(name)) throw new ApiError(422, `Label does not exist: ${name}`);
    }
    const number = repo.nextIssue;
    repo.nextIssue += 1;
    this.objectSeq += 1;
    const issue: Issue = {
      id: this.objectSeq,
      number,
      title,
      body,
      state: 'open',
      labels: [...labelNames],
      comments: [],
      seq: this.objectSeq,
      closedAt: null,
      viewBuf: null,
    };
    repo.issues.push(issue);
    return issue;
  }

  findIssue(repo: Repo, number: number): Issue {
    const issue = repo.issues.find((entry) => entry.number === number);
    if (issue === undefined) throw new ApiError(404, 'Not Found');
    return issue;
  }

  issueView(repo: Repo, issue: Issue): Record<string, unknown> {
    return {
      id: issue.id,
      node_id: gid('I', repo.id, issue.number),
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((name) => {
        const label = repo.labels.get(name);
        return { name, color: label?.color ?? 'ededed', description: '', default: false };
      }),
      user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
      created_at: this.nowIso,
      updated_at: this.nowIso,
      closed_at: issue.closedAt,
      comments: issue.comments.length,
      html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
      assignees: [],
      milestone: null,
      locked: false,
    };
  }

  /** The serialised issue view, cached until the issue changes. */
  issueJson(repo: Repo, issue: Issue): Buffer {
    if (issue.viewBuf === null) {
      issue.viewBuf = Buffer.from(JSON.stringify(this.issueView(repo, issue)), 'utf8');
    }
    return issue.viewBuf;
  }

  // ------------------------------------------------------------ pull requests

  createPull(repo: Repo, title: string, body: string, head: string, base: string): Pull {
    const headRef = head.includes(':') ? (head.split(':').pop() as string) : head;
    const baseRef = base.includes(':') ? (base.split(':').pop() as string) : base;
    const headTip = repo.refs.get(`refs/heads/${headRef}`);
    if (headTip === undefined) throw new ApiError(422, `Head branch does not exist: ${headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${baseRef}`);
    if (baseTip === undefined) throw new ApiError(422, `Base branch does not exist: ${baseRef}`);
    for (const existing of repo.pulls) {
      if (existing.head === headRef && existing.base === baseRef && existing.state === 'open') {
        throw new ApiError(422, 'A pull request already exists for this head branch');
      }
    }
    const number = repo.nextPull;
    repo.nextPull += 1;
    this.objectSeq += 1;
    const pull: Pull = {
      id: this.objectSeq,
      number,
      title,
      body,
      state: 'open',
      head: headRef,
      base: baseRef,
      merged: false,
      mergedAt: null,
      mergeSha: null,
      seq: this.objectSeq,
    };
    repo.pulls.push(pull);
    return pull;
  }

  findPull(repo: Repo, number: number): Pull {
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (pull === undefined) throw new ApiError(404, 'Not Found');
    return pull;
  }

  /** Paths changed between the head tip and the base tip, with line counts. */
  pullFiles(repo: Repo, pull: Pull): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
    const headTip = repo.refs.get(`refs/heads/${pull.head}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
    const headFlat = headTip === undefined ? new Map() : this.flattenTree(repo, this.tipTree(repo, headTip));
    const baseFlat = baseTip === undefined ? new Map() : this.flattenTree(repo, this.tipTree(repo, baseTip));
    const out: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
    const paths = new Set([...headFlat.keys(), ...baseFlat.keys()]);
    for (const path of [...paths].sort()) {
      const headEntry = headFlat.get(path);
      const baseEntry = baseFlat.get(path);
      if (headEntry !== undefined && baseEntry === undefined) {
        const lines = this.countLines(repo, headEntry.oid);
        out.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
      } else if (headEntry === undefined && baseEntry !== undefined) {
        const lines = this.countLines(repo, baseEntry.oid);
        out.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines });
      } else if (headEntry !== undefined && baseEntry !== undefined && headEntry.oid !== baseEntry.oid) {
        const add = this.countLines(repo, headEntry.oid);
        const del = this.countLines(repo, baseEntry.oid);
        out.push({ filename: path, status: 'modified', additions: add, deletions: del, changes: add + del });
      }
    }
    return out;
  }

  private tipTree(repo: Repo, tip: string): string {
    const commit = repo.objects.get(tip);
    if (commit === undefined || commit.type !== 'commit') return ZERO_OID;
    return parseCommit(commit.data).tree;
  }

  private countLines(repo: Repo, oid: string): number {
    const obj = repo.objects.get(oid);
    if (obj === undefined) return 0;
    const text = obj.data.toString('utf8');
    if (text === '') return 0;
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  }

  /** 'MERGEABLE' / 'CONFLICTING' for an open pull request, by 3-way file check. */
  mergeableOf(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.state !== 'open') return 'UNKNOWN';
    const headTip = repo.refs.get(`refs/heads/${pull.head}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
    if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
    return this.conflictPaths(repo, pull).length === 0 ? 'MERGEABLE' : 'CONFLICTING';
  }

  /** Paths changed on both sides of the merge base with different results. */
  conflictPaths(repo: Repo, pull: Pull): string[] {
    const headTip = repo.refs.get(`refs/heads/${pull.head}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
    if (headTip === undefined || baseTip === undefined) return [];
    const base = mergeBase(headTip, baseTip, (oid) => repo.objects.get(oid));
    if (base === null) return [];
    const baseFlat = this.flattenTree(repo, this.tipTree(repo, base));
    const headFlat = this.flattenTree(repo, this.tipTree(repo, headTip));
    const tipFlat = this.flattenTree(repo, this.tipTree(repo, baseTip));
    const conflicts: string[] = [];
    const paths = new Set([...headFlat.keys(), ...tipFlat.keys(), ...baseFlat.keys()]);
    for (const path of paths) {
      const b = baseFlat.get(path)?.oid;
      const h = headFlat.get(path)?.oid;
      const t = tipFlat.get(path)?.oid;
      const headChanged = h !== b;
      const tipChanged = t !== b;
      if (headChanged && tipChanged && h !== t) conflicts.push(path);
    }
    return conflicts;
  }

  /** Squash-merge an open pull request onto its base branch. */
  mergePull(repo: Repo, pull: Pull): { sha: string; message: string } {
    if (pull.state !== 'open') throw new ApiError(405, 'Pull request is not open');
    const headTip = repo.refs.get(`refs/heads/${pull.head}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
    if (headTip === undefined || baseTip === undefined) throw new ApiError(405, 'Pull request cannot be merged');
    if (this.conflictPaths(repo, pull).length > 0) throw new ApiError(405, 'Merge conflict');
    const base = mergeBase(headTip, baseTip, (oid) => repo.objects.get(oid));
    const baseFlat = base === null ? new Map() : this.flattenTree(repo, this.tipTree(repo, base));
    const headFlat = this.flattenTree(repo, this.tipTree(repo, headTip));
    const tipFlat = this.flattenTree(repo, this.tipTree(repo, baseTip));
    const result = new Map(tipFlat);
    for (const [path, entry] of headFlat) {
      if (baseFlat.get(path)?.oid !== entry.oid) result.set(path, entry);
    }
    for (const path of baseFlat.keys()) {
      if (!headFlat.has(path) && baseFlat.has(path)) result.delete(path);
    }
    const treeOid = this.treeFromFlat(repo, result);
    const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.head}\n\n${pull.title}`;
    const sha = this.makeCommit(repo, treeOid, [baseTip], message);
    this.setRef(repo, `refs/heads/${pull.base}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.nowIso;
    pull.mergeSha = sha;
    return { sha, message };
  }

  pullView(repo: Repo, pull: Pull): Record<string, unknown> {
    const headSha = repo.refs.get(`refs/heads/${pull.head}`) ?? ZERO_OID;
    const baseSha = repo.refs.get(`refs/heads/${pull.base}`) ?? ZERO_OID;
    return {
      id: pull.id,
      node_id: gid('P', repo.id, pull.number),
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      head: { ref: pull.head, sha: headSha, label: `${repo.owner}:${pull.head}` },
      base: { ref: pull.base, sha: baseSha, label: `${repo.owner}:${pull.base}` },
      merged: pull.merged,
      mergeable: pull.state === 'open' ? this.mergeableOf(repo, pull) === 'MERGEABLE' : false,
      merge_commit_sha: pull.mergeSha,
      merged_at: pull.mergedAt,
      created_at: this.nowIso,
      updated_at: this.nowIso,
      closed_at: pull.state === 'closed' ? this.nowIso : null,
      user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
      html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    };
  }

  // ------------------------------------------------------------ git helpers

  /** Objects to send for `wants`, minus everything reachable from `haves`. */
  objectsForFetch(
    repo: Repo,
    wants: readonly string[],
    haves: readonly string[],
    depth?: number,
    clientShallow: readonly string[] = [],
  ): { objects: GitObj[]; shallow: string[]; unshallow: string[] } {
    const haveClosure = new Set<string>();
    const shallowSet = new Set(clientShallow);
    // Walk from the haves, but never past a commit the client holds as a
    // shallow boundary: it has that commit, not its parents.
    const haveQueue: string[] = [...haves];
    const haveSeen = new Set<string>();
    while (haveQueue.length > 0) {
      const oid = haveQueue.shift() as string;
      if (haveSeen.has(oid)) continue;
      haveSeen.add(oid);
      const obj = repo.objects.get(oid);
      if (obj === undefined) continue;
      haveClosure.add(oid);
      if (obj.type === 'commit') {
        const view = parseCommit(obj.data);
        try {
          for (const child of collectReachable([view.tree], (id) => repo.objects.get(id))) haveClosure.add(child);
        } catch {
          // A missing tree cannot happen for stored commits.
        }
        if (!shallowSet.has(oid)) {
          for (const parent of view.parents) haveQueue.push(parent);
        }
      } else if (obj.type === 'tag') {
        haveQueue.push(parseTag(obj.data).object);
      } else if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) haveQueue.push(entry.oid);
      }
    }
    const wanted = new Set<string>();
    const shallow: string[] = [];
    const fetchedDepth = new Map<string, number>();
    if (depth !== undefined) {
      // Breadth-first by generation from the wants; depth 1 is the wants themselves.
      const queue: { oid: string; depth: number }[] = wants.map((oid) => ({ oid, depth: 1 }));
      const seenCommits = new Set<string>();
      while (queue.length > 0) {
        const item = queue.shift() as { oid: string; depth: number };
        if (seenCommits.has(item.oid)) continue;
        seenCommits.add(item.oid);
        const obj = repo.objects.get(item.oid);
        if (obj === undefined || obj.type !== 'commit') continue;
        wanted.add(item.oid);
        fetchedDepth.set(item.oid, item.depth);
        if (item.depth >= depth) {
          shallow.push(item.oid);
          continue;
        }
        for (const parent of parseCommit(obj.data).parents) queue.push({ oid: parent, depth: item.depth + 1 });
      }
      for (const oid of wanted) {
        const obj = repo.objects.get(oid);
        if (obj === undefined || obj.type !== 'commit') continue;
        const tree = parseCommit(obj.data).tree;
        try {
          for (const child of collectReachable([tree], (id) => repo.objects.get(id))) wanted.add(child);
        } catch {
          // A missing tree cannot happen for stored commits.
        }
      }
    } else {
      for (const want of wants) {
        try {
          for (const oid of collectReachable([want], (oid) => repo.objects.get(oid))) wanted.add(oid);
        } catch {
          // An unknown want contributes nothing.
        }
      }
    }
    const objects: GitObj[] = [];
    for (const oid of wanted) {
      if (haveClosure.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (obj !== undefined) objects.push(obj);
    }
    // A boundary the client already held is unshallowed once it lies inside
    // the fetched depth (or inside a full fetch).
    const unshallow: string[] = [];
    for (const oid of clientShallow) {
      if (!wanted.has(oid)) continue;
      if (depth === undefined || (fetchedDepth.get(oid) ?? depth) < depth) unshallow.push(oid);
    }
    return { objects, shallow, unshallow };
  }
}
