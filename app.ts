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

/**
 * Lazy read-only view over Node's already-lowercase-keyed `req.headers`, standing
 * in for the `Map<string, string>` the handlers expect. Every header access in
 * the codebase is `.get()` (git.ts `headerOf`, rest.ts `header`, mcp.ts, and the
 * `authed` check here), always with a lowercase name or one lowered before the
 * call, and Node lowercases incoming header names — so lowering on lookup is
 * exactly what the old eager Map copy did. Array values (e.g. `set-cookie`)
 * resolve to their first element and missing/undefined values stay undefined,
 * again exactly as the old copy did. This only avoids copying ~8 entries into
 * a fresh Map on every request; no handler-visible value changes.
 */
class HeaderView {
  private readonly raw: NodeJS.Dict<string | string[] | undefined>;
  constructor(raw: NodeJS.Dict<string | string[] | undefined>) {
    this.raw = raw;
  }
  get(name: string): string | undefined {
    const value = this.raw[name.toLowerCase()];
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value[0];
    return undefined;
  }
}

/**
 * Route-shape pre-filter: which handler groups can possibly answer this path.
 * Groups run in the same order as before (git -> rest -> graphql -> mcp) and
 * the first non-null Resp still wins. Each test is a SUPERSET of the group's
 * real guards, verified against the handler modules, so a group is skipped
 * only when it provably returns null for every method:
 * - git: GIT_ROUTE in lib/git.ts is
 *   /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/
 *   on the decoded path; with no '%' in the path decoding is the identity, so
 *   the raw segments must show <owner>/<repo>.git/<service> (3 segments) or
 *   <owner>/<repo>.git/info/refs (4 segments). The test ignores a trailing
 *   slash, which only makes it a superset — gitHandler itself still returns
 *   null for that path, and no other group can match a git-shaped path unless
 *   its own test below also fires.
 * - rest: every handler in lib/rest.ts matches through apiSegments (an
 *   optional leading `api/v3` stripped, then a first segment of `user`,
 *   `users`, `repos` or `meta`) — except hRoot/hCatchAll, which match the
 *   normPath `/api/v3` prefix. `segments()` collapses repeated slashes, so
 *   the test splits on '/' and drops empties instead of a literal prefix
 *   check (`/api//v3/user` really is a user route).
 * - graphql: lib/graphql.ts answers only POST /api/graphql[/].
 * - mcp: lib/mcp.ts answers only POST /mcp[/].
 * Any path containing '%' runs the FULL loop: percent-decoding inside the
 * handlers can turn it into a route shape the raw text does not show
 * (e.g. `/%75ser`, `/o/r%2Egit/info/refs`, or a malformed escape that makes
 * gitHandler return null), so no group may be skipped for it.
 */
function dispatchGroups(path: string, method: string): Handler[][] {
  if (path.includes('%')) return [gitHandlers, restHandlers, graphqlHandlers, mcpHandlers];
  const groups: Handler[][] = [];
  const segs = path.split('/').filter((s) => s.length > 0);
  if (
    (segs.length === 3 || segs.length === 4) &&
    segs[1] !== undefined &&
    segs[1].length > 4 &&
    segs[1].endsWith('.git') &&
    ((segs.length === 3 && (segs[2] === 'git-upload-pack' || segs[2] === 'git-receive-pack')) ||
      (segs.length === 4 && segs[2] === 'info' && segs[3] === 'refs'))
  ) {
    groups.push(gitHandlers);
  }
  // normPath (lib/rest.ts): strip one trailing slash, if any.
  const p = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  let rest = p === '/api/v3' || p.startsWith('/api/v3/');
  if (!rest) {
    let s = segs;
    if (s.length >= 2 && s[0] === 'api' && s[1] === 'v3') s = s.slice(2);
    rest = s.length > 0 && (s[0] === 'user' || s[0] === 'users' || s[0] === 'repos' || s[0] === 'meta');
  }
  if (rest) groups.push(restHandlers);
  if (method === 'POST' && (path === '/api/graphql' || path === '/api/graphql/')) {
    groups.push(graphqlHandlers);
  }
  if (method === 'POST' && (path === '/mcp' || path === '/mcp/')) groups.push(mcpHandlers);
  return groups;
}

/** Monotonic per-process request counter; the request id is `req-<n>`. */
let requestCounter = 0;

/**
 * Parse the request URL once; pathname and query both come from this one
 * object. Throws on an unparseable target — the caller's catch answers 500,
 * exactly as the old two-parse code did (`pathOf` fell back to '/', then the
 * second parse for the query threw inside the same try).
 */
function parseRequestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? '/', 'http://entry');
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
        const url = parseRequestUrl(req);
        const path = url.pathname;
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

        const headers = new HeaderView(req.headers) as unknown as Map<string, string>;
        const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
        const authed = token !== '' && (headers.get('authorization') ?? '') === `Bearer ${token}`;

        const ctx: Ctx = {
          store,
          method,
          path,
          query: url.searchParams,
          headers,
          rawBody,
          json,
          jsonValid,
          authed,
          login: store.viewer.login,
          requestId,
        };

        let out: Resp | null = null;
        for (const group of dispatchGroups(path, method)) {
          for (const handler of group) {
            out = await handler(ctx);
            if (out !== null) break;
          }
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
