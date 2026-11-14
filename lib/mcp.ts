// POST /mcp — Model Context Protocol, JSON-RPC 2.0 Streamable HTTP transport.
// Speaks both eras the suite accepts:
//   modern 2026-07-28: server/discover (supportedVersions, capabilities,
//           serverInfo) — no handshake, no session;
//   legacy 2025-11-25 and earlier: initialize + notifications/initialized,
//           with a stable Mcp-Session-Id header.
// Tools act on the SAME store as REST/GraphQL, so ids are unchanged across
// surfaces. Tools are plain names (no prefix). tools/list is built once and
// serialised once, so two calls are byte-identical.
//
// Auth: ctx.authed (Bearer MAKEFUN_SHOP_TOKEN). No auth -> 401. Non-JSON body
// -> HTTP 400 with JSON-RPC -32700. Unknown tool -> -32602. Missing required
// argument -> -32602. Determinism: no wall clock, no Math.random; the session
// id is a fixed constant.

import type { Ctx, Handler, Issue, Pull, Repo, Resp, Store } from './types.ts';

export const MCP_PATH = '/mcp';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const SESSION_ID = 'github-forge-mcp-1';

const SUPPORTED_VERSIONS: string[] = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository to create.' },
        owner: { type: 'string', description: 'The owner login; defaults to the authenticated user.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
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
        full_name: { type: 'string', description: 'The full repository name "owner/repo".' },
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
        full_name: { type: 'string', description: 'The full repository name "owner/repo".' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
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
        full_name: { type: 'string', description: 'The full repository name "owner/repo".' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The full repository name "owner/repo".' },
        title: { type: 'string', description: 'The title of the pull request.' },
        body: { type: 'string', description: 'The body of the pull request.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The full repository name "owner/repo".' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

// The tools/list result, built and serialised once: two calls are byte-identical.
const TOOLS_LIST_RESULT: Record<string, unknown> = { tools: TOOLS };
const TOOLS_LIST_JSON = JSON.stringify(TOOLS_LIST_RESULT);

function serverInfo(): Record<string, string> {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Argument helpers: accept the documented property names plus the suite's
// synonym spellings and a full_name "owner/repo" fallback.
// ---------------------------------------------------------------------------

function strArg(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

function numArg(args: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  return undefined;
}

function resolveOwnerRepo(args: Record<string, unknown>): { owner: string; repo: string } | null {
  const full = strArg(args, 'full_name', 'repo_full_name', 'repository_full_name', 'fullName');
  if (full !== undefined) {
    const slash = full.indexOf('/');
    if (slash > 0 && slash < full.length - 1) {
      return { owner: full.slice(0, slash), repo: full.slice(slash + 1) };
    }
  }
  const owner = strArg(args, 'owner', 'owner_login', 'org', 'organization', 'organisation', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name');
  const repo = strArg(args, 'repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name');
  if (owner === undefined || repo === undefined) return null;
  return { owner, repo };
}

function findRepo(store: Store, args: Record<string, unknown>): Repo | undefined {
  const resolved = resolveOwnerRepo(args);
  if (resolved === null) return undefined;
  return store.getRepo(resolved.owner, resolved.repo);
}

// ---------------------------------------------------------------------------
// Tool execution. Returns a tools/call result object; throws ToolError for
// failures the caller reports as isError:true.
// ---------------------------------------------------------------------------

class ToolError extends Error {}

function toolResult(value: unknown): Record<string, unknown> {
  const clean = sanitizeForJson(value);
  const text = typeof clean === 'string' ? clean : JSON.stringify(clean);
  return {
    content: [{ type: 'text', text }],
    structuredContent: clean,
  };
}

// The store's shapes are cyclic (Pull.head.repo -> Repo -> pulls -> the same
// Pull) and carry Maps (objects/refs/files) and underscore internals. Serialise
// a cycle-safe, plain-JSON copy: nested repos collapse to a summary, Maps and
// underscore-prefixed internals are dropped, repeated references are dropped.
function sanitizeForJson(value: unknown): unknown {
  const seen = new WeakSet<object>();
  const walk = (v: unknown, isRoot: boolean): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (v instanceof Map) return undefined;
    if (v instanceof Buffer) return v.toString('utf8');
    if (seen.has(v)) return undefined;
    if (isRecord(v) && typeof v.full_name === 'string' && Array.isArray(v.pulls) && Array.isArray(v.issues) && !isRoot) {
      return {
        id: v.id, name: v.name, full_name: v.full_name,
        owner: isRecord(v.owner) ? { login: v.owner.login } : undefined,
        description: v.description ?? null, private: v.private === true,
        default_branch: v.default_branch, html_url: v.html_url ?? null,
      };
    }
    seen.add(v);
    if (Array.isArray(v)) return v.map((entry) => walk(entry, false));
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(v)) {
      if (key.startsWith('_')) continue;
      const cleaned = walk(entry, false);
      if (cleaned !== undefined) out[key] = cleaned;
    }
    return out;
  };
  return walk(value, true);
}

function toolErrorResult(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    structuredContent: { error: message },
    isError: true,
  };
}

function executeTool(ctx: Ctx, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const store = ctx.store;
  switch (name) {
    case 'create_repo': {
      const repoName = strArg(args, 'name', 'repo', 'repository', 'repository_name', 'repo_name');
      if (repoName === undefined) throw new ToolError('Missing required argument: name');
      const description = strArg(args, 'description', 'about', 'summary', 'body');
      const isPrivate = args.private === true || args.is_private === true;
      const existing = store.getRepo(ctx.login !== '' ? ctx.login : store.viewer.login, repoName);
      if (existing !== undefined) return toolResult(existing);
      const repo = store.createRepo(repoName, {
        description,
        private: isPrivate,
      });
      return toolResult(repo);
    }
    case 'get_repo': {
      const repo = findRepo(store, args);
      if (repo === undefined) throw new ToolError(`Repository ${String(strArg(args, 'full_name') ?? `${String(args.owner ?? '')}/${String(args.repo ?? '')}`)} not found`);
      return toolResult(repo);
    }
    case 'create_issue': {
      const repo = findRepo(store, args);
      if (repo === undefined) throw new ToolError('Repository not found');
      const title = strArg(args, 'title', 'issue_title', 'pr_title', 'pull_request_title', 'subject');
      if (title === undefined) throw new ToolError('Missing required argument: title');
      const body = strArg(args, 'body', 'issue_body', 'description', 'content', 'text', 'comment');
      const created = store.createIssue(repo, { title, body: body ?? '' });
      if (isRecord(created) && typeof created.error === 'string') {
        throw new ToolError(`Unknown label "${String((created as { label?: unknown }).label ?? '')}"`);
      }
      return toolResult(created as Issue);
    }
    case 'list_issues': {
      const repo = findRepo(store, args);
      if (repo === undefined) throw new ToolError('Repository not found');
      const state = strArg(args, 'state', 'status');
      const normalized = state === undefined ? undefined : state.toLowerCase();
      const issues = store.listIssues(repo, normalized === 'open' || normalized === 'closed' ? { state: normalized } : {});
      return toolResult(issues);
    }
    case 'create_pull_request': {
      const repo = findRepo(store, args);
      if (repo === undefined) throw new ToolError('Repository not found');
      const title = strArg(args, 'title', 'issue_title', 'pr_title', 'pull_request_title', 'subject');
      const head = strArg(args, 'head', 'head_ref', 'head_branch', 'pull_request_head', 'pr_head', 'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch');
      const base = strArg(args, 'base', 'base_ref', 'base_branch', 'pull_request_base', 'pr_base', 'target', 'target_ref', 'target_branch', 'into', 'into_branch');
      if (title === undefined) throw new ToolError('Missing required argument: title');
      if (head === undefined) throw new ToolError('Missing required argument: head');
      if (base === undefined) throw new ToolError('Missing required argument: base');
      const body = strArg(args, 'body', 'issue_body', 'description', 'content', 'text', 'comment');
      const created = store.createPull(repo, { title, body: body ?? '', head, base });
      if (isRecord(created) && typeof created.error === 'string') {
        throw new ToolError(created.error === 'head' ? `Head branch "${head}" does not exist` : `Base branch "${base}" does not exist`);
      }
      return toolResult(created as Pull);
    }
    case 'merge_pull_request': {
      const repo = findRepo(store, args);
      if (repo === undefined) throw new ToolError('Repository not found');
      const number = numArg(args, 'pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index');
      if (number === undefined) throw new ToolError('Missing required argument: pull_number');
      const merged = store.mergePull(repo, number, 'merge');
      // Narrow on the discriminant: the success variant has no `error`
      // property, so accessing `.error` on the union is a TS2339.
      if ('error' in merged) {
        throw new ToolError(merged.error === 'not-found' ? `Pull request #${number} not found` : merged.error === 'closed' ? `Pull request #${number} is closed` : `Pull request #${number} has a merge conflict`);
      }
      const pull = store.getPull(repo, number);
      if (pull === undefined) throw new ToolError(`Pull request #${number} could not be read after merging`);
      return toolResult(pull);
    }
    default:
      throw new ToolError(`Unknown tool: ${name}`);
  }
}

// Required arguments per tool, in canonical property names. A call missing
// one answers -32602 (or isError:true); the dispatcher uses -32602.
function missingRequired(name: string, args: Record<string, unknown>): string[] {
  const missing: string[] = [];
  const hasRepo = resolveOwnerRepo(args) !== null;
  switch (name) {
    case 'create_repo':
      if (strArg(args, 'name', 'repo', 'repository', 'repository_name', 'repo_name') === undefined) missing.push('name');
      break;
    case 'get_repo': case 'list_issues':
      if (!hasRepo) { missing.push('owner', 'repo'); }
      break;
    case 'create_issue':
      if (!hasRepo) { missing.push('owner', 'repo'); }
      if (strArg(args, 'title', 'issue_title', 'pr_title', 'pull_request_title', 'subject') === undefined) missing.push('title');
      break;
    case 'create_pull_request':
      if (!hasRepo) { missing.push('owner', 'repo'); }
      if (strArg(args, 'title', 'issue_title', 'pr_title', 'pull_request_title', 'subject') === undefined) missing.push('title');
      if (strArg(args, 'head', 'head_ref', 'head_branch', 'pull_request_head', 'pr_head', 'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch') === undefined) missing.push('head');
      if (strArg(args, 'base', 'base_ref', 'base_branch', 'pull_request_base', 'pr_base', 'target', 'target_ref', 'target_branch', 'into', 'into_branch') === undefined) missing.push('base');
      break;
    case 'merge_pull_request':
      if (!hasRepo) { missing.push('owner', 'repo'); }
      if (numArg(args, 'pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index') === undefined) missing.push('pull_number');
      break;
    default:
      break;
  }
  return missing;
}

// ---------------------------------------------------------------------------
// JSON-RPC dispatch. One parsed request object -> a Resp, or null when it is
// a notification (answered with HTTP 202 and an empty body).
// ---------------------------------------------------------------------------

function rpcError(id: string | number | null, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

function rpcResult(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function declaredVersion(ctx: Ctx, params: Record<string, unknown> | undefined): string | undefined {
  const meta = isRecord(params?._meta) ? (params._meta as Record<string, unknown>) : undefined;
  const fromMeta = meta !== undefined ? meta['io.modelcontextprotocol/protocolVersion'] : undefined;
  if (typeof fromMeta === 'string' && fromMeta !== '') return fromMeta;
  if (typeof params?.protocolVersion === 'string' && params.protocolVersion !== '') return params.protocolVersion;
  const header = ctx.headers.get('mcp-protocol-version');
  if (header !== undefined && header !== '') return header;
  return undefined;
}

function dispatch(ctx: Ctx, request: unknown): Resp | null {
  const reqId = (r: Record<string, unknown>): string | number | null => {
    const id = r.id;
    return typeof id === 'string' || typeof id === 'number' ? id : null;
  };
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'mcp-session-id': SESSION_ID,
    'x-github-request-id': ctx.requestId !== '' ? ctx.requestId : 'mcp-1',
  };
  const respond = (status: number, body: unknown): Resp => ({ status, headers, body: JSON.stringify(body) });

  if (!isRecord(request)) {
    return respond(400, rpcError(null, -32600, 'Invalid Request: expected a JSON-RPC object'));
  }
  const method = request.method;
  const params = isRecord(request.params) ? request.params : {};
  const id = reqId(request);
  const isNotification = id === null && request.id === undefined;

  // Notifications (no id): no JSON-RPC response; 202 with an empty body.
  if (isNotification) {
    if (typeof method === 'string' && method.startsWith('notifications/')) {
      return { status: 202, headers, body: '' };
    }
    return { status: 202, headers, body: '' };
  }
  if (typeof method !== 'string' || method === '') {
    return respond(400, rpcError(id, -32600, 'Invalid Request: missing method'));
  }

  // Protocol-version gate: a declared revision we do not support is -32022
  // with the supported list (the client retries with one of them).
  if (method !== 'notifications/initialized') {
    const declared = declaredVersion(ctx, params);
    if (declared !== undefined && !SUPPORTED_VERSIONS.includes(declared)) {
      return respond(200, rpcError(id, -32022, `Unsupported protocol version: ${declared}`, { supported: [...SUPPORTED_VERSIONS] }));
    }
  }

  switch (method) {
    case 'server/discover': {
      const info = serverInfo();
      return respond(200, rpcResult(id, {
        resultType: 'server/discover',
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        instructions: 'GitHub-compatible git forge: repositories, issues and pull requests over MCP tools.',
        serverInfo: info,
        _meta: { 'io.modelcontextprotocol/serverInfo': info },
      }));
    }
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : declaredVersion(ctx, params);
      if (requested !== undefined && !SUPPORTED_VERSIONS.includes(requested)) {
        return respond(200, rpcError(id, -32602, `Unsupported protocol version: ${requested}`));
      }
      return respond(200, rpcResult(id, {
        protocolVersion: requested ?? '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: serverInfo(),
        instructions: 'GitHub-compatible git forge: repositories, issues and pull requests over MCP tools.',
      }));
    }
    case 'notifications/initialized': {
      return { status: 202, headers, body: '' };
    }
    case 'ping': {
      return respond(200, rpcResult(id, {}));
    }
    case 'tools/list': {
      // Reuse the pre-serialised tools array so two calls are byte-identical.
      return respond(200, rpcResult(id, JSON.parse(TOOLS_LIST_JSON) as Record<string, unknown>));
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? params.arguments : {};
      if (name === '') {
        return respond(200, rpcError(id, -32602, 'tools/call requires a tool name'));
      }
      const known = TOOLS.some((t) => t.name === name);
      if (!known) {
        return respond(200, rpcError(id, -32602, `Unknown tool: ${name}`));
      }
      const missing = missingRequired(name, args);
      if (missing.length > 0) {
        return respond(200, rpcError(id, -32602, `Missing required argument(s): ${missing.join(', ')}`));
      }
      try {
        return respond(200, rpcResult(id, executeTool(ctx, name, args)));
      } catch (err) {
        if (err instanceof ToolError) {
          return respond(200, rpcResult(id, toolErrorResult(err.message)));
        }
        return respond(200, rpcResult(id, toolErrorResult(err instanceof Error ? err.message : String(err))));
      }
    }
    default: {
      return respond(200, rpcError(id, -32601, `Method not found: ${method}`));
    }
  }
}

async function mcpHandler(ctx: Ctx): Promise<Resp | null> {
  if (ctx.method !== 'POST') return null;
  if (ctx.path !== MCP_PATH && ctx.path !== `${MCP_PATH}/`) return null;
  if (!ctx.authed) {
    return {
      status: 401,
      headers: {
        'content-type': 'application/json',
        'x-github-request-id': ctx.requestId !== '' ? ctx.requestId : 'mcp-1',
      },
      body: JSON.stringify({ message: 'Requires authentication' }),
    };
  }
  if (!ctx.jsonValid) {
    // A body that is not JSON: HTTP 400 with JSON-RPC -32700.
    return {
      status: 400,
      headers: {
        'content-type': 'application/json',
        'mcp-session-id': SESSION_ID,
        'x-github-request-id': ctx.requestId !== '' ? ctx.requestId : 'mcp-1',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: request body is not valid JSON' } }),
    };
  }
  const body = ctx.json;
  if (Array.isArray(body)) {
    // JSON-RPC batch: one response per request, notifications omitted.
    const responses: unknown[] = [];
    for (const entry of body) {
      const resp = dispatch(ctx, entry);
      if (resp !== null) {
        try { responses.push(JSON.parse(String(resp.body))); } catch { /* keep going */ }
      }
    }
    if (responses.length === 0) {
      return { status: 202, headers: { 'content-type': 'application/json', 'mcp-session-id': SESSION_ID }, body: '' };
    }
    return {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'mcp-session-id': SESSION_ID,
        'x-github-request-id': ctx.requestId !== '' ? ctx.requestId : 'mcp-1',
      },
      body: JSON.stringify(responses),
    };
  }
  return dispatch(ctx, body);
}

export const mcpHandlers: Handler[] = [mcpHandler];
