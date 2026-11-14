// HTTP server: one in-memory store, four surfaces. Git smart-HTTP answers
// /{owner}/{repo}.git/*, REST v3 answers /api/v3/*, GraphQL answers
// /api/graphql and MCP answers /mcp. Everything else is a JSON 404.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './src/store.ts';
import { handleGit } from './src/git-http.ts';
import { handleRest } from './src/rest.ts';
import { handleGraphql } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { sendJson } from './src/http-util.ts';

async function route(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  const rawUrl = req.url ?? '/';
  const cut = rawUrl.indexOf('?');
  const path = cut < 0 ? rawUrl : rawUrl.slice(0, cut);

  if (path === '/healthz' && req.method === 'GET') {
    sendJson(res, store, 200, { ok: true });
    return;
  }

  if (path === '/api/graphql') {
    await handleGraphql(req, res, store);
    return;
  }

  if (path === '/mcp') {
    await handleMcp(req, res, store);
    return;
  }

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    await handleRest(req, res, store, path);
    return;
  }

  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(path);
  if (gitMatch !== null) {
    const owner = decodeURIComponent(gitMatch[1] as string);
    const repoName = decodeURIComponent(gitMatch[2] as string);
    const servicePath = gitMatch[3] as string;
    await handleGit(req, res, store, owner, repoName, servicePath);
    return;
  }

  sendJson(res, store, 404, { message: 'Not Found' });
}

export function createApp(store: Store): Server {
  return createServer((req, res) => {
    void route(req, res, store).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'Internal Server Error' }));
      }
    });
  });
}
