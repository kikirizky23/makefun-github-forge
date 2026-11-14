// The entry's HTTP server: one in-memory Store, one http server, four handler groups.
//
// Routing order (first non-null answer wins):
//   GET /healthz            -> 200 {"ok":true}, no auth (the env's boot probe)
//   GET /api/v3[/]          -> 200 API root + X-Oauth-Scopes, no auth (as the starter shipped it)
//   git handlers           -> /<owner>/<repo>.git/info/refs, git-upload-pack, git-receive-pack
//   rest handlers          -> /api/v3/... (REST v3 resources)
//   graphql handlers       -> POST /api/graphql
//   mcp handlers           -> POST /mcp
//   anything else          -> 404 {"message":"Not Found"}, every method
//
// Every reply carries X-GitHub-Request-Id (non-empty, `req-<n>`) and content-type
// application/json, except git pack bytes, which keep the content-type the git handler sets.
// A handler that throws never crashes the process: app.ts answers 500
// {"message":"Internal Server Error"} (never HTML).
//
// Malformed JSON: app.ts parses leniently and passes `jsonValid` through in the Ctx; a handler
// whose route needs a body answers 400 {"message":"Invalid JSON"} itself when jsonValid is false.
// (An empty body is not malformed: json is null and jsonValid is true.)
//
// Auth: `authed` is an exact `Authorization: Bearer ${MAKEFUN_SHOP_TOKEN}` match. An empty
// MAKEFUN_SHOP_TOKEN authenticates nothing. Whether a route refuses an unauthenticated call
// (401) is the route handler's decision; /healthz and the API root never require it.
//
// Perf: no per-request logging, no fsync, no wall clock in the request path (all timestamps come
// from store.nowIso()), keep-alive on (node default). The body cap is 64 MiB; past it the
// request is answered 413 {"message":"Payload Too Large"}.
//
// INTEGRATION (round 2): the handler modules are imported STATICALLY and fail
// fast at startup if any fails to load — there is no null-slot fallback, so a
// broken module can never silently 404 its whole surface. Dispatch iterates
// the four handler arrays in order git -> rest -> graphql -> mcp; the first
// non-null Resp wins. `ctx.login` is the Store's viewer login
// (`store.viewer.login`, 'adaiversen'); the Store has no `login` property.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Ctx, Handler, Resp } from './lib/types.ts';
import { Store } from './lib/store.ts';
import { gitHandlers } from './lib/git.ts';
import { restHandlers } from './lib/rest.ts';
import { graphqlHandlers } from './lib/graphql.ts';
import { mcpHandlers } from './lib/mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** All handlers in dispatch order: git -> rest -> graphql -> mcp. First non-null wins. */
const handlers: Handler[] = [...gitHandlers, ...restHandlers, ...graphqlHandlers, ...mcpHandlers];

/** Monotonic per-process request counter; the request id is `req-<n>`. */
let requestCounter = 0;

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** Read the full request body, capped at MAX_BODY_BYTES. `tooLarge` when the cap was passed. */
function readBody(req: IncomingMessage): Promise<{ body: Buffer; tooLarge: boolean }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const finish = (body: Buffer, tooLarge: boolean): void => {
      if (done) return;
      done = true;
      resolve({ body, tooLarge });
    };
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        finish(Buffer.concat(chunks), true);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(Buffer.concat(chunks), false));
    req.on('error', () => finish(Buffer.concat(chunks), false));
  });
}

/** Answer one request. `resp.headers` win over the JSON defaults (git pack bytes keep theirs). */
function sendResp(res: ServerResponse, resp: Resp, requestId: string): void {
  const headers: Record<string, string> = { 'x-github-request-id': requestId };
  let hasContentType = false;
  if (resp.headers !== undefined) {
    for (const [key, value] of Object.entries(resp.headers)) {
      headers[key.toLowerCase()] = value;
      if (key.toLowerCase() === 'content-type') hasContentType = true;
    }
  }
  if (!hasContentType) headers['content-type'] = JSON_TYPE;
  const body = typeof resp.body === 'string' ? Buffer.from(resp.body, 'utf8') : resp.body;
  headers['content-length'] = String(body.length);
  res.writeHead(resp.status, headers);
  res.end(body);
}

/** A JSON Resp with a trailing newline, as the starter sent them. */
function jsonResp(status: number, body: unknown, headers?: Record<string, string>): Resp {
  return { status, headers, body: `${JSON.stringify(body)}\n` };
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  // One Store for the process's life.
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      const requestId = `req-${++requestCounter}`;
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';

        // The env's boot check calls this twice: 200 {"ok":true}. No auth, no body read.
        if (method === 'GET' && path === '/healthz') {
          sendResp(res, jsonResp(200, { ok: true }), requestId);
          return;
        }

        // The GitHub API root: a 200 with the token's scopes, as api.github.com answers GET /.
        if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
          sendResp(res, jsonResp(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' }), requestId);
          return;
        }

        const { body: rawBody, tooLarge } = await readBody(req);
        if (tooLarge) {
          sendResp(res, jsonResp(413, { message: 'Payload Too Large' }), requestId);
          return;
        }

        // Lenient JSON: an empty body is json null, jsonValid true; a present but unparsable
        // body is json null, jsonValid false, and the matched handler answers the 400.
        let json: unknown = null;
        let jsonValid = true;
        if (rawBody.length > 0) {
          try {
            json = JSON.parse(rawBody.toString('utf8'));
          } catch {
            json = null;
            jsonValid = false;
          }
        }

        const headers = new Map<string, string>();
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === 'string') headers.set(key.toLowerCase(), value);
          else if (Array.isArray(value) && typeof value[0] === 'string') headers.set(key.toLowerCase(), value[0]);
        }
        const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
        const authed = token !== '' && (headers.get('authorization') ?? '') === `Bearer ${token}`;

        const ctx: Ctx = {
          store,
          method,
          path,
          query: new URL(req.url ?? '/', 'http://entry').searchParams,
          headers,
          rawBody,
          json,
          jsonValid,
          authed,
          login: store.viewer.login,
          requestId,
        };

        let out: Resp | null = null;
        for (const handler of handlers) {
          out = await handler(ctx);
          if (out !== null) break;
        }
        if (out === null) out = jsonResp(404, { message: 'Not Found' });
        sendResp(res, out, requestId);
      } catch {
        // A handler throw (or a dispatch failure) is a 500, never a crash and never HTML.
        // The response may already be half-sent only if sendResp itself threw; in that case
        // there is nothing safe left to write, so guard the write.
        try {
          if (!res.headersSent) sendResp(res, jsonResp(500, { message: 'Internal Server Error' }), requestId);
          else res.destroy();
        } catch {
          // Nothing left to do: the socket is already gone.
        }
      }
    })();
  });
}
