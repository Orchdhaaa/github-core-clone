// Model Context Protocol endpoint at /mcp: JSON-RPC 2.0 over Streamable HTTP.
// Speaks revision 2026-07-28 (server/discover) and the handshake revisions
// through initialize. The tools act on the same store REST uses.
import type { Issue, PullRequest, Repo, Store } from "./store.ts";
import {
  branchTip,
  createRepo,
  prMergeable,
  squashMerge,
} from "./store.ts";
import { serializeIssue, serializePull, serializeRepo } from "./rest.ts";

const SERVER_INFO = { name: "github-core-clone", version: "1.0.0" };
const SUPPORTED_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: "create_repo",
    description: "Create a new repository owned by the authenticated user.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The name of the repository." },
        description: { type: "string", description: "A short description of the repository." },
      },
      required: ["name"],
    },
  },
  {
    name: "get_repo",
    description: "Get a repository by owner and name.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "The owner of the repository." },
        repo: { type: "string", description: "The name of the repository." },
        full_name: { type: "string", description: "The full name owner/repo." },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "create_issue",
    description: "Create an issue in a repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "The owner of the repository." },
        repo: { type: "string", description: "The name of the repository." },
        full_name: { type: "string", description: "The full name owner/repo." },
        title: { type: "string", description: "The title of the issue." },
        body: { type: "string", description: "The body of the issue." },
      },
      required: ["owner", "repo", "title"],
    },
  },
  {
    name: "list_issues",
    description: "List issues in a repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "The owner of the repository." },
        repo: { type: "string", description: "The name of the repository." },
        full_name: { type: "string", description: "The full name owner/repo." },
        state: { type: "string", description: "Filter by state: open, closed or all." },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "create_pull_request",
    description: "Create a pull request in a repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "The owner of the repository." },
        repo: { type: "string", description: "The name of the repository." },
        full_name: { type: "string", description: "The full name owner/repo." },
        title: { type: "string", description: "The title of the pull request." },
        head: { type: "string", description: "The head branch." },
        base: { type: "string", description: "The base branch." },
        body: { type: "string", description: "The body of the pull request." },
      },
      required: ["owner", "repo", "title", "head", "base"],
    },
  },
  {
    name: "merge_pull_request",
    description: "Merge a pull request with a squash commit on its base branch.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "The owner of the repository." },
        repo: { type: "string", description: "The name of the repository." },
        full_name: { type: "string", description: "The full name owner/repo." },
        pull_number: { type: "number", description: "The pull request number." },
      },
      required: ["owner", "repo", "pull_number"],
    },
  },
];

const TOOLS_JSON = JSON.stringify(TOOLS);

interface RpcError {
  code: number;
  message: string;
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function rpcError(id: unknown, err: RpcError): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, error: err };
}

// Normalize tool arguments: the caller maps its documented arguments onto the
// schema's nearest property names and may fill full_name with owner/repo.
function normalizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  if (typeof out.full_name === "string") {
    const [owner, repo] = (out.full_name as string).split("/");
    if (owner && repo) {
      if (out.owner === undefined) out.owner = owner;
      if (out.repo === undefined) out.repo = repo;
    }
  }
  if (out.repo === undefined && typeof out.repository === "string") out.repo = out.repository;
  if (out.repo === undefined && typeof out.repo_name === "string") out.repo = out.repo_name;
  if (out.pull_number === undefined && typeof out.number === "number") out.pull_number = out.number;
  if (out.pull_number === undefined && typeof out.pullNumber === "number") out.pull_number = out.pullNumber;
  return out;
}

function findTool(name: string): ToolDef | null {
  const lower = name.toLowerCase();
  for (const t of TOOLS) {
    if (lower === t.name || lower.endsWith(`__${t.name}`) || lower.endsWith(`_${t.name}`)) return t;
    // Match as a suffix, case-insensitively (a server prefix is allowed).
    const suffix = lower.split("__").pop() ?? lower;
    if (suffix === t.name) return t;
  }
  return null;
}

function textResult(value: unknown): Record<string, unknown> {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

function textError(message: string): Record<string, unknown> {
  return { content: [{ type: "text", text: message }], isError: true };
}

export function handleMcp(
  store: Store,
  baseUrl: string,
  rawBody: Buffer,
  authed: boolean,
): { status: number; body: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString("utf8"));
  } catch {
    // A body that is not JSON answers HTTP 400 with -32700.
    return {
      status: 400,
      body: JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }),
    };
  }
  const requests = Array.isArray(parsed) ? parsed : [parsed];
  // A tools/call or tools/list with no Authorization header answers HTTP 401.
  if (!authed) {
    for (const req of requests) {
      const m = (req as Record<string, unknown> | null)?.method;
      if (m === "tools/call" || m === "tools/list") {
        return { status: 401, body: JSON.stringify({ message: "Requires authentication" }) };
      }
    }
  }
  const responses: Record<string, unknown>[] = [];
  for (const req of requests) {
    const r = (req ?? {}) as Record<string, unknown>;
    const id = r.id;
    const method = typeof r.method === "string" ? r.method : "";
    if (method === "notifications/initialized" || method.startsWith("notifications/")) {
      continue; // Notifications get no response.
    }
    if (method === "ping") {
      responses.push(rpcResult(id, {}));
      continue;
    }
    if (method === "server/discover") {
      responses.push(
        rpcResult(id, {
          protocolVersion: "2026-07-28",
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        }),
      );
      continue;
    }
    if (method === "initialize") {
      const params = (r.params ?? {}) as Record<string, unknown>;
      const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "2026-07-28";
      const version = SUPPORTED_VERSIONS.includes(requested) ? requested : "2026-07-28";
      responses.push(
        rpcResult(id, {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        }),
      );
      continue;
    }
    if (method === "tools/list") {
      // The same list, byte for byte, on every call.
      responses.push({ jsonrpc: "2.0", id: id ?? null, result: { tools: JSON.parse(TOOLS_JSON) } });
      continue;
    }
    if (method === "tools/call") {
      const params = (r.params ?? {}) as Record<string, unknown>;
      const toolName = typeof params.name === "string" ? params.name : "";
      const tool = findTool(toolName);
      if (!tool) {
        responses.push(rpcError(id, { code: -32601, message: `Method not found: ${toolName}` }));
        continue;
      }
      const args = normalizeArgs(
        (params.arguments && typeof params.arguments === "object"
          ? params.arguments
          : {}) as Record<string, unknown>,
      );
      let missing: string | null = null;
      for (const reqd of tool.inputSchema.required) {
        if (args[reqd] === undefined || args[reqd] === null || args[reqd] === "") {
          missing = reqd;
          break;
        }
      }
      if (missing) {
        responses.push(rpcResult(id, textError(`Missing required argument: ${missing}`)));
        continue;
      }
      const result = callTool(store, baseUrl, tool.name, args);
      if ("error" in result) {
        responses.push(rpcResult(id, textError(result.error as string)));
      } else {
        responses.push(rpcResult(id, textResult(result.value)));
      }
      continue;
    }
    responses.push(rpcError(id, { code: -32601, message: `Method not found: ${method}` }));
  }
  if (Array.isArray(parsed)) {
    return { status: 200, body: JSON.stringify(responses) };
  }
  if (responses.length === 0) {
    return { status: 202, body: "" };
  }
  return { status: 200, body: JSON.stringify(responses[0]) };
}

function callTool(
  store: Store,
  baseUrl: string,
  name: string,
  args: Record<string, unknown>,
): { value: unknown } | { error: string } {
  const owner = typeof args.owner === "string" ? args.owner : "";
  const repoName = typeof args.repo === "string" ? args.repo : "";
  const getRepo = (): Repo | null => {
    if (owner !== store.login) return null;
    return store.repos.get(repoName) ?? null;
  };
  switch (name) {
    case "create_repo": {
      const repoNameArg = typeof args.name === "string" ? args.name : "";
      if (!repoNameArg) return { error: "Missing required argument: name" };
      if (store.repos.has(repoNameArg)) return { error: `Repository ${repoNameArg} already exists` };
      const description = typeof args.description === "string" ? args.description : "";
      const repo = createRepo(store, repoNameArg, description, false);
      return { value: serializeRepo(store, repo, baseUrl) };
    }
    case "get_repo": {
      const repo = getRepo();
      if (!repo) return { error: `Repository ${owner}/${repoName} not found` };
      return { value: serializeRepo(store, repo, baseUrl) };
    }
    case "create_issue": {
      const repo = getRepo();
      if (!repo) return { error: `Repository ${owner}/${repoName} not found` };
      const title = typeof args.title === "string" ? args.title : "";
      if (!title) return { error: "Missing required argument: title" };
      const number = repo.nextNumber++;
      const id = store.nextObjectId++;
      const now = store.clock.nextIso();
      const issue: Issue = {
        id,
        nodeId: Buffer.from(`Issue:${id}`).toString("base64"),
        number,
        title,
        body: typeof args.body === "string" ? args.body : "",
        state: "open",
        labels: [],
        userLogin: store.login,
        createdAt: now,
        updatedAt: now,
        closedAt: null,
        comments: 0,
      };
      repo.issues.set(number, issue);
      return { value: serializeIssue(store, repo, issue, baseUrl) };
    }
    case "list_issues": {
      const repo = getRepo();
      if (!repo) return { error: `Repository ${owner}/${repoName} not found` };
      const state = typeof args.state === "string" ? args.state : "open";
      let list = [...repo.issues.values()].sort((a, b) => a.number - b.number);
      if (state !== "all") list = list.filter((i) => i.state === state);
      return { value: list.map((i) => serializeIssue(store, repo, i, baseUrl)) };
    }
    case "create_pull_request": {
      const repo = getRepo();
      if (!repo) return { error: `Repository ${owner}/${repoName} not found` };
      const title = typeof args.title === "string" ? args.title : "";
      const head = typeof args.head === "string" ? args.head : "";
      const base = typeof args.base === "string" ? args.base : repo.defaultBranch;
      if (!title || !head) return { error: "Missing required argument: title/head" };
      const headTip = branchTip(repo, head);
      const baseTip = branchTip(repo, base);
      if (!headTip || !baseTip) return { error: "head branch does not exist" };
      const number = repo.nextNumber++;
      const id = store.nextObjectId++;
      const now = store.clock.nextIso();
      const pr: PullRequest = {
        id,
        nodeId: Buffer.from(`PullRequest:${id}`).toString("base64"),
        number,
        title,
        body: typeof args.body === "string" ? args.body : "",
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
      return { value: serializePull(store, repo, pr, baseUrl) };
    }
    case "merge_pull_request": {
      const repo = getRepo();
      if (!repo) return { error: `Repository ${owner}/${repoName} not found` };
      const number = typeof args.pull_number === "number" ? args.pull_number : NaN;
      const pr = repo.pulls.get(number);
      if (!pr) return { error: `Pull request ${number} not found` };
      if (pr.state !== "open") return { error: "Pull request is already merged" };
      if (!prMergeable(repo, pr)) return { error: "Merge conflict" };
      const result = squashMerge(store, repo, pr);
      if ("conflict" in result) return { error: "Merge conflict" };
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
      return { value: { sha: result.sha, merged: true, message: "Pull request successfully merged" } };
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}
