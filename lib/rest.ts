// lib/rest.ts — GitHub REST v3 surface for the github-core-clone-01 forge entry.
//
// Covers the `repos`, `issues`, `pulls` groups and the REST share of `protocol`
// (see the kit's program/env/src/checks-rest.ts and rest-client.ts): API root,
// meta, user/user-repos, repo CRUD, branches, git refs, commits, contents,
// labels, issues + comments, pulls + files + merge, auth + JSON error shapes.
//
// Integration: app.ts statically imports `restHandlers` (the per-route
// handlers, most specific first, catch-all last) and dispatches them in
// order; `handleRest` is the same dispatch as a single Handler, for callers
// that want one function.
//
// SERIALIZER RULE (hard): NEVER JSON.stringify a raw store object. A store Pull's
// head.repo points at a Repo, and a Repo holds its pulls — stringifying either
// raw object throws on the cycle. Every reply below is built from an explicit
// JSON view that picks only the fields the client expects (head.repo is the
// RepoRef summary {id, name, full_name, owner}, never the full Repo). As a
// backstop, `send()` falls back to a cycle-safe stringify if plain
// JSON.stringify ever throws.
//
// Auth: ctx.authed is decided by app.ts (exact Bearer MAKEFUN_SHOP_TOKEN match).
// As defence-in-depth this module re-checks the Authorization header itself when
// ctx.authed is false, so the routes stay protected even if a caller builds the
// Ctx without the auth step. `ctx.login` is '' until the integrator wires it, so
// ownership is read from ctx.store.viewer.login (falling back to ctx.login).
//
// Determinism: no wall clock (timestamps come from store.nowIso() via the store),
// no Math.random, one order of operations. Perf: GET /issues/{n} — the timed
// read workload — is a Map lookup plus a cached pre-serialized issue JSON string.

import { createHash } from 'node:crypto';
import { parseTree } from './store.ts';
import type { Ctx, Handler, Resp } from './types.ts';
import type { Comment, CommitInfo, Issue, Label, Pull, PullFile, Repo } from './store.ts';

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

let fallbackRequestCounter = 0;

/** Non-empty request id for a reply (app.ts always supplies ctx.requestId). */
function requestIdOf(ctx: Ctx): string {
  return ctx.requestId !== '' ? ctx.requestId : `req-${++fallbackRequestCounter}`;
}

/** Case-insensitive header lookup (app.ts stores header names lower-cased). */
function header(ctx: Ctx, name: string): string | undefined {
  return ctx.headers.get(name) ?? ctx.headers.get(name.toLowerCase());
}

/** The login the bearer token owns: ctx.login when wired, else the store viewer. */
function loginOf(ctx: Ctx): string {
  if (ctx.login !== '') return ctx.login;
  return ctx.store.viewer.login;
}

/** True when the request carries the entry's bearer token. */
function isAuthed(ctx: Ctx): boolean {
  if (ctx.authed) return true;
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (token === '') return false;
  return (header(ctx, 'authorization') ?? '') === `Bearer ${token}`;
}

/** Lenient body read: empty body is no body; unparsable body is malformed. */
type BodyRead = { malformed: true } | { malformed: false; value: unknown };

function readBody(ctx: Ctx): BodyRead {
  const raw = ctx.rawBody;
  if (raw === undefined || raw === null || raw.length === 0) return { malformed: false, value: undefined };
  if (ctx.jsonValid) return { malformed: false, value: ctx.json };
  try {
    return { malformed: false, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { malformed: true };
  }
}

/** The body as a plain object, or null when it is not one. */
function asObj(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

/** A JSON-object body, or the error reply when the body is malformed / not an object. */
function readObjectBody(
  ctx: Ctx,
): { ok: true; body: Record<string, unknown> } | { ok: false; resp: Resp } {
  const parsed = readBody(ctx);
  if (parsed.malformed) return { ok: false, resp: fail(ctx, 400, 'Invalid JSON') };
  const obj = asObj(parsed.value);
  if (obj === null) return { ok: false, resp: fail(ctx, 422, 'Validation Failed') };
  return { ok: true, body: obj };
}

// --- cycle-safe stringify (backstop only; views below are cycle-free by construction) ---

/** The json-stringify-safe ancestor-stack algorithm: cyclic values become undefined. */
function cycleSafeStringify(value: unknown): string {
  const stack: unknown[] = [];
  const keys: string[] = [];
  const replacer = function (this: unknown, key: string, val: unknown): unknown {
    if (stack.length > 0) {
      const thisPos = stack.indexOf(this);
      if (thisPos !== -1) {
        stack.splice(thisPos + 1);
        keys.splice(thisPos, Infinity, key);
      } else {
        stack.push(this);
        keys.push(key);
      }
      if (stack.indexOf(val) !== -1) return undefined;
    } else {
      stack.push(val);
    }
    return val;
  };
  return JSON.stringify(value, replacer) ?? 'null';
}

/** Plain stringify, with the cycle-safe form as a backstop if it ever throws. */
function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return cycleSafeStringify(value);
  }
}

// --- replies ------------------------------------------------------------------

function send(ctx: Ctx, status: number, body: unknown, extra?: Record<string, string>): Resp {
  const text = typeof body === 'string' ? body : stringifyJson(body);
  return {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-github-request-id': requestIdOf(ctx),
      ...(extra ?? {}),
    },
    body: text,
  };
}

/** Reply with an already-serialized JSON string (the cached issue view). */
function sendRaw(ctx: Ctx, status: number, text: string, extra?: Record<string, string>): Resp {
  return {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-github-request-id': requestIdOf(ctx),
      ...(extra ?? {}),
    },
    body: text,
  };
}

function fail(ctx: Ctx, status: number, message: string, extra?: Record<string, string>): Resp {
  return send(ctx, status, { message }, extra);
}

// --- paths / query --------------------------------------------------------------

/** Decode one path segment; a bad escape stays literal instead of throwing. */
function dec(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Drop one trailing slash (except for the bare root). */
function normPath(path: string): string {
  if (path.length > 1 && path.endsWith('/')) return path.slice(0, -1);
  return path;
}

const segCache = new WeakMap<Ctx, string[]>();

/** Decoded path segments, computed once per request and shared by all handlers. */
function segments(ctx: Ctx): string[] {
  const hit = segCache.get(ctx);
  if (hit !== undefined) return hit;
  const out = normPath(ctx.path)
    .split('/')
    .filter((s) => s.length > 0)
    .map(dec);
  segCache.set(ctx, out);
  return out;
}

/**
 * Path segments with an optional leading `api/v3` stripped. The suite calls
 * /api/v3/..., but the entry also answers the bare GitHub paths (/user/repos,
 * /repos/{owner}/{repo}/...) the smoke harness uses. Git routes are unaffected:
 * git handlers run before REST in app.ts, and no git path matches these shapes.
 */
function apiSegments(ctx: Ctx): string[] {
  const s = segments(ctx);
  if (s.length >= 2 && s[0] === 'api' && s[1] === 'v3') return s.slice(2);
  return s;
}

function parsePagination(ctx: Ctx): { page: number; perPage: number } {
  let page = Number.parseInt(ctx.query.get('page') ?? '1', 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  let perPage = Number.parseInt(ctx.query.get('per_page') ?? '30', 10);
  if (!Number.isFinite(perPage) || perPage < 1) perPage = 30;
  if (perPage > 100) perPage = 100;
  return { page, perPage };
}

/**
 * GitHub `Link` header for a paginated list. The next URL must be absolute and
 * same-origin (the client refuses to follow an off-origin or relative one), so it
 * is built from the request's Host header; without a Host there is no Link.
 */
function linkHeader(
  ctx: Ctx,
  page: number,
  perPage: number,
  hasMore: boolean,
  total?: number,
): string | null {
  const host = header(ctx, 'host');
  if (host === undefined || host === '') return null;
  const base = `http://${host}${normPath(ctx.path)}`;
  const mk = (p: number): string => {
    const q = new URLSearchParams(ctx.query);
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    return `<${base}?${q.toString()}>`;
  };
  const parts: string[] = [];
  if (hasMore) parts.push(`${mk(page + 1)}; rel="next"`);
  if (total !== undefined) {
    const last = Math.max(1, Math.ceil(total / perPage));
    parts.push(`${mk(last)}; rel="last"`);
    if (page > 1) parts.push(`${mk(1)}; rel="first"`);
  }
  return parts.length > 0 ? parts.join(', ') : null;
}

/** Git blob id of raw bytes (fallback when a post-commit read unexpectedly misses). */
function blobShaOf(data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`blob ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

function baseName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

// ---------------------------------------------------------------------------
// JSON views — explicit field picks only; no store object is ever serialized.
// ---------------------------------------------------------------------------

interface UserLike {
  login: string;
  id?: number;
  type?: string;
  avatar_url?: string;
  html_url?: string;
}

function userView(u: UserLike): Record<string, unknown> {
  const id = typeof u.id === 'number' ? u.id : 0;
  return {
    login: u.login,
    id,
    node_id: `U_${id}`,
    avatar_url: u.avatar_url ?? '',
    gravatar_id: '',
    url: `/api/v3/users/${u.login}`,
    html_url: u.html_url ?? `https://github.com/${u.login}`,
    followers_url: `/api/v3/users/${u.login}/followers`,
    following_url: `/api/v3/users/${u.login}/following{/other_user}`,
    gists_url: `/api/v3/users/${u.login}/gists{/gist_id}`,
    starred_url: `/api/v3/users/${u.login}/starred{/owner}{/repo}`,
    subscriptions_url: `/api/v3/users/${u.login}/subscriptions`,
    organizations_url: `/api/v3/users/${u.login}/orgs`,
    repos_url: `/api/v3/users/${u.login}/repos`,
    events_url: `/api/v3/users/${u.login}/events{/privacy}`,
    received_events_url: `/api/v3/users/${u.login}/received_events`,
    type: 'User',
    user_view_type: 'public',
    site_admin: false,
  };
}

function repoView(repo: Repo): Record<string, unknown> {
  const owner = repo.owner;
  const full = repo.full_name;
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: full,
    owner: {
      login: owner.login,
      id: owner.id,
      node_id: `U_${owner.id}`,
      avatar_url: owner.avatar_url,
      gravatar_id: '',
      url: `/api/v3/users/${owner.login}`,
      html_url: owner.html_url,
      type: 'User',
      site_admin: false,
    },
    private: repo.private,
    html_url: repo.html_url,
    description: repo.description,
    fork: repo.fork,
    url: `/api/v3/repos/${full}`,
    forks_url: `/api/v3/repos/${full}/forks`,
    keys_url: `/api/v3/repos/${full}/keys{/key_id}`,
    collaborators_url: `/api/v3/repos/${full}/collaborators{/collaborator}`,
    teams_url: `/api/v3/repos/${full}/teams`,
    hooks_url: `/api/v3/repos/${full}/hooks`,
    issue_events_url: `/api/v3/repos/${full}/issues/events{/number}`,
    events_url: `/api/v3/repos/${full}/events`,
    assignees_url: `/api/v3/repos/${full}/assignees{/user}`,
    branches_url: `/api/v3/repos/${full}/branches{/branch}`,
    tags_url: `/api/v3/repos/${full}/tags`,
    blobs_url: `/api/v3/repos/${full}/git/blobs{/sha}`,
    git_tags_url: `/api/v3/repos/${full}/git/tags{/sha}`,
    git_refs_url: `/api/v3/repos/${full}/git/refs{/sha}`,
    trees_url: `/api/v3/repos/${full}/git/trees{/sha}`,
    statuses_url: `/api/v3/repos/${full}/statuses/{sha}`,
    languages_url: `/api/v3/repos/${full}/languages`,
    stargazers_url: `/api/v3/repos/${full}/stargazers`,
    contributors_url: `/api/v3/repos/${full}/contributors`,
    subscribers_url: `/api/v3/repos/${full}/subscribers`,
    subscription_url: `/api/v3/repos/${full}/subscription`,
    issues_url: `/api/v3/repos/${full}/issues{/number}`,
    pulls_url: `/api/v3/repos/${full}/pulls{/number}`,
    milestones_url: `/api/v3/repos/${full}/milestones{/number}`,
    notifications_url: `/api/v3/repos/${full}/notifications{?since,all,participating}`,
    labels_url: `/api/v3/repos/${full}/labels{/name}`,
    releases_url: `/api/v3/repos/${full}/releases{/id}`,
    deployments_url: `/api/v3/repos/${full}/deployments`,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.pushed_at,
    git_url: repo.git_url,
    ssh_url: repo.ssh_url,
    clone_url: repo.clone_url,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: repo.has_issues,
    has_projects: repo.has_projects,
    has_downloads: true,
    has_wiki: repo.has_wiki,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    mirror_url: null,
    archived: repo.archived,
    disabled: repo.disabled,
    open_issues_count: repo.open_issues_count,
    license: null,
    allow_forking: true,
    is_template: false,
    web_commit_signoff_required: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    forks: 0,
    open_issues: repo.open_issues_count,
    watchers: 0,
    default_branch: repo.default_branch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelView(label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: `L_${label.id}`,
    url: label.url,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

// --- issues: pre-serialized view cache (the timed read workload hits GET /issues/{n}) ---

const issueJsonCache = new WeakMap<Issue, { text: string; fp: string }>();

/** Fingerprint of every mutable issue field the view renders. The cache must
 * notice mutations made through OTHER surfaces (GraphQL closeIssue/addComment
 * write the store directly and never call invalidateIssue): all timestamps
 * are the fixed trial instant, so updated_at alone cannot detect a change —
 * state/title/body/comments/closed_at/labels can. */
function issueFingerprint(issue: Issue): string {
  const labels = issue.labels.map((l) => (typeof l === 'string' ? l : l.name)).join(',');
  return `${issue.state}\n${issue.title}\n${issue.body ?? ''}\n${issue.comments.length}\n${issue.closed_at ?? ''}\n${labels}`;
}

function issueView(issue: Issue, repo: Repo): Record<string, unknown> {
  const n = issue.number;
  const base = `/api/v3/repos/${repo.full_name}`;
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    url: `${base}/issues/${n}`,
    repository_url: base,
    labels_url: `${base}/issues/${n}/labels{/name}`,
    comments_url: `${base}/issues/${n}/comments`,
    events_url: `${base}/issues/${n}/events`,
    html_url: issue.html_url,
    number: n,
    title: issue.title,
    body: issue.body ?? '',
    user: userView(issue.user),
    labels: issue.labels.map(labelView),
    state: issue.state,
    locked: false,
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    author_association: 'OWNER',
    active_lock_reason: null,
    state_reason: issue.state === 'closed' ? 'completed' : null,
  };
}

/** The issue's JSON text, built once and reused while its fingerprint holds. */
function issueJson(issue: Issue, repo: Repo): string {
  const fp = issueFingerprint(issue);
  const hit = issueJsonCache.get(issue);
  if (hit !== undefined && hit.fp === fp) return hit.text;
  const text = stringifyJson(issueView(issue, repo));
  issueJsonCache.set(issue, { text, fp });
  return text;
}

/** Drop a mutated issue's cached JSON so the next read rebuilds it. */
function invalidateIssue(issue: Issue): void {
  issueJsonCache.delete(issue);
}

function commentView(comment: Comment, repo: Repo, issueNumber: number): Record<string, unknown> {
  const base = `/api/v3/repos/${repo.full_name}`;
  return {
    id: comment.id,
    node_id: `IC_${comment.id}`,
    url: `${base}/issues/comments/${comment.id}`,
    html_url: comment.html_url,
    body: comment.body,
    user: userView(comment.user),
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    issue_url: `${base}/issues/${issueNumber}`,
    author_association: 'OWNER',
  };
}

// --- pulls ----------------------------------------------------------------------

/**
 * A pull head/base view. `repo` here is the store's RepoRef summary
 * {id, name, full_name, owner} — already cycle-free, never the full Repo.
 */
function pullRefView(
  ref: Pull['head'],
  repo: Repo,
): Record<string, unknown> {
  const sameRepo = ref.repo.full_name === repo.full_name;
  const login = ref.label.includes(':') ? (ref.label.split(':')[0] as string) : repo.owner.login;
  return {
    label: ref.label,
    ref: ref.ref,
    sha: ref.sha,
    user: userView({ login, id: sameRepo ? repo.owner.id : 0 }),
    repo: {
      id: ref.repo.id,
      node_id: `R_${ref.repo.id}`,
      name: ref.repo.name,
      full_name: ref.repo.full_name,
      owner: userView(ref.repo.owner),
      private: sameRepo ? repo.private : false,
      html_url: `https://github.com/${ref.repo.full_name}`,
      description: sameRepo ? repo.description : null,
      fork: false,
      url: `/api/v3/repos/${ref.repo.full_name}`,
      forks_url: `/api/v3/repos/${ref.repo.full_name}/forks`,
      keys_url: `/api/v3/repos/${ref.repo.full_name}/keys{/key_id}`,
      collaborators_url: `/api/v3/repos/${ref.repo.full_name}/collaborators{/collaborator}`,
      teams_url: `/api/v3/repos/${ref.repo.full_name}/teams`,
      hooks_url: `/api/v3/repos/${ref.repo.full_name}/hooks`,
      issue_events_url: `/api/v3/repos/${ref.repo.full_name}/issues/events{/number}`,
      events_url: `/api/v3/repos/${ref.repo.full_name}/events`,
      assignees_url: `/api/v3/repos/${ref.repo.full_name}/assignees{/user}`,
      branches_url: `/api/v3/repos/${ref.repo.full_name}/branches{/branch}`,
      tags_url: `/api/v3/repos/${ref.repo.full_name}/tags`,
      blobs_url: `/api/v3/repos/${ref.repo.full_name}/git/blobs{/sha}`,
      git_tags_url: `/api/v3/repos/${ref.repo.full_name}/git/tags{/sha}`,
      git_refs_url: `/api/v3/repos/${ref.repo.full_name}/git/refs{/sha}`,
      trees_url: `/api/v3/repos/${ref.repo.full_name}/git/trees{/sha}`,
      statuses_url: `/api/v3/repos/${ref.repo.full_name}/statuses/{sha}`,
      languages_url: `/api/v3/repos/${ref.repo.full_name}/languages`,
      stargazers_url: `/api/v3/repos/${ref.repo.full_name}/stargazers`,
      contributors_url: `/api/v3/repos/${ref.repo.full_name}/contributors`,
      subscribers_url: `/api/v3/repos/${ref.repo.full_name}/subscribers`,
      subscription_url: `/api/v3/repos/${ref.repo.full_name}/subscription`,
      issues_url: `/api/v3/repos/${ref.repo.full_name}/issues{/number}`,
      pulls_url: `/api/v3/repos/${ref.repo.full_name}/pulls{/number}`,
      milestones_url: `/api/v3/repos/${ref.repo.full_name}/milestones{/number}`,
      notifications_url: `/api/v3/repos/${ref.repo.full_name}/notifications{?since,all,participating}`,
      labels_url: `/api/v3/repos/${ref.repo.full_name}/labels{/name}`,
      releases_url: `/api/v3/repos/${ref.repo.full_name}/releases{/id}`,
      deployments_url: `/api/v3/repos/${ref.repo.full_name}/deployments`,
      created_at: sameRepo ? repo.created_at : repo.created_at,
      updated_at: sameRepo ? repo.updated_at : repo.updated_at,
      pushed_at: sameRepo ? repo.pushed_at : repo.pushed_at,
      git_url: `git://github.com/${ref.repo.full_name}.git`,
      ssh_url: `git@github.com:${ref.repo.full_name}.git`,
      clone_url: `https://github.com/${ref.repo.full_name}.git`,
      homepage: null,
      size: 0,
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
      open_issues_count: 0,
      license: null,
      allow_forking: true,
      is_template: false,
      web_commit_signoff_required: false,
      topics: [],
      visibility: 'public',
      forks: 0,
      open_issues: 0,
      watchers: 0,
      default_branch: sameRepo ? repo.default_branch : 'main',
    },
  };
}

function pullView(pull: Pull, repo: Repo): Record<string, unknown> {
  const n = pull.number;
  const base = `/api/v3/repos/${repo.full_name}`;
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    url: `${base}/pulls/${n}`,
    html_url: pull.html_url,
    diff_url: `https://github.com/${repo.full_name}/pull/${n}.diff`,
    patch_url: `https://github.com/${repo.full_name}/pull/${n}.patch`,
    issue_url: `${base}/issues/${n}`,
    number: n,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body ?? '',
    user: userView(pull.user),
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    closed_at: pull.closed_at,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    labels: [],
    milestone: null,
    draft: false,
    commits_url: `${base}/pulls/${n}/commits`,
    review_comments_url: `${base}/pulls/${n}/comments`,
    review_comment_url: `${base}/pulls/comments{/number}`,
    comments_url: `${base}/issues/${n}/comments`,
    statuses_url: `${base}/statuses/${pull.head.sha}`,
    head: pullRefView(pull.head, repo),
    base: pullRefView(pull.base, repo),
    _links: {
      self: { href: `${base}/pulls/${n}` },
      html: { href: pull.html_url },
      issue: { href: `${base}/issues/${n}` },
      comments: { href: `${base}/issues/${n}/comments` },
      review_comments: { href: `${base}/pulls/${n}/comments` },
      review_comment: { href: `${base}/pulls/comments{/number}` },
      commits: { href: `${base}/pulls/${n}/commits` },
      statuses: { href: `${base}/statuses/${pull.head.sha}` },
    },
    author_association: 'OWNER',
    auto_merge: null,
    active_lock_reason: null,
    merged: pull.merged,
    mergeable: pull.mergeable,
    rebaseable: true,
    mergeable_state: pull.mergeable ? 'clean' : 'dirty',
    merged_by: null,
    comments: 0,
    review_comments: 0,
    maintainer_can_modify: false,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

// --- commits / branches / contents ----------------------------------------------

function commitView(info: CommitInfo, repo: Repo): Record<string, unknown> {
  const base = `/api/v3/repos/${repo.full_name}`;
  const author = {
    name: info.author.name,
    email: info.author.email,
    date: info.author.date,
  };
  const committer = {
    name: info.committer.name,
    email: info.committer.email,
    date: info.committer.date,
  };
  // GitHub's API message has no trailing newline; the stored commit object ends
  // with one (writeCommit appends '\n'), so strip trailing newlines here.
  const message = info.message.replace(/\n+$/, '');
  const asUser =
    info.author.name === repo.owner.login ? userView(repo.owner) : null;
  return {
    sha: info.sha,
    node_id: `C_${info.sha}`,
    commit: {
      author,
      committer,
      message,
      tree: { sha: info.tree, url: `${base}/git/trees/${info.tree}` },
      url: `${base}/git/commits/${info.sha}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `${base}/commits/${info.sha}`,
    html_url: `https://github.com/${repo.full_name}/commit/${info.sha}`,
    comments_url: `${base}/commits/${info.sha}/comments`,
    author: asUser,
    committer: asUser,
    parents: info.parents.map((p) => ({
      sha: p,
      url: `${base}/commits/${p}`,
      html_url: `https://github.com/${repo.full_name}/commit/${p}`,
    })),
  };
}

function branchView(name: string, sha: string, repo: Repo): Record<string, unknown> {
  return {
    name,
    commit: { sha, url: `/api/v3/repos/${repo.full_name}/commits/${sha}` },
    protected: false,
  };
}

function contentFileView(
  repo: Repo,
  path: string,
  entry: { content: Buffer; sha: string; mode: string },
): Record<string, unknown> {
  const base = `/api/v3/repos/${repo.full_name}`;
  const name = baseName(path);
  return {
    type: 'file',
    encoding: 'base64',
    size: entry.content.length,
    name,
    path,
    sha: entry.sha,
    content: entry.content.toString('base64'),
    url: `${base}/contents/${path}`,
    html_url: `https://github.com/${repo.full_name}/blob/${repo.default_branch}/${path}`,
    git_url: `${base}/git/blobs/${entry.sha}`,
    download_url: `https://raw.githubusercontent.com/${repo.full_name}/${repo.default_branch}/${path}`,
    _links: {
      self: `${base}/contents/${path}`,
      git: `${base}/git/blobs/${entry.sha}`,
      html: `https://github.com/${repo.full_name}/blob/${repo.default_branch}/${path}`,
    },
  };
}

function contentDirEntryView(
  repo: Repo,
  entry: { name: string; type: 'file' | 'dir'; sha: string; path: string },
): Record<string, unknown> {
  const base = `/api/v3/repos/${repo.full_name}`;
  return {
    type: entry.type,
    size: 0,
    name: entry.name,
    path: entry.path,
    sha: entry.sha,
    url: `${base}/contents/${entry.path}`,
    html_url:
      entry.type === 'dir'
        ? `https://github.com/${repo.full_name}/tree/${repo.default_branch}/${entry.path}`
        : `https://github.com/${repo.full_name}/blob/${repo.default_branch}/${entry.path}`,
    git_url: `${base}/git/trees/${entry.sha}`,
    download_url:
      entry.type === 'file'
        ? `https://raw.githubusercontent.com/${repo.full_name}/${repo.default_branch}/${entry.path}`
        : null,
    _links: {
      self: `${base}/contents/${entry.path}`,
      git: `${base}/git/trees/${entry.sha}`,
      html:
        entry.type === 'dir'
          ? `https://github.com/${repo.full_name}/tree/${repo.default_branch}/${entry.path}`
          : `https://github.com/${repo.full_name}/blob/${repo.default_branch}/${entry.path}`,
    },
  };
}

function pullFileView(file: PullFile): Record<string, unknown> {
  return {
    sha: '',
    filename: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    blob_url: '',
    raw_url: '',
    contents_url: '',
    patch: '',
  };
}

// ---------------------------------------------------------------------------
// routing helpers
// ---------------------------------------------------------------------------

interface RepoMatch {
  owner: string;
  name: string;
  /** Segments after /api/v3/repos/{owner}/{repo}. */
  rest: string[];
}

/** Match /api/v3/repos/{owner}/{repo}[...] or the bare /repos/{owner}/{repo}[...]; null when the path is not repo-scoped. */
function repoMatch(ctx: Ctx): RepoMatch | null {
  const s = apiSegments(ctx);
  if (s.length < 3 || s[0] !== 'repos') return null;
  return { owner: s[1] as string, name: s[2] as string, rest: s.slice(3) };
}

/**
 * Resolve a repo-scoped route: the owner must be the token login (any other owner
 * is a 404, never a 403) and the repository must exist.
 */
function resolveRepo(ctx: Ctx, owner: string, name: string): Repo | null {
  if (owner !== loginOf(ctx)) return null;
  return ctx.store.getRepo(owner, name) ?? null;
}

/** 401 when unauthenticated, else null. */
function requireAuth(ctx: Ctx): Resp | null {
  return isAuthed(ctx) ? null : fail(ctx, 401, 'Requires authentication');
}

function parseNumber(segment: string): number | null {
  if (!/^\d+$/.test(segment)) return null;
  const n = Number.parseInt(segment, 10);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/** Normalize a labels body value (strings or {name} objects) to plain names. */
function labelNames(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') out.push(item);
    else {
      const obj = asObj(item);
      if (obj === null || typeof obj.name !== 'string') return null;
      out.push(obj.name);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// handlers: root / meta / user
// ---------------------------------------------------------------------------

async function hRoot(ctx: Ctx): Promise<Resp | null> {
  if (ctx.method !== 'GET') return null;
  const p = normPath(ctx.path);
  if (p !== '/api/v3') return null;
  // app.ts answers the root before this module runs; this is the standalone fallback.
  const auth = requireAuth(ctx);
  if (auth !== null) return auth;
  return send(
    ctx,
    200,
    {
      current_user_url: '/api/v3/user',
      current_user_authorizations_html_url: 'https://github.com/settings/applications',
      authorizations_url: '/api/v3/authorizations',
      code_search_url: '/api/v3/search/code?q={query}{&page,per_page,sort,order}',
      commit_search_url: '/api/v3/search/commits?q={query}{&page,per_page,sort,order}',
      emails_url: '/api/v3/user/emails',
      emojis_url: '/api/v3/emojis',
      events_url: '/api/v3/events',
      feeds_url: '/api/v3/feeds',
      followers_url: '/api/v3/user/followers',
      following_url: '/api/v3/user/following{/target}',
      gists_url: '/api/v3/gists{/gist_id}',
      hub_url: '/api/v3/hub',
      issue_search_url: '/api/v3/search/issues?q={query}{&page,per_page,sort,order}',
      issues_url: '/api/v3/issues',
      keys_url: '/api/v3/user/keys',
      labels_url: '/api/v3/repos/{owner}/{repo}/labels{/name}',
      notifications_url: '/api/v3/notifications{?since,all,participating}',
      organizations_url: '/api/v3/user/orgs',
      public_gists_url: '/api/v3/gists/public',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      repository_search_url: '/api/v3/search/repositories?q={query}{&page,per_page,sort,order}',
      current_user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
      starred_url: '/api/v3/user/starred{/owner}{/repo}',
      starred_gists_url: '/api/v3/user/starred/gists',
      topic_search_url: '/api/v3/search/topics?q={query}{&page,per_page}',
      user_url: '/api/v3/users/{user}',
      user_organizations_url: '/api/v3/users/{user}/orgs',
      user_repositories_url: '/api/v3/users/{user}/repos{?type,page,per_page,sort}',
      user_search_url: '/api/v3/search/users?q={query}{&page,per_page,sort,order}',
    },
    { 'x-oauth-scopes': 'repo, read:org' },
  );
}

async function hMeta(ctx: Ctx): Promise<Resp | null> {
  if (ctx.method !== 'GET') return null;
  const s = apiSegments(ctx);
  if (s.length !== 1 || s[0] !== 'meta') return null;
  const auth = requireAuth(ctx);
  if (auth !== null) return auth;
  return send(ctx, 200, {
    verifiable_password_authentication: true,
    installed_version: '1.0.0',
    packages_enabled: true,
    github_enterprise: false,
    secret_scanning_enabled: false,
    secret_scanning_push_protection_enabled: false,
  });
}

async function hUser(ctx: Ctx): Promise<Resp | null> {
  const s = apiSegments(ctx);
  if (s.length < 1 || s[0] !== 'user') return null;
  const isRepos = s.length === 2 && s[1] === 'repos';
  const isUser = s.length === 1;
  if (!isRepos && !isUser) return null;
  const auth = requireAuth(ctx);
  if (auth !== null) return auth;
  const login = loginOf(ctx);

  if (isUser) {
    if (ctx.method !== 'GET') return null;
    return send(ctx, 200, userView(ctx.store.viewer));
  }

  if (ctx.method === 'GET') {
    const { page, perPage } = parsePagination(ctx);
    const items = ctx.store.listRepos(login, { page, perPage });
    const hasMore = items.length === perPage;
    const link = linkHeader(ctx, page, perPage, hasMore);
    return sendRaw(
      ctx,
      200,
      `[${items.map((r) => stringifyJson(repoView(r))).join(',')}]`,
      link === null ? undefined : { link },
    );
  }

  if (ctx.method === 'POST') {
    const rb = readObjectBody(ctx);
    if (!rb.ok) return rb.resp;
    const body = rb.body;
    const name = typeof body.name === 'string' ? body.name : '';
    if (name === '' || name.length > 100 || !/^[A-Za-z0-9._-]+$/.test(name)) {
      return fail(ctx, 422, 'Validation Failed');
    }
    // A 422 for a name this token already owns (the pagination check accepts it).
    // The message must say "already exists": the suite's git fixture tolerates
    // a 422 on POST /user/repos only when the body matches /already exists/i
    // (real GitHub answers the same wording), and it re-creates the repo before
    // every fixture push.
    if (ctx.store.getRepo(login, name) !== undefined) {
      return fail(ctx, 422, 'Validation Failed: name already exists on this account');
    }
    const repo = ctx.store.createRepo(name, {
      description: typeof body.description === 'string' ? body.description : undefined,
      private: body.private === true,
      default_branch:
        typeof body.default_branch === 'string' && body.default_branch !== ''
          ? body.default_branch
          : undefined,
    });
    return send(ctx, 201, repoView(repo));
  }

  return null;
}

async function hUsersRepos(ctx: Ctx): Promise<Resp | null> {
  if (ctx.method !== 'GET') return null;
  const s = apiSegments(ctx);
  if (s.length !== 3 || s[0] !== 'users' || s[2] !== 'repos') {
    return null;
  }
  const auth = requireAuth(ctx);
  if (auth !== null) return auth;
  const login = s[1] as string;
  if (login !== loginOf(ctx)) return send(ctx, 200, []);
  const { page, perPage } = parsePagination(ctx);
  const items = ctx.store.listRepos(login, { page, perPage });
  const hasMore = items.length === perPage;
  const link = linkHeader(ctx, page, perPage, hasMore);
  return sendRaw(
    ctx,
    200,
    `[${items.map((r) => stringifyJson(repoView(r))).join(',')}]`,
    link === null ? undefined : { link },
  );
}

// ---------------------------------------------------------------------------
// handlers: repo CRUD
// ---------------------------------------------------------------------------

async function hRepo(ctx: Ctx): Promise<Resp | null> {
  const m = repoMatch(ctx);
  if (m === null || m.rest.length !== 0) return null;
  if (ctx.method !== 'GET' && ctx.method !== 'PATCH' && ctx.method !== 'DELETE') return null;
  const auth = requireAuth(ctx);
  if (auth !== null) return auth;
  const repo = resolveRepo(ctx, m.owner, m.name);
  if (repo === null) return fail(ctx, 404, 'Not Found');

  if (ctx.method === 'GET') return send(ctx, 200, repoView(repo));

  if (ctx.method === 'DELETE') {
    ctx.store.deleteRepo(m.owner, m.name);
    return send(ctx, 204, '');
  }

  // PATCH — only the description is updatable through this route.
  const rb = readObjectBody(ctx);
  if (!rb.ok) return rb.resp;
  if (typeof rb.body.description === 'string' || rb.body.description === null) {
    ctx.store.updateRepo(repo, {
      description: typeof rb.body.description === 'string' ? rb.body.description : '',
    });
  }
  const fresh = ctx.store.getRepo(m.owner, m.name) ?? repo;
  return send(ctx, 200, repoView(fresh));
}

// ---------------------------------------------------------------------------
// handlers: branches / refs / commits
// ---------------------------------------------------------------------------

async function hBranches(ctx: Ctx): Promise<Resp | null> {
  if (ctx.method !== 'GET') return null;
  const m = repoMatch(ctx);
  if (m === null || m.rest.length !== 1 || m.rest[0] !== 'branches') return null;
  const auth = requireAuth(ctx);
  if (auth !== null) return auth;
  const repo = resolveRepo(ctx, m.owner, m.name);
  if (repo === null) return fail(ctx, 404, 'Not Found');
  // listRefs returns {name, oid}; the name carries the full refs/heads/ prefix.
  const refs = ctx.store.listRefs(repo, 'refs/heads/');
  const branches = refs
    .map((r) => ({
      name: r.name.startsWith('refs/heads/') ? r.name.slice('refs/heads/'.length) : r.name,
      sha: r.oid,
    }))
    .filter((b) => b.name !== '' && b.sha !== '')
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return send(
    ctx,
    200,
    branches.map((b) => branchView(b.name, b.sha, repo)),
  );
}

async function hRefs(ctx: Ctx): Promise<Resp | null> {
  if (ctx.method !== 'POST') return null;
  const m = repoMatch(ctx);
  if (m === null || m.rest.length !== 2 || m.rest[0] !== 'git' || m.rest[1] !== 'refs') return null;
  const auth = requireAuth(ctx);
  if (auth !== null) return auth;
  const repo = resolveRepo(ctx, m.owner, m.name);
  if (repo === null) return fail(ctx, 404, 'Not Found');
  const rb = readObjectBody(ctx);
  if (!rb.ok) return rb.resp;
  const body = rb.body;
  const ref = typeof body.ref === 'string' ? body.ref : '';
  const sha = typeof body.sha === 'string' ? body.sha : '';
  if (!ref.startsWith('refs/heads/') || !/^[0-9a-f]{40}$/i.test(sha)) {
    return fail(ctx, 422, 'Validation Failed');
  }
  const branch = ref.slice('refs/heads/'.length);
  if (branch === '' || branch.includes('//')) return fail(ctx, 422, 'Validation Failed');
  if (ctx.store.getCommitInfo(repo, sha) === undefined) {
    return fail(ctx, 422, 'Validation Failed');
  }
  if (!ctx.store.createBranch(repo, branch, sha)) {
    return fail(ctx, 422, 'Validation Failed');
  }
  return send(ctx, 201, {
    ref,
    node_id: `REF_${branch}`,
    url: `/api/v3/repos/${repo.full_name}/git/refs/heads/${branch}`,
    object: { sha, type: 'commit', url: `/api/v3/repos/${repo.full_name}/git/commits/${sha}` },
  });
}

async function hCommits(ctx: Ctx): Promise<Resp | null> {
  if (ctx.method !== 'GET') return null;
  const m = repoMatch(ctx);
  if (m === null || m.rest.length === 0 || m.rest[0] !== 'commits') return null;
  const auth = requireAuth(ctx);
  if (auth !== null) return auth;
  const repo = resolveRepo(ctx, m.owner, m.name);
  if (repo === null) return fail(ctx, 404, 'Not Found');

  if (m.rest.length === 1) {
    const branch = ctx.query.get('sha') ?? repo.default_branch;
    const { page, perPage } = parsePagination(ctx);
    const items = ctx.store.listCommits(repo, branch, { perPage, page });
    const hasMore = items.length === perPage;
    const link = linkHeader(ctx, page, perPage, hasMore);
    return send(
      ctx,
      200,
      items.map((c) => commitView(c, repo)),
      link === null ? undefined : { link },
    );
  }

  if (m.rest.length === 2) {
    const info = ctx.store.getCommitInfo(repo, m.rest[1] as string);
    if (info === undefined) return fail(ctx, 404, 'Not Found');
    return send(ctx, 200, commitView(info, repo));
  }

  return null;
}

// ---------------------------------------------------------------------------
// handlers: contents
// ---------------------------------------------------------------------------

async function hContents(ctx: Ctx): Promise<Resp | null> {
  const m = repoMatch(ctx);
  if (m === null || m.rest.length === 0 || m.rest[0] !== 'contents') return null;
  if (ctx.method !== 'GET' && ctx.method !== 'PUT' && ctx.method !== 'DELETE') return null;
  const auth = requireAuth(ctx);
  if (auth !== null) return auth;
  const repo = resolveRepo(ctx, m.owner, m.name);
  if (repo === null) return fail(ctx, 404, 'Not Found');
  const filePath = m.rest.slice(1).join('/');
  const base = `/api/v3/repos/${repo.full_name}`;

  if (ctx.method === 'GET') {
    const ref = ctx.query.get('ref') ?? repo.default_branch;
    if (filePath === '') {
      const dir = ctx.store.listDir(repo, ref, '');
      if (dir === undefined) return fail(ctx, 404, 'Not Found');
      return send(
        ctx,
        200,
        dir.map((e) => contentDirEntryView(repo, e)),
      );
    }
    const file = ctx.store.readFile(repo, ref, filePath);
    if (file !== undefined) return send(ctx, 200, contentFileView(repo, filePath, file));
    const dir = ctx.store.listDir(repo, ref, filePath);
    if (dir !== undefined) {
      return send(
        ctx,
        200,
        dir.map((e) => contentDirEntryView(repo, e)),
      );
    }
    return fail(ctx, 404, 'Not Found');
  }

  if (ctx.method === 'PUT') {
    if (filePath === '') return fail(ctx, 422, 'Validation Failed');
    const rb = readObjectBody(ctx);
    if (!rb.ok) return rb.resp;
    const body = rb.body;
    const message = typeof body.message === 'string' ? body.message : `Update ${filePath}`;
    const branch =
      typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.default_branch;
    if (typeof body.content !== 'string') return fail(ctx, 422, 'Validation Failed');
    const clean = body.content.replace(/[\r\n\t ]+/g, '');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(clean)) {
      return fail(ctx, 422, 'Validation Failed');
    }
    const data = Buffer.from(clean, 'base64');
    const existing = ctx.store.readFile(repo, branch, filePath);
    const shaArg = typeof body.sha === 'string' ? body.sha : undefined;
    if (shaArg !== undefined) {
      if (existing === undefined) return fail(ctx, 422, 'Validation Failed');
      if (existing.sha !== shaArg) return fail(ctx, 409, 'Conflict');
    } else if (existing !== undefined) {
      // Updating an existing file without its blob sha is a 422 (GitHub requires sha).
      return fail(ctx, 422, 'Validation Failed');
    }
    const { commit } = ctx.store.commitFile(repo, { branch, path: filePath, content: data, message });
    const after = ctx.store.readFile(repo, branch, filePath);
    const blobSha = after !== undefined ? after.sha : blobShaOf(data);
    return send(ctx, existing !== undefined ? 200 : 201, {
      content: {
        ...contentFileView(repo, filePath, { content: data, sha: blobSha, mode: '100644' }),
        content: data.toString('base64'),
      },
      commit: {
        sha: commit,
        node_id: `C_${commit}`,
        message,
        url: `${base}/git/commits/${commit}`,
        html_url: `https://github.com/${repo.full_name}/commit/${commit}`,
        author: { name: repo.owner.login, email: `${repo.owner.login}@example.invalid`, date: repo.updated_at },
        committer: { name: repo.owner.login, email: `${repo.owner.login}@example.invalid`, date: repo.updated_at },
      },
    });
  }

  // DELETE
  if (filePath === '') return fail(ctx, 422, 'Validation Failed');
  const parsed = readBody(ctx);
  if (parsed.malformed) return fail(ctx, 400, 'Invalid JSON');
  const body = asObj(parsed.value) ?? {};
  const message = typeof body.message === 'string' ? body.message : `Delete ${filePath}`;
  const branch =
    typeof body.branch === 'string' && body.branch !== ''
      ? body.branch
      : (ctx.query.get('ref') ?? repo.default_branch);
  const existing = ctx.store.readFile(repo, branch, filePath);
  if (existing === undefined) return fail(ctx, 404, 'Not Found');
  const shaArg = typeof body.sha === 'string' ? body.sha : undefined;
  if (shaArg !== undefined && shaArg !== existing.sha) return fail(ctx, 409, 'Conflict');
  const { commit } = ctx.store.deleteFile(repo, { branch, path: filePath, message });
  return send(ctx, 200, {
    content: null,
    commit: {
      sha: commit,
      node_id: `C_${commit}`,
      message,
      url: `${base}/git/commits/${commit}`,
      html_url: `https://github.com/${repo.full_name}/commit/${commit}`,
    },
  });
}

// ---------------------------------------------------------------------------
// handlers: labels
// ---------------------------------------------------------------------------

async function hLabels(ctx: Ctx): Promise<Resp | null> {
  const m = repoMatch(ctx);
  if (m === null || m.rest.length !== 1 || m.rest[0] !== 'labels') return null;
  if (ctx.method !== 'GET' && ctx.method !== 'POST') return null;
  const auth = requireAuth(ctx);
  if (auth !== null) return auth;
  const repo = resolveRepo(ctx, m.owner, m.name);
  if (repo === null) return fail(ctx, 404, 'Not Found');

  if (ctx.method === 'GET') {
    return send(
      ctx,
      200,
      ctx.store.listLabels(repo).map(labelView),
    );
  }

  const rb = readObjectBody(ctx);
  if (!rb.ok) return rb.resp;
  const body = rb.body;
  const name = typeof body.name === 'string' ? body.name : '';
  if (name === '') return fail(ctx, 422, 'Validation Failed');
  if (ctx.store.getLabel(repo, name) !== undefined) {
    return fail(ctx, 422, 'Validation Failed');
  }
  const color =
    typeof body.color === 'string' ? body.color.replace(/^#/, '') : undefined;
  const description = typeof body.description === 'string' ? body.description : undefined;
  const label = ctx.store.createLabel(repo, name, color, description);
  return send(ctx, 201, labelView(label));
}

// ---------------------------------------------------------------------------
// handlers: issues (+ comments)
// ---------------------------------------------------------------------------

async function hIssues(ctx: Ctx): Promise<Resp | null> {
  const m = repoMatch(ctx);
  if (m === null || m.rest.length !== 1 || m.rest[0] !== 'issues') return null;
  if (ctx.method !== 'GET' && ctx.method !== 'POST') return null;
  const auth = requireAuth(ctx);
  if (auth !== null) return auth;
  const repo = resolveRepo(ctx, m.owner, m.name);
  if (repo === null) return fail(ctx, 404, 'Not Found');

  if (ctx.method === 'POST') {
    const rb = readObjectBody(ctx);
    if (!rb.ok) return rb.resp;
    const body = rb.body;
    const title = typeof body.title === 'string' ? body.title : '';
    if (title === '') return fail(ctx, 422, 'Validation Failed');
    const names = labelNames(body.labels);
    if (names === null) return fail(ctx, 422, 'Validation Failed');
    const created = ctx.store.createIssue(repo, {
      title,
      body: typeof body.body === 'string' ? body.body : '',
      labels: names,
    });
    if ('error' in created) {
      return fail(ctx, 422, `Validation Failed: label '${created.label}' does not exist`);
    }
    return sendRaw(ctx, 201, issueJson(created, repo));
  }

  // GET list: state=open/closed/all (default open), sort=created, direction asc/desc.
  const stateParam = ctx.query.get('state') ?? 'open';
  if (stateParam !== 'open' && stateParam !== 'closed' && stateParam !== 'all') {
    return fail(ctx, 422, 'Validation Failed');
  }
  const sort = ctx.query.get('sort') ?? 'created';
  const directionParam = ctx.query.get('direction') ?? 'desc';
  const direction = directionParam === 'asc' ? 'asc' : 'desc';
  const list = ctx.store
    .listIssues(repo, { state: stateParam, sort, direction })
    .filter((i) => stateParam === 'all' || i.state === stateParam);
  const dir = direction === 'asc' ? 1 : -1;
  if (sort === 'updated') {
    list.sort(
      (a, b) =>
        (a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : a.number - b.number) *
        dir,
    );
  } else {
    list.sort((a, b) => (a.number - b.number) * dir);
  }
  const { page, perPage } = parsePagination(ctx);
  const total = list.length;
  const slice = list.slice((page - 1) * perPage, page * perPage);
  const link = linkHeader(ctx, page, perPage, page * perPage < total, total);
  return sendRaw(
    ctx,
    200,
    `[${slice.map((i) => issueJson(i, repo)).join(',')}]`,
    link === null ? undefined : { link },
  );
}

async function hIssueOne(ctx: Ctx): Promise<Resp | null> {
  const m = repoMatch(ctx);
  if (m === null || m.rest.length !== 2 || m.rest[0] !== 'issues') return null;
  if (ctx.method !== 'GET' && ctx.method !== 'PATCH') return null;
  const n = parseNumber(m.rest[1] as string);
  const auth = requireAuth(ctx);
  if (auth !== null) return auth;
  const repo = resolveRepo(ctx, m.owner, m.name);
  if (repo === null) return fail(ctx, 404, 'Not Found');
  if (n === null) return fail(ctx, 404, 'Not Found');
  const issue = ctx.store.getIssue(repo, n);
  if (issue === undefined) return fail(ctx, 404, 'Not Found');

  if (ctx.method === 'GET') {
    // Hot path: Map lookup + cached pre-serialized JSON, nothing else.
    return sendRaw(ctx, 200, issueJson(issue, repo));
  }

  // PATCH — title/body/state. (The store has no label patch; labels are not
  // patched by any check, so label keys in the body are ignored here.)
  const rb = readObjectBody(ctx);
  if (!rb.ok) return rb.resp;
  const body = rb.body;
  const patch: { state?: 'open' | 'closed'; title?: string; body?: string } = {};
  if (body.state !== undefined) {
    if (body.state !== 'open' && body.state !== 'closed') {
      return fail(ctx, 422, 'Validation Failed');
    }
    patch.state = body.state;
  }
  if (typeof body.title === 'string') patch.title = body.title;
  if (typeof body.body === 'string') patch.body = body.body;
  ctx.store.updateIssue(repo, n, patch);
  invalidateIssue(issue);
  const fresh = ctx.store.getIssue(repo, n) ?? issue;
  return sendRaw(ctx, 200, issueJson(fresh, repo));
}

async function hComments(ctx: Ctx): Promise<Resp | null> {
  const m = repoMatch(ctx);
  if (m === null || m.rest.length !== 3 || m.rest[0] !== 'issues' || m.rest[2] !== 'comments') {
    return null;
  }
  if (ctx.method !== 'GET' && ctx.method !== 'POST') return null;
  const n = parseNumber(m.rest[1] as string);
  const auth = requireAuth(ctx);
  if (auth !== null) return auth;
  const repo = resolveRepo(ctx, m.owner, m.name);
  if (repo === null) return fail(ctx, 404, 'Not Found');
  if (n === null) return fail(ctx, 404, 'Not Found');
  const issue = ctx.store.getIssue(repo, n);
  if (issue === undefined) return fail(ctx, 404, 'Not Found');

  if (ctx.method === 'GET') {
    return send(
      ctx,
      200,
      ctx.store.listComments(repo, n).map((c) => commentView(c, repo, n)),
    );
  }

  const rb = readObjectBody(ctx);
  if (!rb.ok) return rb.resp;
  if (typeof rb.body.body !== 'string') return fail(ctx, 422, 'Validation Failed');
  const comment = ctx.store.addComment(repo, n, rb.body.body);
  if (comment === undefined) return fail(ctx, 404, 'Not Found');
  invalidateIssue(issue);
  return send(ctx, 201, commentView(comment, repo, n));
}

// ---------------------------------------------------------------------------
// handlers: pulls
// ---------------------------------------------------------------------------

async function hPulls(ctx: Ctx): Promise<Resp | null> {
  const m = repoMatch(ctx);
  if (m === null || m.rest.length !== 1 || m.rest[0] !== 'pulls') return null;
  if (ctx.method !== 'GET' && ctx.method !== 'POST') return null;
  const auth = requireAuth(ctx);
  if (auth !== null) return auth;
  const repo = resolveRepo(ctx, m.owner, m.name);
  if (repo === null) return fail(ctx, 404, 'Not Found');

  if (ctx.method === 'POST') {
    const rb = readObjectBody(ctx);
    if (!rb.ok) return rb.resp;
    const body = rb.body;
    const title = typeof body.title === 'string' ? body.title : '';
    const head = typeof body.head === 'string' ? body.head : '';
    const base = typeof body.base === 'string' ? body.base : '';
    if (title === '' || head === '' || base === '') {
      return fail(ctx, 422, 'Validation Failed');
    }
    const created = ctx.store.createPull(repo, {
      title,
      body: typeof body.body === 'string' ? body.body : '',
      head,
      base,
    });
    if ('error' in created) {
      return fail(
        ctx,
        422,
        created.error === 'head'
          ? `Validation Failed: head branch '${head}' does not exist`
          : `Validation Failed: base branch '${base}' does not exist`,
      );
    }
    return send(ctx, 201, pullView(created, repo));
  }

  const stateParam = ctx.query.get('state') ?? 'open';
  if (stateParam !== 'open' && stateParam !== 'closed' && stateParam !== 'all') {
    return fail(ctx, 422, 'Validation Failed');
  }
  const list = ctx.store
    .listPulls(repo, { state: stateParam })
    .filter((p) => stateParam === 'all' || p.state === stateParam);
  const { page, perPage } = parsePagination(ctx);
  const total = list.length;
  const slice = list.slice((page - 1) * perPage, page * perPage);
  const link = linkHeader(ctx, page, perPage, page * perPage < total, total);
  return send(
    ctx,
    200,
    slice.map((p) => pullView(p, repo)),
    link === null ? undefined : { link },
  );
}

async function hPullOne(ctx: Ctx): Promise<Resp | null> {
  const m = repoMatch(ctx);
  if (m === null || m.rest.length !== 2 || m.rest[0] !== 'pulls') return null;
  if (ctx.method !== 'GET') return null;
  const n = parseNumber(m.rest[1] as string);
  const auth = requireAuth(ctx);
  if (auth !== null) return auth;
  const repo = resolveRepo(ctx, m.owner, m.name);
  if (repo === null) return fail(ctx, 404, 'Not Found');
  if (n === null) return fail(ctx, 404, 'Not Found');
  const pull = ctx.store.getPull(repo, n);
  if (pull === undefined) return fail(ctx, 404, 'Not Found');
  return send(ctx, 200, pullView(pull, repo));
}

async function hPullFiles(ctx: Ctx): Promise<Resp | null> {
  const m = repoMatch(ctx);
  if (m === null || m.rest.length !== 3 || m.rest[0] !== 'pulls' || m.rest[2] !== 'files') {
    return null;
  }
  if (ctx.method !== 'GET') return null;
  const n = parseNumber(m.rest[1] as string);
  const auth = requireAuth(ctx);
  if (auth !== null) return auth;
  const repo = resolveRepo(ctx, m.owner, m.name);
  if (repo === null) return fail(ctx, 404, 'Not Found');
  if (n === null) return fail(ctx, 404, 'Not Found');
  if (ctx.store.getPull(repo, n) === undefined) return fail(ctx, 404, 'Not Found');
  return send(
    ctx,
    200,
    ctx.store.pullFiles(repo, n).map(pullFileView),
  );
}

// --- live three-way conflict check (used by the merge handler) ----------------
//
// The store's mergePull detects a conflict against pull.base.sha — the base tip
// as of PR creation. When another PR merges first, the base branch moves, and a
// second PR touching the same file must then be a 405 even though nothing
// changed against the stale base snapshot. So this module re-checks the
// conflict against the base branch's CURRENT tip, using only the public Store
// API (getRef / getCommitInfo / getObject) plus the store's shared parseTree.
// When the base has not moved, this agrees with the store's own check exactly.

/** Flat path -> blob id map of a commit's tree, or null when it cannot be read. */
function flatTreeOf(store: Ctx['store'], repo: Repo, commitSha: string): Map<string, string> | null {
  const info = store.getCommitInfo(repo, commitSha);
  if (info === undefined) return null;
  const out = new Map<string, string>();
  const walk = (treeSha: string, prefix: string): boolean => {
    const obj = store.getObject(repo, treeSha);
    if (obj === undefined || obj.type !== 'tree') return false;
    for (const entry of parseTree(obj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') {
        if (!walk(entry.oid, path)) return false;
      } else if (entry.mode !== '160000') {
        out.set(path, entry.oid);
      }
    }
    return true;
  };
  return walk(info.tree, '') ? out : null;
}

/** First-parent merge-base of two commits, or undefined when there is none. */
function mergeBaseOf(
  store: Ctx['store'],
  repo: Repo,
  headSha: string,
  baseSha: string,
): string | undefined {
  const headSet = new Set<string>();
  let current: string | undefined = headSha;
  while (current !== undefined && !headSet.has(current)) {
    headSet.add(current);
    current = store.getCommitInfo(repo, current)?.parents[0];
  }
  const seen = new Set<string>();
  current = baseSha;
  while (current !== undefined && !seen.has(current)) {
    if (headSet.has(current)) return current;
    seen.add(current);
    current = store.getCommitInfo(repo, current)?.parents[0];
  }
  return undefined;
}

/**
 * True when the pull's head changes a path the base branch also changed (to
 * different content) since their merge-base — the three-way conflict rule,
 * evaluated against the base branch's live tip.
 */
function hasLiveConflict(store: Ctx['store'], repo: Repo, pull: Pull): boolean {
  const baseTip = store.getRef(repo, `refs/heads/${pull.base.ref}`);
  if (baseTip === undefined || baseTip === pull.base.sha) return false;
  const mb = mergeBaseOf(store, repo, pull.head.sha, baseTip);
  if (mb === undefined) return false;
  const mbFiles = flatTreeOf(store, repo, mb);
  const headFiles = flatTreeOf(store, repo, pull.head.sha);
  const baseFiles = flatTreeOf(store, repo, baseTip);
  if (mbFiles === null || headFiles === null || baseFiles === null) return false;
  const paths = new Set<string>([...mbFiles.keys(), ...headFiles.keys(), ...baseFiles.keys()]);
  for (const path of paths) {
    const m = mbFiles.get(path) ?? null;
    const h = headFiles.get(path) ?? null;
    const b = baseFiles.get(path) ?? null;
    if (h !== m && b !== m && h !== b) return true;
  }
  return false;
}

async function hPullMerge(ctx: Ctx): Promise<Resp | null> {
  const m = repoMatch(ctx);
  if (m === null || m.rest.length !== 3 || m.rest[0] !== 'pulls' || m.rest[2] !== 'merge') {
    return null;
  }
  if (ctx.method !== 'PUT') return null;
  const n = parseNumber(m.rest[1] as string);
  const auth = requireAuth(ctx);
  if (auth !== null) return auth;
  const repo = resolveRepo(ctx, m.owner, m.name);
  if (repo === null) return fail(ctx, 404, 'Not Found');
  if (n === null) return fail(ctx, 404, 'Not Found');
  const pull = ctx.store.getPull(repo, n);
  if (pull === undefined) return fail(ctx, 404, 'Not Found');
  if (pull.state !== 'open') return fail(ctx, 405, 'Pull request is closed');
  if (hasLiveConflict(ctx.store, repo, pull)) return fail(ctx, 405, 'Merge conflict');
  const parsed = readBody(ctx);
  if (parsed.malformed) return fail(ctx, 400, 'Invalid JSON');
  const body = asObj(parsed.value) ?? {};
  const method = typeof body.merge_method === 'string' ? body.merge_method : 'squash';
  const merged = ctx.store.mergePull(repo, n, method);
  if ('error' in merged) {
    if (merged.error === 'not-found') return fail(ctx, 404, 'Not Found');
    if (merged.error === 'conflict') return fail(ctx, 405, 'Merge conflict');
    return fail(ctx, 405, 'Pull request is closed');
  }
  return send(ctx, 200, { sha: merged.sha, merged: true, message: merged.message });
}

// ---------------------------------------------------------------------------
// catch-all + dispatch
// ---------------------------------------------------------------------------

async function hCatchAll(ctx: Ctx): Promise<Resp | null> {
  const p = normPath(ctx.path);
  if (p !== '/api/v3' && !p.startsWith('/api/v3/')) return null;
  const auth = requireAuth(ctx);
  if (auth !== null) return auth;
  return fail(ctx, 404, 'Not Found');
}

/** The per-route handlers, in match order (most specific first, catch-all last). */
export const restHandlers: Handler[] = [
  hRoot,
  hMeta,
  hUser,
  hUsersRepos,
  hRepo,
  hBranches,
  hRefs,
  hCommits,
  hContents,
  hLabels,
  hIssues,
  hIssueOne,
  hComments,
  hPulls,
  hPullOne,
  hPullFiles,
  hPullMerge,
  hCatchAll,
];

/** The single entry app.ts dispatches to: first non-null handler wins. */
export const handleRest: Handler = async (ctx) => {
  for (const handler of restHandlers) {
    try {
      const out = await handler(ctx);
      if (out !== null) return out;
    } catch {
      return fail(ctx, 500, 'Internal Server Error');
    }
  }
  return null;
};
