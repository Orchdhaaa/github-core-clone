// REST v3 API under /api/v3. Response shapes follow GitHub's REST v3 API.
import type { Issue, IssueComment, Label, PullRequest, Repo, Store } from "./store.ts";
import {
  branchTip,
  createCommit,
  createRepo,
  flatTree,
  getFileAt,
  getObject,
  isAncestor,
  parseCommit,
  prChangedFiles,
  prMergeable,
  refName,
  squashMerge,
  storeObject,
  treeWithFile,
  treeWithoutFile,
  userObject,
} from "./store.ts";

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface RestResponse {
  status: number;
  headers?: Record<string, string>;
  body: string;
}

function json(status: number, value: unknown, headers?: Record<string, string>): RestResponse {
  return { status, headers, body: JSON.stringify(value) };
}

function errJson(status: number, message: string): RestResponse {
  return json(status, { message, documentation_url: "https://docs.github.com/rest" });
}

function baseOf(baseUrl: string): string {
  return baseUrl.replace(/\/$/, "");
}

function repoUrl(baseUrl: string, owner: string, name: string): string {
  return `${baseOf(baseUrl)}/api/v3/repos/${owner}/${name}`;
}

export function serializeRepo(store: Store, repo: Repo, baseUrl: string): Record<string, unknown> {
  const openIssues = [...repo.issues.values()].filter((i) => i.state === "open").length;
  const openPulls = [...repo.pulls.values()].filter((p) => p.state === "open").length;
  const b = baseOf(baseUrl);
  return {
    id: repo.id,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: `${repo.ownerLogin}/${repo.name}`,
    owner: userObject(repo.ownerLogin, store.userId),
    private: repo.isPrivate,
    html_url: `${b}/${repo.ownerLogin}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: repoUrl(baseUrl, repo.ownerLogin, repo.name),
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    git_url: `git://${b.replace(/^https?:\/\//, "")}/${repo.ownerLogin}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.ownerLogin}/${repo.name}.git`,
    clone_url: `${b}/${repo.ownerLogin}/${repo.name}.git`,
    homepage: null,
    size: repo.objects.size,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: openIssues + openPulls,
    license: null,
    allow_forking: true,
    is_template: false,
    web_commit_signoff_required: false,
    topics: [],
    visibility: repo.isPrivate ? "private" : "public",
    forks: 0,
    open_issues: openIssues + openPulls,
    watchers: 0,
    default_branch: repo.defaultBranch,
  };
}

export function serializeLabel(label: Label, baseUrl: string, owner: string, name: string): Record<string, unknown> {
  return {
    id: label.id,
    node_id: Buffer.from(`Label:${label.id}`).toString("base64"),
    url: `${repoUrl(baseUrl, owner, name)}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

export function serializeIssue(
  store: Store,
  repo: Repo,
  issue: Issue,
  baseUrl: string,
): Record<string, unknown> {
  const b = baseOf(baseUrl);
  const rurl = repoUrl(baseUrl, repo.ownerLogin, repo.name);
  return {
    id: issue.id,
    node_id: issue.nodeId,
    url: `${rurl}/issues/${issue.number}`,
    repository_url: rurl,
    labels_url: `${rurl}/issues/${issue.number}/labels{/name}`,
    comments_url: `${rurl}/issues/${issue.number}/comments`,
    events_url: `${rurl}/issues/${issue.number}/events`,
    html_url: `${b}/${repo.ownerLogin}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: userObject(issue.userLogin, store.userId),
    labels: issue.labels.map((l) => serializeLabel(l, baseUrl, repo.ownerLogin, repo.name)),
    locked: false,
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: "OWNER",
    active_lock_reason: null,
    body_html: null,
    body_text: issue.body,
    timeline_url: `${rurl}/issues/${issue.number}/timeline`,
    performed_via_github_app: null,
    state_reason: issue.state === "closed" ? "completed" : null,
  };
}

function issueJson(store: Store, repo: Repo, issue: Issue, baseUrl: string): string {
  const key = issue.number;
  const hit = repo.issueJsonCache.get(key);
  if (hit) return hit;
  const s = JSON.stringify(serializeIssue(store, repo, issue, baseUrl));
  repo.issueJsonCache.set(key, s);
  return s;
}

function serializeComment(store: Store, repo: Repo, issue: Issue, c: IssueComment, baseUrl: string): Record<string, unknown> {
  const rurl = repoUrl(baseUrl, repo.ownerLogin, repo.name);
  return {
    id: c.id,
    node_id: c.nodeId,
    url: `${rurl}/issues/comments/${c.id}`,
    html_url: `${baseOf(baseUrl)}/${repo.ownerLogin}/${repo.name}/issues/${issue.number}#issuecomment-${c.id}`,
    body: c.body,
    user: userObject(c.userLogin, store.userId),
    created_at: c.createdAt,
    updated_at: c.updatedAt,
    author_association: "OWNER",
  };
}

export function serializePull(
  store: Store,
  repo: Repo,
  pr: PullRequest,
  baseUrl: string,
): Record<string, unknown> {
  const b = baseOf(baseUrl);
  const rurl = repoUrl(baseUrl, repo.ownerLogin, repo.name);
  return {
    id: pr.id,
    node_id: pr.nodeId,
    url: `${rurl}/pulls/${pr.number}`,
    html_url: `${b}/${repo.ownerLogin}/${repo.name}/pull/${pr.number}`,
    diff_url: `${b}/${repo.ownerLogin}/${repo.name}/pull/${pr.number}.diff`,
    patch_url: `${b}/${repo.ownerLogin}/${repo.name}/pull/${pr.number}.patch`,
    issue_url: `${rurl}/issues/${pr.number}`,
    number: pr.number,
    state: pr.state,
    locked: false,
    title: pr.title,
    body: pr.body,
    user: userObject(store.login, store.userId),
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    closed_at: pr.closedAt,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    mergeable: pr.state === "open" ? prMergeable(repo, pr) : false,
    mergeable_state: pr.state === "open" ? (prMergeable(repo, pr) ? "clean" : "dirty") : "unknown",
    merged: pr.merged,
    merged_by: pr.merged ? userObject(store.login, store.userId) : null,
    head: {
      label: `${repo.ownerLogin}:${pr.headRef}`,
      ref: pr.headRef,
      sha: pr.headSha,
      user: userObject(store.login, store.userId),
      repo: serializeRepo(store, repo, baseUrl),
    },
    base: {
      label: `${repo.ownerLogin}:${pr.baseRef}`,
      ref: pr.baseRef,
      sha: pr.baseSha,
      user: userObject(store.login, store.userId),
      repo: serializeRepo(store, repo, baseUrl),
    },
    author_association: "OWNER",
    auto_merge: null,
    active_lock_reason: null,
  };
}

function parsePagination(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, parseInt(query.get("page") ?? "1", 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(query.get("per_page") ?? "30", 10) || 30));
  return { page, perPage };
}

// Text of a blob object, or "" if missing / not a blob.
function blobText(repo: Repo, sha: string): string {
  const obj = getObject(repo, sha);
  if (!obj || obj.type !== "blob") return "";
  return obj.data.toString("utf8");
}

// Line additions/deletions between two file contents, via a small LCS.
function lineDiff(before: string, after: string): { additions: number; deletions: number } {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  let additions = 0;
  let deletions = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      deletions++;
      i++;
    } else {
      additions++;
      j++;
    }
  }
  deletions += n - i;
  additions += m - j;
  return { additions, deletions };
}

function paginate<T>(items: T[], page: number, perPage: number): { slice: T[]; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  return { slice: items.slice(start, start + perPage), totalPages };
}

function linkHeader(baseUrl: string, path: string, query: URLSearchParams, page: number, perPage: number, totalPages: number): string | null {
  if (page >= totalPages) return null;
  // `path` is the route after /api/v3 was stripped; the Link URL must carry
  // the full /api/v3 prefix or the client follows it to an unrouted path.
  const full = `/api/v3${path}`;
  const q = new URLSearchParams(query);
  q.set("page", String(page + 1));
  q.set("per_page", String(perPage));
  const next = `<${baseOf(baseUrl)}${full}?${q.toString()}>; rel="next"`;
  const ql = new URLSearchParams(query);
  ql.set("page", String(totalPages));
  ql.set("per_page", String(perPage));
  const last = `<${baseOf(baseUrl)}${full}?${ql.toString()}>; rel="last"`;
  return `${next}, ${last}`;
}

function requireRepo(store: Store, owner: string, name: string): Repo {
  if (owner !== store.login) throw new HttpError(404, "Not Found");
  const repo = store.repos.get(name);
  if (!repo) throw new HttpError(404, "Not Found");
  return repo;
}

function commitObject(store: Store, repo: Repo, sha: string, message: string): Record<string, unknown> {
  const obj = getObject(repo, sha);
  const info = obj ? parseCommit(obj.data) : null;
  return {
    sha,
    message,
    author: { name: store.login, email: `${store.login}@users.noreply.github.com`, date: repo.updatedAt },
    committer: { name: store.login, email: `${store.login}@users.noreply.github.com`, date: repo.updatedAt },
    tree: { sha: info ? info.tree : "" },
    parents: (info ? info.parents : []).map((p) => ({ sha: p })),
  };
}

export function dispatchRest(
  store: Store,
  method: string,
  segments: string[],
  query: URLSearchParams,
  rawBody: Buffer,
  baseUrl: string,
): RestResponse {
  let body: unknown = null;
  if (rawBody.length > 0 && (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE")) {
    try {
      body = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return errJson(400, "Problems parsing JSON");
    }
  }
  const b = (v: Record<string, unknown>): Record<string, unknown> => v as Record<string, unknown>;
  const path = `/${segments.join("/")}`;

  try {
    // GET /api/v3/ (segments empty after stripping /api/v3)
    if (segments.length === 0) {
      if (method !== "GET") throw new HttpError(404, "Not Found");
      return json(200, {}, { "X-OAuth-Scopes": "repo" });
    }
    if (segments[0] === "meta" && segments.length === 1) {
      if (method !== "GET") throw new HttpError(404, "Not Found");
      return json(200, {
        verifiable_password_authentication: true,
        installed_version: "1.0.0",
        github_services_sha: "0000000000000000000000000000000000000000",
        hooks: ["pre-receive"],
        git: ["1.0.0"],
        pages: ["1.0.0"],
      });
    }
    if (segments[0] === "user" && segments.length === 1) {
      if (method !== "GET") throw new HttpError(404, "Not Found");
      return json(200, {
        ...userObject(store.login, store.userId),
        name: store.login,
        company: null,
        blog: "",
        location: null,
        email: null,
        hireable: null,
        bio: null,
        public_repos: store.repos.size,
        public_gists: 0,
        followers: 0,
        following: 0,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      });
    }
    if (segments[0] === "user" && segments[1] === "repos") {
      if (method === "GET") {
        const { page, perPage } = parsePagination(query);
        const all = [...store.repos.values()].sort((a, c) => a.id - c.id);
        const { slice, totalPages } = paginate(all, page, perPage);
        const headers: Record<string, string> = {};
        const link = linkHeader(baseUrl, path, query, page, perPage, totalPages);
        if (link) headers.Link = link;
        return { status: 200, headers, body: JSON.stringify(slice.map((r) => serializeRepo(store, r, baseUrl))) };
      }
      if (method === "POST") {
        const input = b((body ?? {}) as Record<string, unknown>);
        const name = typeof input.name === "string" ? input.name : "";
        if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) {
          return errJson(422, "Validation Failed");
        }
        if (store.repos.has(name)) {
          return json(422, {
            message: "Validation Failed",
            errors: [{ resource: "Repository", code: "custom", field: "name", message: "name already exists on this account" }],
          });
        }
        const description = typeof input.description === "string" ? input.description : "";
        const isPrivate = input.private === true;
        const repo = createRepo(store, name, description, isPrivate);
        return json(201, serializeRepo(store, repo, baseUrl));
      }
      throw new HttpError(404, "Not Found");
    }
    if (segments[0] === "repos") {
      const owner = segments[1];
      const name = segments[2];
      if (!owner || !name) throw new HttpError(404, "Not Found");
      const repo = requireRepo(store, owner, name);
      const rest = segments.slice(3);
      if (rest.length === 0) {
        if (method === "GET") return json(200, serializeRepo(store, repo, baseUrl));
        if (method === "PATCH") {
          const input = b((body ?? {}) as Record<string, unknown>);
          if (typeof input.description === "string") repo.description = input.description;
          repo.updatedAt = store.clock.nextIso();
          return json(200, serializeRepo(store, repo, baseUrl));
        }
        if (method === "DELETE") {
          store.repos.delete(name);
          return { status: 204, body: "" };
        }
        throw new HttpError(404, "Not Found");
      }
      if (rest[0] === "contents") {
        const filePath = rest.slice(1).join("/");
        if (!filePath) throw new HttpError(404, "Not Found");
        const branch = (() => {
          const input = b((body ?? {}) as Record<string, unknown>);
          return typeof input.branch === "string" ? input.branch : repo.defaultBranch;
        })();
        if (method === "GET") {
          const getBranch = query.get("ref") ?? repo.defaultBranch;
          const tip = branchTip(repo, getBranch);
          if (!tip) throw new HttpError(404, "Not Found");
          const hit = getFileAt(repo, tip, filePath);
          if (hit) {
            return json(200, {
              type: "file",
              encoding: "base64",
              size: hit.data.length,
              name: filePath.split("/").pop() ?? filePath,
              path: filePath,
              content: hit.data.toString("base64"),
              sha: hit.blobSha,
              url: `${repoUrl(baseUrl, owner, name)}/contents/${filePath}`,
              git_url: `${repoUrl(baseUrl, owner, name)}/git/blobs/${hit.blobSha}`,
              html_url: `${baseOf(baseUrl)}/${owner}/${name}/blob/${getBranch}/${filePath}`,
              download_url: `${baseOf(baseUrl)}/${owner}/${name}/raw/${getBranch}/${filePath}`,
              _links: {},
            });
          }
          // Directory listing?
          const flat = flatTree(repo, tip);
          const prefix = `${filePath}/`;
          const children = new Map<string, { mode: string; sha: string }>();
          for (const [p, v] of flat) {
            if (!p.startsWith(prefix)) continue;
            const restPath = p.slice(prefix.length);
            const first = restPath.split("/")[0];
            if (!children.has(first)) children.set(first, v);
          }
          if (children.size > 0) {
            const list = [...children.entries()].map(([childName, v]) => ({
              type: v.mode === "40000" ? "dir" : "file",
              size: 0,
              name: childName,
              path: `${filePath}/${childName}`,
              sha: v.sha,
              url: `${repoUrl(baseUrl, owner, name)}/contents/${filePath}/${childName}`,
              git_url: `${repoUrl(baseUrl, owner, name)}/git/${v.mode === "40000" ? "trees" : "blobs"}/${v.sha}`,
              html_url: `${baseOf(baseUrl)}/${owner}/${name}/tree/${getBranch}/${filePath}/${childName}`,
              download_url: null,
              _links: {},
            }));
            return json(200, list);
          }
          throw new HttpError(404, "Not Found");
        }
        if (method === "PUT") {
          const input = b((body ?? {}) as Record<string, unknown>);
          const message = typeof input.message === "string" ? input.message : `Update ${filePath}`;
          const contentB64 = typeof input.content === "string" ? input.content : "";
          if (!contentB64) return errJson(422, "Validation Failed");
          const data = Buffer.from(contentB64, "base64");
          const tip = branchTip(repo, branch);
          const existing = tip ? getFileAt(repo, tip, filePath) : null;
          const givenSha = typeof input.sha === "string" ? input.sha : null;
          if (existing && !givenSha) {
            return json(422, { message: "Validation Failed", errors: [{ resource: "Content", code: "custom", field: "sha", message: "sha wasn't supplied" }] });
          }
          if (givenSha && (!existing || existing.blobSha !== givenSha)) {
            return json(409, { message: "sha does not match" });
          }
          const blobSha = storeObject(repo, "blob", data);
          const treeSha = treeWithFile(repo, tip, filePath, blobSha);
          const parents = tip ? [tip] : [];
          const commitSha = createCommit(store, repo, treeSha, parents, message);
          repo.refs.set(refName(branch), commitSha);
          const now = store.clock.nextIso();
          repo.updatedAt = now;
          repo.pushedAt = now;
          repo.packCache.clear();
          const contentObj = {
            type: "file",
            encoding: "base64",
            size: data.length,
            name: filePath.split("/").pop() ?? filePath,
            path: filePath,
            content: contentB64,
            sha: blobSha,
            url: `${repoUrl(baseUrl, owner, name)}/contents/${filePath}`,
            git_url: `${repoUrl(baseUrl, owner, name)}/git/blobs/${blobSha}`,
            html_url: `${baseOf(baseUrl)}/${owner}/${name}/blob/${branch}/${filePath}`,
            download_url: `${baseOf(baseUrl)}/${owner}/${name}/raw/${branch}/${filePath}`,
            _links: {},
          };
          return json(existing ? 200 : 201, {
            content: contentObj,
            commit: commitObject(store, repo, commitSha, message),
          });
        }
        if (method === "DELETE") {
          const input = b((body ?? {}) as Record<string, unknown>);
          const message = typeof input.message === "string" ? input.message : `Delete ${filePath}`;
          const tip = branchTip(repo, branch);
          if (!tip) throw new HttpError(404, "Not Found");
          const existing = getFileAt(repo, tip, filePath);
          if (!existing) throw new HttpError(404, "Not Found");
          const givenSha = typeof input.sha === "string" ? input.sha : null;
          if (givenSha && existing.blobSha !== givenSha) {
            return json(409, { message: "sha does not match" });
          }
          const treeSha = treeWithoutFile(repo, tip, filePath);
          if (treeSha === null) throw new HttpError(404, "Not Found");
          const commitSha = createCommit(store, repo, treeSha, [tip], message);
          repo.refs.set(refName(branch), commitSha);
          const now = store.clock.nextIso();
          repo.updatedAt = now;
          repo.pushedAt = now;
          repo.packCache.clear();
          return json(200, { commit: commitObject(store, repo, commitSha, message) });
        }
        throw new HttpError(404, "Not Found");
      }
      if (rest[0] === "labels") {
        if (method === "GET") {
          return json(200, [...repo.labels.values()].map((l) => serializeLabel(l, baseUrl, owner, name)));
        }
        if (method === "POST") {
          const input = b((body ?? {}) as Record<string, unknown>);
          const labelName = typeof input.name === "string" ? input.name : "";
          if (!labelName) return errJson(422, "Validation Failed");
          if (repo.labels.has(labelName)) {
            return json(422, { message: "Validation Failed", errors: [{ resource: "Label", code: "custom", field: "name", message: "already_exists" }] });
          }
          const color = typeof input.color === "string" ? input.color.replace(/^#/, "") : "ededed";
          const description = typeof input.description === "string" ? input.description : "";
          const label: Label = { id: store.nextLabelId++, name: labelName, color, description };
          repo.labels.set(labelName, label);
          return json(201, serializeLabel(label, baseUrl, owner, name));
        }
        throw new HttpError(404, "Not Found");
      }
      if (rest[0] === "issues") {
        if (rest.length === 1) {
          if (method === "GET") {
            const state = query.get("state") ?? "open";
            const sort = query.get("sort") ?? "created";
            const direction = query.get("direction") ?? "desc";
            const { page, perPage } = parsePagination(query);
            let all = [...repo.issues.values()];
            // created/updated sort by creation time (number order is the
            // creation order here); comments sort by comment count.
            if (sort === "comments") all.sort((a, c) => a.comments - c.comments);
            else all.sort((a, c) => a.number - c.number);
            if (direction === "desc") all.reverse();
            if (state !== "all") all = all.filter((i) => i.state === state);
            const { slice, totalPages } = paginate(all, page, perPage);
            const headers: Record<string, string> = {};
            const link = linkHeader(baseUrl, path, query, page, perPage, totalPages);
            if (link) headers.Link = link;
            return { status: 200, headers, body: JSON.stringify(slice.map((i) => serializeIssue(store, repo, i, baseUrl))) };
          }
          if (method === "POST") {
            const input = b((body ?? {}) as Record<string, unknown>);
            const title = typeof input.title === "string" ? input.title : "";
            if (!title) return errJson(422, "Validation Failed");
            const labelNames: string[] = Array.isArray(input.labels)
              ? (input.labels as unknown[]).map((l) => (typeof l === "string" ? l : (l as { name?: unknown }).name as string)).filter((x): x is string => typeof x === "string")
              : [];
            const labels: Label[] = [];
            for (const ln of labelNames) {
              const found = repo.labels.get(ln);
              if (!found) {
                return json(422, {
                  message: "Validation Failed",
                  errors: [{ resource: "Issue", code: "custom", field: "labels", message: `label '${ln}' does not exist` }],
                });
              }
              labels.push(found);
            }
            const number = repo.nextNumber++;
            const id = store.nextObjectId++;
            const now = store.clock.nextIso();
            const issue: Issue = {
              id,
              nodeId: Buffer.from(`Issue:${id}`).toString("base64"),
              number,
              title,
              body: typeof input.body === "string" ? input.body : "",
              state: "open",
              labels,
              userLogin: store.login,
              createdAt: now,
              updatedAt: now,
              closedAt: null,
              comments: 0,
            };
            repo.issues.set(number, issue);
            return { status: 201, body: issueJson(store, repo, issue, baseUrl) };
          }
          throw new HttpError(404, "Not Found");
        }
        const number = parseInt(rest[1], 10);
        if (Number.isFinite(number) && rest.length === 3 && rest[2] === "comments") {
          const issue = repo.issues.get(number);
          if (!issue) throw new HttpError(404, "Not Found");
          if (method === "GET") {
            const list = repo.issueComments.get(number) ?? [];
            return { status: 200, body: JSON.stringify(list.map((c) => serializeComment(store, repo, issue, c, baseUrl))) };
          }
          if (method === "POST") {
            const input = b((body ?? {}) as Record<string, unknown>);
            const commentBody = typeof input.body === "string" ? input.body : "";
            if (!commentBody) return errJson(422, "Validation Failed");
            const id = store.nextObjectId++;
            const now = store.clock.nextIso();
            const comment: IssueComment = {
              id,
              nodeId: Buffer.from(`IssueComment:${id}`).toString("base64"),
              issueNumber: number,
              body: commentBody,
              userLogin: store.login,
              createdAt: now,
              updatedAt: now,
            };
            const list = repo.issueComments.get(number) ?? [];
            list.push(comment);
            repo.issueComments.set(number, list);
            issue.comments = list.length;
            issue.updatedAt = now;
            repo.issueJsonCache.clear();
            return { status: 201, body: JSON.stringify(serializeComment(store, repo, issue, comment, baseUrl)) };
          }
          throw new HttpError(404, "Not Found");
        }
        if (Number.isFinite(number) && rest.length === 2) {
          const issue = repo.issues.get(number);
          if (!issue) throw new HttpError(404, "Not Found");
          if (method === "GET") return { status: 200, body: issueJson(store, repo, issue, baseUrl) };
          if (method === "PATCH") {
            const input = b((body ?? {}) as Record<string, unknown>);
            if (typeof input.title === "string") issue.title = input.title;
            if (typeof input.body === "string") issue.body = input.body;
            if (input.state === "closed" || input.state === "open") {
              issue.state = input.state;
              issue.closedAt = input.state === "closed" ? store.clock.nextIso() : null;
            }
            issue.updatedAt = store.clock.nextIso();
            repo.issueJsonCache.clear();
            return { status: 200, body: issueJson(store, repo, issue, baseUrl) };
          }
          throw new HttpError(404, "Not Found");
        }
        throw new HttpError(404, "Not Found");
      }
      if (rest[0] === "pulls") {
        if (rest.length === 1) {
          if (method === "GET") {
            const state = query.get("state") ?? "open";
            const { page, perPage } = parsePagination(query);
            let all = [...repo.pulls.values()].sort((a, c) => a.number - c.number);
            if (state !== "all") all = all.filter((p) => p.state === state);
            const { slice, totalPages } = paginate(all, page, perPage);
            const headers: Record<string, string> = {};
            const link = linkHeader(baseUrl, path, query, page, perPage, totalPages);
            if (link) headers.Link = link;
            return { status: 200, headers, body: JSON.stringify(slice.map((p) => serializePull(store, repo, p, baseUrl))) };
          }
          if (method === "POST") {
            const input = b((body ?? {}) as Record<string, unknown>);
            const title = typeof input.title === "string" ? input.title : "";
            const head = typeof input.head === "string" ? input.head : "";
            const base = typeof input.base === "string" ? input.base : repo.defaultBranch;
            if (!title || !head) return errJson(422, "Validation Failed");
            const headTip = branchTip(repo, head);
            const baseTip = branchTip(repo, base);
            if (!headTip || !baseTip) {
              return json(422, { message: "Validation Failed", errors: [{ resource: "PullRequest", code: "custom", field: "head", message: "head branch does not exist" }] });
            }
            const number = repo.nextNumber++;
            const id = store.nextObjectId++;
            const now = store.clock.nextIso();
            const pr: PullRequest = {
              id,
              nodeId: Buffer.from(`PullRequest:${id}`).toString("base64"),
              number,
              title,
              body: typeof input.body === "string" ? input.body : "",
              state: "open",
              headRef: head,
              headSha: headTip,
              baseRef: base,
              baseSha: baseTip,
              merged: false,
              mergedAt: null,
              mergeCommitSha: null,
              createdAt: now,
              updatedAt: now,
              closedAt: null,
            };
            repo.pulls.set(number, pr);
            return json(201, serializePull(store, repo, pr, baseUrl));
          }
          throw new HttpError(404, "Not Found");
        }
        const number = parseInt(rest[1], 10);
        if (Number.isFinite(number) && rest.length === 2) {
          const pr = repo.pulls.get(number);
          if (!pr) throw new HttpError(404, "Not Found");
          if (method === "GET") return json(200, serializePull(store, repo, pr, baseUrl));
          throw new HttpError(404, "Not Found");
        }
        if (Number.isFinite(number) && rest.length === 3 && rest[2] === "files") {
          const pr = repo.pulls.get(number);
          if (!pr) throw new HttpError(404, "Not Found");
          if (method !== "GET") throw new HttpError(404, "Not Found");
          const baseFlat = flatTree(repo, pr.baseSha);
          const headFlat = flatTree(repo, pr.headSha);
          const files: Record<string, unknown>[] = [];
          for (const path of prChangedFiles(repo, pr)) {
            const b = baseFlat.get(path);
            const h = headFlat.get(path);
            const status = !b ? "added" : !h ? "removed" : "modified";
            const baseText = b ? blobText(repo, b.sha) : "";
            const headText = h ? blobText(repo, h.sha) : "";
            const { additions, deletions } = lineDiff(baseText, headText);
            files.push({
              sha: h ? h.sha : b!.sha,
              filename: path,
              status,
              additions,
              deletions,
              changes: additions + deletions,
              blob_url: `${repoUrl(baseUrl, owner, name)}/git/blobs/${h ? h.sha : b!.sha}`,
              raw_url: `${repoUrl(baseUrl, owner, name)}/${pr.headRef}/${path}`,
              contents_url: `${repoUrl(baseUrl, owner, name)}/contents/${path}`,
            });
          }
          return json(200, files);
        }
        if (Number.isFinite(number) && rest.length === 3 && rest[2] === "merge") {
          const pr = repo.pulls.get(number);
          if (!pr) throw new HttpError(404, "Not Found");
          if (method !== "PUT") throw new HttpError(404, "Not Found");
          if (pr.state !== "open") {
            return json(405, { message: "Pull request is already merged" });
          }
          const result = squashMerge(store, repo, pr);
          if ("conflict" in result) {
            return json(405, { message: "Merge conflict" });
          }
          pr.merged = true;
          pr.state = "closed";
          const now = store.clock.nextIso();
          pr.mergedAt = now;
          pr.closedAt = now;
          pr.updatedAt = now;
          pr.mergeCommitSha = result.sha;
          pr.baseSha = result.sha;
          repo.updatedAt = now;
          repo.pushedAt = now;
          return json(200, {
            sha: result.sha,
            merged: true,
            message: "Pull request successfully merged",
          });
        }
        throw new HttpError(404, "Not Found");
      }
      if (rest[0] === "branches") {
        if (method === "GET" && rest.length === 1) {
          const list = [...repo.refs.entries()]
            .filter(([n]) => n.startsWith("refs/heads/"))
            .map(([n, sha]) => ({
              name: n.slice("refs/heads/".length),
              commit: { sha, url: `${repoUrl(baseUrl, owner, name)}/commits/${sha}` },
              protected: false,
            }));
          return json(200, list);
        }
        if (method === "GET" && rest.length === 2) {
          const tip = branchTip(repo, rest[1]);
          if (!tip) throw new HttpError(404, "Not Found");
          return json(200, {
            name: rest[1],
            commit: { sha: tip, url: `${repoUrl(baseUrl, owner, name)}/commits/${tip}` },
            protected: false,
          });
        }
        throw new HttpError(404, "Not Found");
      }
      if (rest[0] === "commits") {
        if (method === "GET") {
          // ?sha=<branch|sha> selects the starting point; default is the
          // default branch tip.
          const shaParam = query.get("sha");
          let tip: string | undefined;
          if (shaParam) {
            tip = branchTip(repo, shaParam) ?? (/^[0-9a-f]{40}$/.test(shaParam) && getObject(repo, shaParam) ? shaParam : undefined);
          } else {
            tip = branchTip(repo, repo.defaultBranch) ?? undefined;
          }
          const out: Record<string, unknown>[] = [];
          if (tip) {
            const seen = new Set<string>();
            const stack = [tip];
            while (stack.length > 0 && out.length < 30) {
              const sha = stack.pop()!;
              if (seen.has(sha)) continue;
              seen.add(sha);
              const obj = getObject(repo, sha);
              if (!obj || obj.type !== "commit") continue;
              const info = parseCommit(obj.data);
              out.push({
                sha,
                commit: {
                  message: info.message,
                  author: { name: store.login, email: `${store.login}@users.noreply.github.com`, date: repo.updatedAt },
                  committer: { name: store.login, email: `${store.login}@users.noreply.github.com`, date: repo.updatedAt },
                  tree: { sha: info.tree },
                },
                author: userObject(store.login, store.userId),
                committer: userObject(store.login, store.userId),
                parents: info.parents.map((p) => ({ sha: p })),
                url: `${repoUrl(baseUrl, owner, name)}/commits/${sha}`,
              });
              for (const p of info.parents) stack.push(p);
            }
          }
          return json(200, out);
        }
        throw new HttpError(404, "Not Found");
      }
      if (rest[0] === "git" && rest[1] === "refs") {
        if (method === "POST" && rest.length === 2) {
          // Create a reference (branch or tag): POST /git/refs {ref, sha}.
          const input = b((body ?? {}) as Record<string, unknown>);
          const ref = typeof input.ref === "string" ? input.ref : "";
          const sha = typeof input.sha === "string" ? input.sha : "";
          if (!ref.startsWith("refs/") || !/^[0-9a-f]{40}$/.test(sha)) {
            return errJson(422, "Validation Failed");
          }
          if (!getObject(repo, sha)) return errJson(422, "Validation Failed");
          if (repo.refs.has(ref)) return errJson(422, "Validation Failed");
          repo.refs.set(ref, sha);
          repo.packCache.clear();
          const obj = getObject(repo, sha);
          return json(201, {
            ref,
            node_id: Buffer.from(`Ref:${ref}`).toString("base64"),
            url: `${repoUrl(baseUrl, owner, name)}/git/refs/${ref.slice("refs/".length)}`,
            object: { sha, type: obj ? obj.type : "commit", url: `${repoUrl(baseUrl, owner, name)}/git/${obj ? obj.type : "commit"}s/${sha}` },
          });
        }
        if (method === "GET") {
          const refPath = rest.slice(2).join("/");
          const full = `refs/${refPath}`;
          const sha = repo.refs.get(full);
          if (!sha) throw new HttpError(404, "Not Found");
          const obj = getObject(repo, sha);
          return json(200, {
            ref: full,
            node_id: Buffer.from(`Ref:${full}`).toString("base64"),
            url: `${repoUrl(baseUrl, owner, name)}/git/refs/${refPath}`,
            object: { sha, type: obj ? obj.type : "commit", url: `${repoUrl(baseUrl, owner, name)}/git/${obj ? obj.type : "commit"}s/${sha}` },
          });
        }
        if (method === "PATCH" && rest.length > 2) {
          const refPath = rest.slice(2).join("/");
          const full = `refs/${refPath}`;
          const sha = repo.refs.get(full);
          if (!sha) throw new HttpError(404, "Not Found");
          const input = b((body ?? {}) as Record<string, unknown>);
          const newSha = typeof input.sha === "string" ? input.sha : "";
          const force = input.force === true;
          if (!/^[0-9a-f]{40}$/.test(newSha) || !getObject(repo, newSha)) {
            return errJson(422, "Validation Failed");
          }
          if (!force && !isAncestor(repo, sha, newSha)) {
            return errJson(422, "Validation Failed");
          }
          repo.refs.set(full, newSha);
          repo.packCache.clear();
          const obj = getObject(repo, newSha);
          return json(200, {
            ref: full,
            node_id: Buffer.from(`Ref:${full}`).toString("base64"),
            url: `${repoUrl(baseUrl, owner, name)}/git/refs/${refPath}`,
            object: { sha: newSha, type: obj ? obj.type : "commit", url: `${repoUrl(baseUrl, owner, name)}/git/${obj ? obj.type : "commit"}s/${newSha}` },
          });
        }
        if (method === "DELETE" && rest.length > 2) {
          const refPath = rest.slice(2).join("/");
          const full = `refs/${refPath}`;
          if (!repo.refs.has(full)) throw new HttpError(404, "Not Found");
          repo.refs.delete(full);
          repo.packCache.clear();
          return { status: 204, body: "" };
        }
        throw new HttpError(404, "Not Found");
      }
      throw new HttpError(404, "Not Found");
    }
    throw new HttpError(404, "Not Found");
  } catch (e) {
    if (e instanceof HttpError) return errJson(e.status, e.message);
    throw e;
  }
}
