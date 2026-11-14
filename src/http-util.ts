// Small HTTP helpers shared by every surface: body reading, JSON replies,
// bearer-token auth against the trial token, and the request-id header.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.ts';

/** Read a request body fully (up to 64 MiB; anything bigger is rejected). */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) {
        reject(new Error('request body is too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Send a JSON object with the API headers every REST/GraphQL reply carries. */
export function sendJson(
  res: ServerResponse,
  store: Store,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': payload.length,
    'x-github-request-id': store.nextRequestId(),
    ...extra,
  });
  res.end(payload);
}

/** Send an already-serialised JSON body with the same API headers. */
export function sendRawJson(
  res: ServerResponse,
  store: Store,
  status: number,
  payload: Buffer,
  extra: Record<string, string> = {},
): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': payload.length,
    'x-github-request-id': store.nextRequestId(),
    ...extra,
  });
  res.end(payload);
}

/** Send a JSON error body with a string message. */
export function sendError(res: ServerResponse, store: Store, status: number, message: string): void {
  sendJson(res, store, status, { message });
}

/** Parse a JSON body; returns null and already answers 400 when it is malformed. */
export function parseJsonBody(res: ServerResponse, store: Store, raw: Buffer): unknown | null {
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    sendError(res, store, 400, 'Malformed JSON in request body');
    return null;
  }
}

/** True when the request carries exactly `Bearer <trial token>`. */
export function isAuthenticated(req: IncomingMessage, store: Store): boolean {
  const header = req.headers.authorization;
  if (header === undefined) return false;
  return header === `Bearer ${store.token}`;
}

/** Answer 401 JSON when the request is not authenticated; true when it passed. */
export function requireAuth(req: IncomingMessage, res: ServerResponse, store: Store): boolean {
  if (isAuthenticated(req, store)) return true;
  sendError(res, store, 401, 'Requires authentication');
  return false;
}

/** A JSON object check, used before reading typed fields off a body. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read a string field, defaulting when it is missing or not a string. */
export function strField(body: Record<string, unknown>, key: string, fallback = ''): string {
  const value = body[key];
  return typeof value === 'string' ? value : fallback;
}
