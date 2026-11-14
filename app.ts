// HTTP server: routing, auth, request ids. One process, standard library only.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { makeStore, nextRequestId, type Store } from "./store.ts";
import { dispatchRest, HttpError } from "./rest.ts";
import { executeGraphQL } from "./graphql.ts";
import { handleMcp } from "./mcp.ts";
import {
  handleReceivePack,
  handleUploadPackV0,
  handleUploadPackV2,
  receivePackAdvertisement,
  uploadPackAdvertisement,
} from "./gitproto.ts";

export interface ServerOptions {
  token: string;
  login: string;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: string, extraHeaders?: Record<string, string>): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function sendBuffer(
  res: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  extraHeaders?: Record<string, string>,
): void {
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": body.length,
    ...extraHeaders,
  });
  res.end(body);
}

export function createForgeServer(opts: ServerOptions): Server {
  const store: Store = makeStore(opts.login);
  const expectedToken = opts.token;

  const authed = (req: IncomingMessage): boolean => {
    if (!expectedToken) return true;
    const h = req.headers.authorization ?? "";
    return h === `Bearer ${expectedToken}`;
  };

  const server = createServer((req, res) => {
    void (async (): Promise<void> => {
      try {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
        const method = req.method ?? "GET";
        const segments = url.pathname.split("/").filter((s) => s.length > 0);
        const baseUrl = `http://${req.headers.host ?? "127.0.0.1"}`;
        const requestId = nextRequestId(store);

        // Readiness probe used by the kit's conformance suite.
        if (url.pathname === "/healthz" && method === "GET") {
          sendJson(res, 200, JSON.stringify({ status: "ok" }), { "X-GitHub-Request-Id": requestId });
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        if (segments.length >= 3 && segments[1].endsWith(".git")) {
          const owner = segments[0];
          const repoName = segments[1].slice(0, -4);
          const sub = segments[2];
          if (owner !== store.login || !store.repos.has(repoName)) {
            sendJson(res, 404, JSON.stringify({ message: "Not Found" }), { "X-GitHub-Request-Id": requestId });
            return;
          }
          const repo = store.repos.get(repoName)!;
          if (sub === "info" && segments[3] === "refs" && method === "GET") {
            const service = url.searchParams.get("service") ?? "";
            if (service === "git-upload-pack") {
              const v2 = (req.headers["git-protocol"] ?? "") === "version=2";
              sendBuffer(
                res,
                200,
                uploadPackAdvertisement(repo, v2),
                "application/x-git-upload-pack-advertisement",
              );
              return;
            }
            if (service === "git-receive-pack") {
              sendBuffer(
                res,
                200,
                receivePackAdvertisement(repo),
                "application/x-git-receive-pack-advertisement",
              );
              return;
            }
            sendJson(res, 404, JSON.stringify({ message: "Not Found" }), { "X-GitHub-Request-Id": requestId });
            return;
          }
          if (sub === "git-upload-pack" && method === "POST") {
            const body = await readBody(req);
            const v2 = (req.headers["git-protocol"] ?? "") === "version=2";
            const out = v2 ? handleUploadPackV2(repo, body) : handleUploadPackV0(repo, body);
            sendBuffer(res, 200, out, "application/x-git-upload-pack-result");
            return;
          }
          if (sub === "git-receive-pack" && method === "POST") {
            const body = await readBody(req);
            const out = handleReceivePack(repo, body);
            sendBuffer(res, out.status, out.body, "application/x-git-receive-pack-result");
            return;
          }
          sendJson(res, 404, JSON.stringify({ message: "Not Found" }), { "X-GitHub-Request-Id": requestId });
          return;
        }

        // REST v3 under /api/v3
        if (segments[0] === "api" && segments[1] === "v3") {
          if (!authed(req)) {
            sendJson(res, 401, JSON.stringify({ message: "Requires authentication" }), {
              "X-GitHub-Request-Id": requestId,
            });
            return;
          }
          const body = await readBody(req);
          const rest = dispatchRest(store, method, segments.slice(2), url.searchParams, body, baseUrl);
          const headers: Record<string, string> = { "X-GitHub-Request-Id": requestId, ...(rest.headers ?? {}) };
          if (rest.status === 204) {
            res.writeHead(204, headers);
            res.end();
            return;
          }
          sendJson(res, rest.status, rest.body, headers);
          return;
        }

        // GraphQL at /api/graphql
        if (segments[0] === "api" && segments[1] === "graphql") {
          if (method !== "POST") {
            sendJson(res, 404, JSON.stringify({ message: "Not Found" }), { "X-GitHub-Request-Id": requestId });
            return;
          }
          if (!authed(req)) {
            sendJson(res, 401, JSON.stringify({ message: "Requires authentication" }), {
              "X-GitHub-Request-Id": requestId,
            });
            return;
          }
          const raw = await readBody(req);
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(raw.toString("utf8"));
          } catch {
            sendJson(res, 400, JSON.stringify({ errors: [{ message: "Request body must be a JSON object." }] }), {
              "X-GitHub-Request-Id": requestId,
            });
            return;
          }
          const out = executeGraphQL(store, baseUrl, parsed);
          sendJson(res, out.status, out.body, { "X-GitHub-Request-Id": requestId });
          return;
        }

        // MCP at /mcp
        if (segments[0] === "mcp" && segments.length === 1) {
          if (method !== "POST") {
            sendJson(res, 404, JSON.stringify({ message: "Not Found" }), { "X-GitHub-Request-Id": requestId });
            return;
          }
          const raw = await readBody(req);
          const out = handleMcp(store, baseUrl, raw, authed(req));
          if (out.status === 202) {
            res.writeHead(202, { "X-GitHub-Request-Id": requestId });
            res.end();
            return;
          }
          sendJson(res, out.status, out.body, { "X-GitHub-Request-Id": requestId });
          return;
        }

        sendJson(res, 404, JSON.stringify({ message: "Not Found" }), { "X-GitHub-Request-Id": requestId });
      } catch (e) {
        if (e instanceof HttpError) {
          sendJson(res, e.status, JSON.stringify({ message: e.message }), {
            "X-GitHub-Request-Id": nextRequestId(store),
          });
          return;
        }
        // Never leak a stack or HTML: a JSON error body, always.
        sendJson(res, 500, JSON.stringify({ message: "Internal Server Error" }), {
          "X-GitHub-Request-Id": nextRequestId(store),
        });
      }
    })();
  });
  return server;
}
