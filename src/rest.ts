// REST v3: repositories, branches, commits, contents, labels, issues,
// comments and pull requests with squash merge. Every reply is JSON with an
// X-GitHub-Request-Id header; errors carry a string message.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError, DEFAULT_BRANCH, Store, VIEWER_LOGIN, type Repo } from './store.ts';
import { parseCommit, parseTree } from './git.ts';
import { isRecord, parseJsonBody, readBody, requireAuth, sendError, sendJson, sendRawJson, strField } from './http-util.ts';

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  store: Store;
  origin: string;
}

function originOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

/** Slice a list into one page and build a rel="next" Link header when needed. */
function paginate<T>(ctx: Ctx, items: readonly T[], path: string, query: URLSearchParams): { page: T[]; link: string } {
  const perPage = Math.max(1, Number(query.get('per_page') ?? '30') || 30);
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link = '';
  if (start + perPage < items.length) {
    const next = new URL(path, ctx.origin);
    next.searchParams.set('page', String(page + 1));
    next.searchParams.set('per_page', String(perPage));
    link = `<${next.toString()}>; rel="next"`;
  }
  return { page: slice, link };
}

function ok(ctx: Ctx, status: number, body: unknown, extra: Record<string, string> = {}): void {
  sendJson(ctx.res, ctx.store, status, body, extra);
}

function fail(ctx: Ctx, error: unknown): void {
  if (error instanceof ApiError) {
    sendError(ctx.res, ctx.store, error.status, error.message);
    return;
  }
  sendError(ctx.res, ctx.store, 500, 'Internal Server Error');
}

function branchList(repo: Repo): { name: string; commit: { sha: string }; protected: boolean }[] {
  const out: { name: string; commit: { sha: string }; protected: boolean }[] = [];
  for (const name of [...repo.refs.keys()].sort()) {
    if (!name.startsWith('refs/heads/')) continue;
    out.push({ name: name.slice('refs/heads/'.length), commit: { sha: repo.refs.get(name) as string }, protected: false });
  }
  return out;
}

function treeOidAtPath(repo: Repo, rootTree: string, dirPath: string): string | undefined {
  if (dirPath === '') return rootTree;
  const segments = dirPath.split('/').filter((part) => part !== '');
  let current = rootTree;
  for (const segment of segments) {
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'tree') return undefined;
    const entry = parseTree(obj.data).find((item) => item.name === segment && item.mode === '40000');
    if (entry === undefined) return undefined;
    current = entry.oid;
  }
  return current;
}

function dirEntries(repo: Repo, rootTree: string, dirPath: string): Record<string, unknown>[] | undefined {
  const oid = treeOidAtPath(repo, rootTree, dirPath);
  if (oid === undefined) return undefined;
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'tree') return undefined;
  const out: Record<string, unknown>[] = [];
  for (const entry of parseTree(obj.data)) {
    const path = dirPath === '' ? entry.name : `${dirPath}/${entry.name}`;
    if (entry.mode === '40000') {
      out.push({ type: 'dir', name: entry.name, path, sha: entry.oid, size: 0, url: '' });
    } else {
      const blob = repo.objects.get(entry.oid);
      out.push({
        type: 'file',
        name: entry.name,
        path,
        sha: entry.oid,
        size: blob === undefined ? 0 : blob.data.length,
        url: '',
      });
    }
  }
  return out;
}

function issueList(ctx: Ctx, repo: Repo, query: URLSearchParams): void {
  const state = query.get('state') ?? 'open';
  let issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
  const sort = query.get('sort') ?? 'created';
  const direction = query.get('direction') ?? 'desc';
  if (sort === 'created') {
    issues = [...issues].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  }
  const { page, link } = paginate(ctx, issues, ctx.req.url?.split('?')[0] ?? '', query);
  ok(ctx, 200, page.map((issue) => ctx.store.issueView(repo, issue)), link === '' ? {} : { link });
}

export async function handleRest(req: IncomingMessage, res: ServerResponse, store: Store, path: string): Promise<void> {
  const ctx: Ctx = { req, res, store, origin: originOf(req) };
  if (!requireAuth(req, res, store)) return;
  let cachedQuery: URLSearchParams | undefined;
  const queryParams = (): URLSearchParams => {
    if (cachedQuery === undefined) cachedQuery = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
    return cachedQuery;
  };
  const method = req.method ?? 'GET';
  try {
    const body = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE'
      ? await readBody(req)
      : Buffer.alloc(0);
    const parsed = body.length > 0 ? parseJsonBody(res, store, body) : {};
    if (body.length > 0 && parsed === null) return;
    const json = (isRecord(parsed) ? parsed : {}) as Record<string, unknown>;

    // ------------------------------------------------------------ root / meta / user
    if (path === '/api/v3/' || path === '/api/v3') {
      ok(ctx, 200, { current_user_url: `${ctx.origin}/api/v3/user` }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }
    if (path === '/api/v3/meta' && method === 'GET') {
      ok(ctx, 200, { installed_version: '1.0.0' });
      return;
    }
    if (path === '/api/v3/user' && method === 'GET') {
      ok(ctx, 200, store.userView());
      return;
    }
    if (path === '/api/v3/user/repos') {
      if (method === 'GET') {
        const repos = store.listRepos();
        const { page, link } = paginate(ctx, repos, path, queryParams());
        ok(ctx, 200, page.map((repo) => store.repoView(repo)), link === '' ? {} : { link });
        return;
      }
      if (method === 'POST') {
        const name = strField(json, 'name');
        if (name === '') {
          sendError(res, store, 422, 'Repository name is required');
          return;
        }
        const repo = store.createRepo(name, strField(json, 'description'), json['private'] === true);
        ok(ctx, 201, store.repoView(repo));
        return;
      }
    }

    // ------------------------------------------------------------ repo-scoped routes
    const repoMatch = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)(.*)$/.exec(path);
    if (repoMatch === null) {
      sendError(res, store, 404, 'Not Found');
      return;
    }
    const owner = decodeURIComponent(repoMatch[1] as string);
    const repoName = decodeURIComponent(repoMatch[2] as string);
    const rest = repoMatch[3] as string;
    const repo = store.lookupRepo(owner, repoName);

    if (rest === '' || rest === '/') {
      if (method === 'GET') {
        ok(ctx, 200, store.repoView(repo));
        return;
      }
      if (method === 'PATCH') {
        if (typeof json['description'] === 'string') repo.description = json['description'] as string;
        if (typeof json['private'] === 'boolean') repo.priv = json['private'] as boolean;
        ok(ctx, 200, store.repoView(repo));
        return;
      }
      if (method === 'DELETE') {
        store.deleteRepo(repo);
        res.writeHead(204, { 'x-github-request-id': store.nextRequestId() });
        res.end();
        return;
      }
      sendError(res, store, 404, 'Not Found');
      return;
    }

    if (rest === '/branches' && method === 'GET') {
      ok(ctx, 200, branchList(repo));
      return;
    }
    const branchMatch = /^\/branches\/([^/]+)$/.exec(rest);
    if (branchMatch !== null && method === 'GET') {
      const name = decodeURIComponent(branchMatch[1] as string);
      const tip = repo.refs.get(`refs/heads/${name}`);
      if (tip === undefined) throw new ApiError(404, 'Not Found');
      ok(ctx, 200, { name, commit: { sha: tip, url: '' }, protected: false });
      return;
    }

    if (rest === '/git/refs' && method === 'POST') {
      const ref = strField(json, 'ref');
      const sha = strField(json, 'sha');
      if (ref === '' || sha === '') {
        sendError(res, store, 422, 'ref and sha are required');
        return;
      }
      if (repo.refs.has(ref)) throw new ApiError(422, 'Reference already exists');
      if (repo.objects.get(sha) === undefined) throw new ApiError(422, 'Object does not exist');
      store.setRef(repo, ref, sha);
      ok(ctx, 201, { ref, object: { sha }, url: '', node_id: '' });
      return;
    }
    const refMatch = /^\/(git\/refs?)\/heads\/([^/]+)$/.exec(rest);
    if (refMatch !== null && method === 'GET') {
      const name = decodeURIComponent(refMatch[2] as string);
      const tip = repo.refs.get(`refs/heads/${name}`);
      if (tip === undefined) throw new ApiError(404, 'Not Found');
      ok(ctx, 200, { ref: `refs/heads/${name}`, object: { sha: tip }, url: '', node_id: '' });
      return;
    }

    if (rest === '/commits' && method === 'GET') {
      const sha = queryParams().get('sha') ?? DEFAULT_BRANCH;
      const commits = store.commitsFrom(repo, sha);
      const perPage = Math.max(1, Number(queryParams().get('per_page') ?? '30') || 30);
      const page = Math.max(1, Number(queryParams().get('page') ?? '1') || 1);
      const slice = commits.slice((page - 1) * perPage, page * perPage);
      ok(ctx, 200, slice.map((commit) => ({
        sha: commit.sha,
        commit: { message: commit.message, author: { name: 'ada iversen', email: 'adaiversen@example.invalid', date: store.nowIso }, committer: { name: 'ada iversen', email: 'adaiversen@example.invalid', date: store.nowIso } },
        parents: commit.parents.map((parent) => ({ sha: parent })),
        url: '',
      })));
      return;
    }

    const contentsMatch = /^\/contents(?:\/(.*))?$/.exec(rest);
    if (contentsMatch !== null) {
      const rawPath = contentsMatch[1] === undefined ? '' : decodeURIComponent(contentsMatch[1] as string);
      const branch = queryParams().get('ref') ?? DEFAULT_BRANCH;
      if (method === 'GET') {
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (tip === undefined) throw new ApiError(404, 'Not Found');
        const commit = repo.objects.get(tip);
        if (commit === undefined || commit.type !== 'commit') throw new ApiError(404, 'Not Found');
        const rootTree = parseCommit(commit.data).tree;
        const entries = dirEntries(repo, rootTree, rawPath);
        if (entries !== undefined) {
          ok(ctx, 200, entries);
          return;
        }
        const file = store.fileAt(repo, branch, rawPath);
        if (file === undefined) throw new ApiError(404, 'Not Found');
        ok(ctx, 200, {
          type: 'file',
          encoding: 'base64',
          content: file.data.toString('base64'),
          sha: file.oid,
          size: file.data.length,
          name: rawPath.split('/').pop() ?? rawPath,
          path: rawPath,
          url: '',
        });
        return;
      }
      if (method === 'PUT') {
        const content = strField(json, 'content');
        if (content === '') {
          sendError(res, store, 422, 'content is required');
          return;
        }
        const data = Buffer.from(content, 'base64');
        const targetBranch = typeof json['branch'] === 'string' ? (json['branch'] as string) : branch;
        const existing = store.fileAt(repo, targetBranch, rawPath);
        const givenSha = typeof json['sha'] === 'string' ? (json['sha'] as string) : undefined;
        if (givenSha !== undefined && existing !== undefined && givenSha !== existing.oid) {
          sendError(res, store, 409, 'sha does not match the current file');
          return;
        }
        if (givenSha !== undefined && existing === undefined) {
          sendError(res, store, 409, 'sha does not match the current file');
          return;
        }
        const message = strField(json, 'message', `Update ${rawPath}`);
        const { commitSha, contentSha } = store.commitFile(repo, targetBranch, rawPath, data, message);
        ok(ctx, existing === undefined ? 201 : 200, {
          content: { name: rawPath.split('/').pop() ?? rawPath, path: rawPath, sha: contentSha, encoding: 'base64', size: data.length },
          commit: { sha: commitSha, message },
        });
        return;
      }
      if (method === 'DELETE') {
        const targetBranch = typeof json['branch'] === 'string' ? (json['branch'] as string) : branch;
        const existing = store.fileAt(repo, targetBranch, rawPath);
        if (existing === undefined) throw new ApiError(404, 'Not Found');
        const givenSha = typeof json['sha'] === 'string' ? (json['sha'] as string) : undefined;
        if (givenSha !== undefined && givenSha !== existing.oid) {
          sendError(res, store, 409, 'sha does not match the current file');
          return;
        }
        const message = strField(json, 'message', `Delete ${rawPath}`);
        const { commitSha } = store.commitFile(repo, targetBranch, rawPath, null, message);
        ok(ctx, 200, { commit: { sha: commitSha, message } });
        return;
      }
    }

    if (rest === '/labels' && method === 'GET') {
      ok(ctx, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: '', default: false })));
      return;
    }
    if (rest === '/labels' && method === 'POST') {
      const name = strField(json, 'name');
      if (name === '') {
        sendError(res, store, 422, 'Label name is required');
        return;
      }
      if (repo.labels.has(name)) throw new ApiError(422, 'Label already exists');
      const color = typeof json['color'] === 'string' ? (json['color'] as string) : 'ededed';
      repo.labels.set(name, { name, color });
      ok(ctx, 201, { name, color, description: '', default: false });
      return;
    }

    if (rest === '/issues' && method === 'GET') {
      issueList(ctx, repo, queryParams());
      return;
    }
    if (rest === '/issues' && method === 'POST') {
      const title = strField(json, 'title');
      if (title === '') {
        sendError(res, store, 422, 'Issue title is required');
        return;
      }
      const labels = Array.isArray(json['labels']) ? (json['labels'] as unknown[]).filter((item) => typeof item === 'string') as string[] : [];
      const issue = store.createIssue(repo, title, strField(json, 'body'), labels);
      ok(ctx, 201, store.issueView(repo, issue));
      return;
    }
    const issueMatch = /^\/issues\/(\d+)$/.exec(rest);
    if (issueMatch !== null) {
      const issue = store.findIssue(repo, Number(issueMatch[1]));
      if (method === 'GET') {
        sendRawJson(ctx.res, ctx.store, 200, store.issueJson(repo, issue));
        return;
      }
      if (method === 'PATCH') {
        if (typeof json['title'] === 'string') issue.title = json['title'] as string;
        if (typeof json['body'] === 'string') issue.body = json['body'] as string;
        if (json['state'] === 'closed') {
          issue.state = 'closed';
          issue.closedAt = store.nowIso;
        } else if (json['state'] === 'open') {
          issue.state = 'open';
          issue.closedAt = null;
        }
        issue.viewBuf = null;
        ok(ctx, 200, store.issueView(repo, issue));
        return;
      }
    }
    const commentsMatch = /^\/issues\/(\d+)\/comments$/.exec(rest);
    if (commentsMatch !== null) {
      const issue = store.findIssue(repo, Number(commentsMatch[1]));
      if (method === 'GET') {
        ok(ctx, 200, issue.comments.map((comment) => ({
          id: comment.id,
          node_id: '',
          body: comment.body,
          user: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
          created_at: store.nowIso,
          updated_at: store.nowIso,
          html_url: '',
          url: '',
        })));
        return;
      }
      if (method === 'POST') {
        const bodyText = strField(json, 'body');
        if (bodyText === '') {
          sendError(res, store, 422, 'Comment body is required');
          return;
        }
        const comment = { id: store.nextCommentId(), body: bodyText, seq: issue.comments.length + 1 };
        issue.comments.push(comment);
        issue.viewBuf = null;
        ok(ctx, 201, {
          id: comment.id,
          node_id: '',
          body: comment.body,
          user: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
          created_at: store.nowIso,
          updated_at: store.nowIso,
          html_url: '',
          url: '',
        });
        return;
      }
    }

    if (rest === '/pulls' && method === 'GET') {
      const state = queryParams().get('state') ?? 'open';
      const pulls = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
      const { page, link } = paginate(ctx, pulls, path, queryParams());
      ok(ctx, 200, page.map((pull) => store.pullView(repo, pull)), link === '' ? {} : { link });
      return;
    }
    if (rest === '/pulls' && method === 'POST') {
      const title = strField(json, 'title');
      if (title === '') {
        sendError(res, store, 422, 'Pull request title is required');
        return;
      }
      const pull = store.createPull(repo, title, strField(json, 'body'), strField(json, 'head'), strField(json, 'base'));
      ok(ctx, 201, store.pullView(repo, pull));
      return;
    }
    const pullFilesMatch = /^\/pulls\/(\d+)\/files$/.exec(rest);
    if (pullFilesMatch !== null && method === 'GET') {
      const pull = store.findPull(repo, Number(pullFilesMatch[1]));
      ok(ctx, 200, store.pullFiles(repo, pull));
      return;
    }
    const pullMatch = /^\/pulls\/(\d+)$/.exec(rest);
    if (pullMatch !== null && method === 'GET') {
      const pull = store.findPull(repo, Number(pullMatch[1]));
      ok(ctx, 200, store.pullView(repo, pull));
      return;
    }
    const mergeMatch = /^\/pulls\/(\d+)\/merge$/.exec(rest);
    if (mergeMatch !== null && method === 'PUT') {
      const pull = store.findPull(repo, Number(mergeMatch[1]));
      const { sha, message } = store.mergePull(repo, pull);
      ok(ctx, 200, { sha, merged: true, message });
      return;
    }

    sendError(res, store, 404, 'Not Found');
  } catch (error) {
    if (!res.headersSent) fail(ctx, error);
  }
}
