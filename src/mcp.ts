// MCP: JSON-RPC 2.0 over Streamable HTTP. Serves server/discover (revision
// 2026-07-28) and the legacy initialize handshake, a fixed six-tool list,
// and tools/call dispatch onto the same store the REST surface uses.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError, Store, VIEWER_LOGIN } from './store.ts';
import { isRecord, readBody, sendJson } from './http-util.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
    additionalProperties: boolean;
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The owner login (defaults to the authenticated user).' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Issue state filter: open, closed or all.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

const SYNONYMS: Record<string, string> = {
  repository: 'repo',
  repo_name: 'repo',
  repository_name: 'repo',
  number: 'pull_number',
  pullNumber: 'pull_number',
  issue_number: 'number',
  owner_name: 'owner',
};

/** Map a caller's arguments onto a tool schema's property names. */
function mapArguments(tool: ToolDef, args: Record<string, unknown>): Record<string, unknown> {
  const props = tool.inputSchema.properties;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === '_meta') continue;
    if (key in props) {
      out[key] = value;
      continue;
    }
    const synonym = SYNONYMS[key];
    if (synonym !== undefined && synonym in props) {
      out[synonym] = value;
      continue;
    }
  }
  // A full_name of "owner/repo" fills whichever of owner/repo is missing.
  const fullName = args['full_name'];
  if (typeof fullName === 'string' && fullName.includes('/')) {
    const [ownerPart, repoPart] = fullName.split('/', 2) as [string, string];
    if (out['owner'] === undefined && 'owner' in props) out['owner'] = ownerPart;
    if (out['repo'] === undefined && 'repo' in props) out['repo'] = repoPart;
  }
  return out;
}

function missingRequired(tool: ToolDef, args: Record<string, unknown>): string | null {
  for (const key of tool.inputSchema.required) {
    if (args[key] === undefined || args[key] === null || args[key] === '') return key;
  }
  return null;
}

function toolResult(result: unknown, isError = false): Record<string, unknown> {
  const text = typeof result === 'string' ? result : JSON.stringify(result);
  return {
    content: [{ type: 'text', text }],
    structuredContent: result,
    isError,
  };
}

function toolError(message: string): Record<string, unknown> {
  return toolResult({ error: message }, true);
}

function strArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

function intArg(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value === 'number') return Math.floor(value);
  if (typeof value === 'string') return Number(value);
  return Number.NaN;
}

/** Run one tool against the store; returns the tool-result envelope. */
function callTool(store: Store, name: string, rawArgs: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    throw { code: -32602, message: `Unknown tool: ${name}` };
  }
  const args = mapArguments(tool, rawArgs);
  const missing = missingRequired(tool, args);
  if (missing !== null) return toolError(`Missing required argument: ${missing}`);
  try {
    if (name === 'create_repo') {
      const owner = strArg(args, 'owner');
      if (owner !== '' && owner !== VIEWER_LOGIN) return toolError(`Cannot create a repository for owner ${owner}`);
      const repo = store.createRepo(strArg(args, 'name'), strArg(args, 'description'), args['private'] === true);
      return toolResult(store.repoView(repo));
    }
    if (name === 'get_repo') {
      const repo = store.lookupRepo(strArg(args, 'owner'), strArg(args, 'repo'));
      return toolResult(store.repoView(repo));
    }
    if (name === 'create_issue') {
      const repo = store.lookupRepo(strArg(args, 'owner'), strArg(args, 'repo'));
      const labels = Array.isArray(args['labels'])
        ? (args['labels'] as unknown[]).filter((item) => typeof item === 'string') as string[]
        : [];
      const issue = store.createIssue(repo, strArg(args, 'title'), strArg(args, 'body'), labels);
      return toolResult(store.issueView(repo, issue));
    }
    if (name === 'list_issues') {
      const repo = store.lookupRepo(strArg(args, 'owner'), strArg(args, 'repo'));
      const state = strArg(args, 'state') === '' ? 'open' : strArg(args, 'state');
      const issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      const payload = { issues: issues.map((issue) => store.issueView(repo, issue)) };
      return toolResult(payload);
    }
    if (name === 'create_pull_request') {
      const repo = store.lookupRepo(strArg(args, 'owner'), strArg(args, 'repo'));
      const pull = store.createPull(repo, strArg(args, 'title'), strArg(args, 'body'), strArg(args, 'head'), strArg(args, 'base'));
      return toolResult(store.pullView(repo, pull));
    }
    if (name === 'merge_pull_request') {
      const repo = store.lookupRepo(strArg(args, 'owner'), strArg(args, 'repo'));
      const number = intArg(args, 'pull_number');
      if (!Number.isInteger(number)) return toolError('pull_number must be an integer');
      const pull = store.findPull(repo, number);
      const { sha, message } = store.mergePull(repo, pull);
      return toolResult({ ...store.pullView(repo, pull), merged: true, sha, message });
    }
  } catch (error) {
    if (error instanceof ApiError) return toolError(error.message);
    throw error;
  }
  return toolError(`Tool ${name} is not implemented`);
}

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function rpcResult(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function serverInfo(): Record<string, unknown> {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

/** Handle one JSON-RPC request object; null means "no response" (notification). */
function handleRpc(store: Store, request: RpcRequest): Record<string, unknown> | null {
  const id = request.id === undefined ? null : request.id;
  const method = request.method ?? '';
  if (method.startsWith('notifications/')) return null;
  if (method === 'server/discover') {
    return rpcResult(id, {
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {}, logging: {} },
      serverInfo: serverInfo(),
      instructions: 'A GitHub-compatible git forge. Tools create and read repositories, issues and pull requests.',
      _meta: {
        'io.modelcontextprotocol/serverInfo': serverInfo(),
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      },
    });
  }
  if (method === 'initialize') {
    const params = isRecord(request.params) ? request.params : {};
    const requested = typeof params['protocolVersion'] === 'string' ? (params['protocolVersion'] as string) : '';
    const version = LEGACY_VERSIONS.includes(requested) ? requested : '2025-11-25';
    return rpcResult(id, {
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: serverInfo(),
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
    });
  }
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const params = isRecord(request.params) ? request.params : {};
    const toolName = typeof params['name'] === 'string' ? params['name'] : '';
    const args = isRecord(params['arguments']) ? (params['arguments'] as Record<string, unknown>) : {};
    try {
      const result = callTool(store, toolName, args);
      return rpcResult(id, result);
    } catch (error) {
      if (isRecord(error) && typeof error['code'] === 'number') {
        return rpcError(id, error['code'] as number, typeof error['message'] === 'string' ? (error['message'] as string) : 'Tool error');
      }
      throw error;
    }
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  if (req.method === 'DELETE') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, store, 405, { message: 'Method Not Allowed' });
    return;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
    return;
  }
  const header = req.headers.authorization;
  if (header !== `Bearer ${store.token}`) {
    const id = isRecord(parsed) && (typeof parsed['id'] === 'string' || typeof parsed['id'] === 'number') ? (parsed['id'] as string | number) : null;
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32001, message: 'Unauthorized' } }));
    return;
  }
  if (Array.isArray(parsed)) {
    const results: Record<string, unknown>[] = [];
    for (const item of parsed) {
      if (!isRecord(item)) continue;
      const out = handleRpc(store, item as RpcRequest);
      if (out !== null) results.push(out);
    }
    sendJson(res, store, 200, results);
    return;
  }
  if (!isRecord(parsed)) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
    return;
  }
  const out = handleRpc(store, parsed as RpcRequest);
  if (out === null) {
    res.writeHead(202);
    res.end();
    return;
  }
  sendJson(res, store, 200, out);
}
