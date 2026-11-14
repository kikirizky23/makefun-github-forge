// lib/store.ts — the shared in-memory store for the github-core-clone-01 forge entry.
//
// One Store owns every repo, object, ref, issue, pull and label. All state lives in Maps;
// there is no filesystem access, no wall clock and no unseeded randomness anywhere here.
// The trial clock is a single fixed instant (MAKEFUN_TRIAL_NOW, else 2025-01-01T00:00:00Z)
// shared by every created/updated timestamp and every commit author/committer line.
//
// The scenario viewer is computed by porting the kit's seeded generator (wire.ts:
// fnv1a64 / mix64 / Rng / FIRST_NAMES / LAST_NAMES / generateUsers). viewer = users[0]
// is 'adaiversen' (id 1000) — verified against the kit's own buildScenario() output.

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// seeded scenario generator (ported verbatim from program/env/src/wire.ts)
// ---------------------------------------------------------------------------

export const SCENARIO_SEED = 0x6a09e667f3bcc909n;
export const U64_MASK = 0xffffffffffffffffn;

export function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

export function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

export function scenarioSeedFor(label: string): bigint {
  return mix64(SCENARIO_SEED ^ fnv1a64(label));
}

export class Rng {
  #state: bigint;

  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }

  static fromLabel(label: string): Rng {
    return new Rng(scenarioSeedFor(label));
  }

  clone(): Rng {
    return new Rng(this.#state);
  }

  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }

  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  nextInt(maxExclusive: number): number {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) {
      throw new Error(`nextInt needs a positive safe integer, not ${String(maxExclusive)}`);
    }
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from an empty list');
    return items[this.nextInt(items.length)];
  }
}

export function scenarioRng(label: string): Rng {
  return new Rng(scenarioSeedFor(label));
}

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

export interface ScenarioUser {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

/** `count` users with unique logins, deterministic for `rng` (wire.ts generateUsers). */
export function generateUsers(rng: Rng, count: number): ScenarioUser[] {
  const used = new Set<string>();
  const users: ScenarioUser[] = [];
  for (let i = 0; i < Math.max(0, Math.trunc(count)); i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

// ---------------------------------------------------------------------------
// object ids
// ---------------------------------------------------------------------------

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

export function hashObject(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

export interface GitObj {
  type: ObjType;
  data: Buffer;
}

export interface UserRef {
  login: string;
  id: number;
  type: 'User';
  avatar_url: string;
  html_url: string;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
  url: string;
}

export interface Comment {
  id: number;
  body: string;
  user: UserRef;
  created_at: string;
  updated_at: string;
  html_url: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  user: UserRef;
  assignee: null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  html_url: string;
  comments: Comment[];
}

export interface RepoRef {
  id: number;
  name: string;
  full_name: string;
  owner: UserRef;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: { ref: string; sha: string; label: string; repo: RepoRef };
  base: { ref: string; sha: string; label: string; repo: RepoRef };
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  mergeable: boolean;
  user: UserRef;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  html_url: string;
}

export type FlatFile = { blob: string; mode: string };

export interface Repo {
  id: number;
  name: string;
  full_name: string;
  owner: UserRef;
  description: string;
  private: boolean;
  default_branch: string;
  created_at: string;
  updated_at: string;
  pushed_at: string;
  html_url: string;
  clone_url: string;
  git_url: string;
  ssh_url: string;
  fork: boolean;
  archived: boolean;
  disabled: boolean;
  has_issues: boolean;
  has_projects: boolean;
  has_wiki: boolean;
  open_issues_count: number;
  objects: Map<string, GitObj>;
  refs: Map<string, string>;
  /** Flat path -> {blob, mode} per branch name. */
  files: Map<string, Map<string, FlatFile>>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  nextIssue: number;
  pulls: Map<number, Pull>;
  nextPull: number;
  nextComment: number;
}

export interface CommitInfo {
  sha: string;
  message: string;
  author: { name: string; email: string; date: string };
  committer: { name: string; email: string; date: string };
  tree: string;
  parents: string[];
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

// ---------------------------------------------------------------------------
// fixed trial clock
// ---------------------------------------------------------------------------

const FALLBACK_ISO = '2025-01-01T00:00:00Z';
const FALLBACK_EPOCH_SEC = 1735689600;

function parseTrialNow(): { iso: string; epochSec: number } {
  const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
  if (raw !== '') {
    if (/^-?\d+(\.\d+)?$/.test(raw)) {
      const n = Number(raw);
      const ms = n > 1e12 ? n : n * 1000;
      const d = new Date(ms);
      if (!Number.isNaN(d.getTime())) return { iso: d.toISOString(), epochSec: Math.floor(ms / 1000) };
    } else {
      const d = new Date(raw);
      if (!Number.isNaN(d.getTime())) return { iso: d.toISOString(), epochSec: Math.floor(d.getTime() / 1000) };
    }
  }
  return { iso: FALLBACK_ISO, epochSec: FALLBACK_EPOCH_SEC };
}

// ---------------------------------------------------------------------------
// git object parsing (shared by the store and lib/git.ts)
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTreeBytes(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const headerText = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export function parseTag(data: Buffer): { object: string; type: string; tag: string; tagger: string; message: string } {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const headers = new Map<string, string>();
  for (const line of (blank < 0 ? text : text.slice(0, blank)).split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : text.slice(blank + 2),
  };
}

const IDENT_RE = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/;

export function parseIdent(line: string): { name: string; email: string; date: string } {
  const m = IDENT_RE.exec(line);
  if (!m) return { name: line, email: '', date: '' };
  return { name: m[1] ?? '', email: m[2] ?? '', date: new Date(Number(m[3]) * 1000).toISOString() };
}

// ---------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------

function userRefOf(user: ScenarioUser): UserRef {
  return {
    login: user.login,
    id: user.id,
    type: 'User',
    avatar_url: `https://avatars.githubusercontent.com/u/${user.id}?v=4`,
    html_url: `https://github.com/${user.login}`,
  };
}

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export class Store {
  readonly users: ScenarioUser[];
  readonly viewerUser: ScenarioUser;
  readonly viewer: UserRef;
  /** The one fixed timestamp for every created/updated field. */
  readonly nowIsoStr: string;
  /** The same instant as Unix seconds (commit author/committer lines). */
  readonly nowEpochSec: number;
  /** All repos by `owner/name`, in creation order. */
  readonly repos = new Map<string, Repo>();

  private nextRepoId = 1;
  private nextGlobalId = 1;
  private labelSeq = new Map<string, number>();

  constructor() {
    this.users = generateUsers(scenarioRng('users'), 12);
    this.viewerUser = this.users[0] as ScenarioUser;
    this.viewer = userRefOf(this.viewerUser);
    const now = parseTrialNow();
    this.nowIsoStr = now.iso;
    this.nowEpochSec = now.epochSec;
  }

  nowIso(): string {
    return this.nowIsoStr;
  }

  // ---------------------------------------------------------------- repos

  createRepo(
    name: string,
    opts: { description?: string; private?: boolean; default_branch?: string } = {},
  ): Repo {
    const key = repoKey(this.viewer.login, name);
    const existing = this.repos.get(key);
    if (existing) return existing;
    const now = this.nowIsoStr;
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      full_name: key,
      owner: this.viewer,
      description: opts.description ?? '',
      private: opts.private ?? false,
      default_branch: opts.default_branch ?? 'main',
      created_at: now,
      updated_at: now,
      pushed_at: now,
      html_url: `https://github.com/${key}`,
      clone_url: `https://github.com/${key}.git`,
      git_url: `git://github.com/${key}.git`,
      ssh_url: `git@github.com:${key}.git`,
      fork: false,
      archived: false,
      disabled: false,
      has_issues: true,
      has_projects: true,
      has_wiki: true,
      open_issues_count: 0,
      objects: new Map(),
      refs: new Map(),
      files: new Map(),
      labels: new Map(),
      issues: new Map(),
      nextIssue: 1,
      pulls: new Map(),
      nextPull: 1,
      nextComment: 1,
    };
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(repoKey(owner, name));
  }

  listRepos(owner: string, opts: { page?: number; perPage?: number } = {}): Repo[] {
    const page = Math.max(1, Math.trunc(opts.page ?? 1) || 1);
    const perPage = Math.max(1, Math.trunc(opts.perPage ?? 30) || 30);
    const all: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner.login === owner) all.push(repo);
    return all.slice((page - 1) * perPage, page * perPage);
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(repoKey(owner, name));
  }

  updateRepo(repo: Repo, patch: { description?: string }): Repo {
    if (patch.description !== undefined) repo.description = patch.description;
    repo.updated_at = this.nowIsoStr;
    return repo;
  }

  repoRefOf(repo: Repo): RepoRef {
    return { id: repo.id, name: repo.name, full_name: repo.full_name, owner: repo.owner };
  }

  // ---------------------------------------------------------------- objects

  putObject(repo: Repo, type: ObjType, data: Buffer): string {
    const sha = hashObject(type, data);
    if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
    return sha;
  }

  getObject(repo: Repo, sha: string): GitObj | undefined {
    return repo.objects.get(sha);
  }

  getRef(repo: Repo, refname: string): string | undefined {
    return repo.refs.get(refname);
  }

  setRef(repo: Repo, refname: string, sha: string): void {
    repo.refs.set(refname, sha);
  }

  deleteRef(repo: Repo, refname: string): boolean {
    return repo.refs.delete(refname);
  }

  listRefs(repo: Repo, prefix?: string): Array<{ name: string; oid: string }> {
    const out: Array<{ name: string; oid: string }> = [];
    for (const [name, oid] of repo.refs) {
      if (prefix !== undefined && !name.startsWith(prefix)) continue;
      out.push({ name, oid });
    }
    return out;
  }

  /** Peel a tag object to its commit, following tag chains; a commit id passes through. */
  peelToCommit(repo: Repo, oid: string): string | undefined {
    let current = oid;
    for (let i = 0; i < 16; i += 1) {
      const obj = repo.objects.get(current);
      if (!obj) return undefined;
      if (obj.type === 'commit') return current;
      if (obj.type === 'tag') {
        current = parseTag(obj.data).object;
        continue;
      }
      return undefined;
    }
    return undefined;
  }

  /** Resolve a branch name, full ref name, tag name or object id to a commit id. */
  resolveCommit(repo: Repo, ref: string): string | undefined {
    const direct = repo.refs.get(ref);
    if (direct !== undefined) return this.peelToCommit(repo, direct);
    const branch = repo.refs.get(`refs/heads/${ref}`);
    if (branch !== undefined) return this.peelToCommit(repo, branch);
    const tag = repo.refs.get(`refs/tags/${ref}`);
    if (tag !== undefined) return this.peelToCommit(repo, tag);
    if (/^[0-9a-f]{40}$/.test(ref)) return this.peelToCommit(repo, ref);
    return undefined;
  }

  /** True when `ancestor` is reachable from `descendant` (all parents walked). */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const anc = this.peelToCommit(repo, ancestor);
    const desc = this.peelToCommit(repo, descendant);
    if (anc === undefined || desc === undefined) return false;
    if (anc === desc) return true;
    const seen = new Set<string>();
    const queue: string[] = [desc];
    while (queue.length) {
      const oid = queue.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) {
        if (parent === anc) return true;
        queue.push(parent);
      }
    }
    return false;
  }

  /** Every object id reachable from `roots` (commits, tags, trees, blobs). */
  collectReachable(repo: Repo, roots: Iterable<string>): Set<string> {
    const seen = new Set<string>();
    const queue: string[] = [];
    for (const root of roots) if (/^[0-9a-f]{40}$/.test(root)) queue.push(root);
    while (queue.length) {
      const oid = queue.pop() as string;
      if (seen.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj) throw new Error(`object ${oid} is missing from the store`);
      seen.add(oid);
      if (obj.type === 'commit') {
        const commit = parseCommit(obj.data);
        queue.push(commit.tree);
        for (const parent of commit.parents) queue.push(parent);
      } else if (obj.type === 'tag') {
        queue.push(parseTag(obj.data).object);
      } else if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) {
          if (entry.mode !== '160000') queue.push(entry.oid);
        }
      }
    }
    return seen;
  }

  /**
   * Commit ids within `depth` generations of `wants` (distance 0 = the wants themselves).
   * Used for shallow fetch/clone: depth 1 is the tips only.
   */
  collectDepth(repo: Repo, wants: readonly string[], depth: number): Set<string> {
    const included = new Set<string>();
    const dist = new Map<string, number>();
    const queue: Array<[string, number]> = [];
    for (const want of wants) {
      const commit = this.peelToCommit(repo, want);
      if (commit !== undefined && !dist.has(commit)) {
        dist.set(commit, 0);
        queue.push([commit, 0]);
      }
    }
    while (queue.length) {
      const [oid, d] = queue.shift() as [string, number];
      if (d >= depth || included.has(oid)) continue;
      included.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) {
        if (!dist.has(parent)) {
          dist.set(parent, d + 1);
          queue.push([parent, d + 1]);
        }
      }
    }
    return included;
  }

  /**
   * All objects reachable from `commits`, following trees and blobs but only descending into
   * parents that are themselves in `commits` (so a shallow cut stays cut).
   */
  expandFromCommits(repo: Repo, commits: ReadonlySet<string>): Set<string> {
    const seen = new Set<string>();
    const walkTree = (treeSha: string): void => {
      if (seen.has(treeSha)) return;
      const obj = repo.objects.get(treeSha);
      if (!obj || obj.type !== 'tree') return;
      seen.add(treeSha);
      for (const entry of parseTree(obj.data)) {
        if (entry.mode === '40000') walkTree(entry.oid);
        else if (entry.mode !== '160000') seen.add(entry.oid);
      }
    };
    for (const oid of commits) {
      if (seen.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      seen.add(oid);
      const commit = parseCommit(obj.data);
      walkTree(commit.tree);
      // Parents in `commits` are visited by the outer loop; parents outside it stay cut.
    }
    return seen;
  }

  // ---------------------------------------------------------- trees / commits

  /** Build (and store) the tree objects for a flat path map; returns the root tree id. */
  buildTreeFromFlat(repo: Repo, files: ReadonlyMap<string, FlatFile>): string {
    interface Node {
      files: Map<string, FlatFile>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, file] of files) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const name = segments[i] as string;
        let child = node.dirs.get(name);
        if (!child) {
          child = make();
          node.dirs.set(name, child);
        }
        node = child;
      }
      node.files.set(segments[segments.length - 1] as string, file);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.blob });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTreeBytes(entries));
    };
    return build(root);
  }

  /** Flat path map of a commit's tree (undefined when the commit/tree is missing). */
  flatFilesOfCommit(repo: Repo, commitSha: string): Map<string, FlatFile> | undefined {
    const commit = this.peelToCommit(repo, commitSha);
    if (commit === undefined) return undefined;
    const obj = repo.objects.get(commit);
    if (!obj || obj.type !== 'commit') return undefined;
    const out = new Map<string, FlatFile>();
    const walk = (treeSha: string, prefix: string): boolean => {
      const tree = repo.objects.get(treeSha);
      if (!tree || tree.type !== 'tree') return false;
      for (const entry of parseTree(tree.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') {
          if (!walk(entry.oid, path)) return false;
        } else if (entry.mode !== '160000') {
          out.set(path, { blob: entry.oid, mode: entry.mode });
        }
      }
      return true;
    };
    if (!walk(parseCommit(obj.data).tree, '')) return undefined;
    return out;
  }

  /** The branch's flat file map: the cached copy, else rebuilt from the branch tip. */
  branchFiles(repo: Repo, branch: string): Map<string, FlatFile> {
    const cached = repo.files.get(branch);
    if (cached) return cached;
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip !== undefined) {
      const rebuilt = this.flatFilesOfCommit(repo, tip);
      if (rebuilt) {
        repo.files.set(branch, rebuilt);
        return rebuilt;
      }
    }
    return new Map();
  }

  private writeCommit(
    repo: Repo,
    treeSha: string,
    parents: readonly string[],
    message: string,
  ): string {
    const ident = `${this.viewer.login} <${this.viewer.login}@example.invalid> ${this.nowEpochSec} +0000`;
    const msg = message.endsWith('\n') ? message : `${message}\n`;
    let text = `tree ${treeSha}\n`;
    for (const parent of parents) text += `parent ${parent}\n`;
    text += `author ${ident}\ncommitter ${ident}\n\n${msg}`;
    return this.putObject(repo, 'commit', Buffer.from(text, 'utf8'));
  }

  commitFile(
    repo: Repo,
    opts: { branch: string; path: string; content: Buffer | string; message: string },
  ): { commit: string } {
    const data = typeof opts.content === 'string' ? Buffer.from(opts.content, 'utf8') : opts.content;
    const blobSha = this.putObject(repo, 'blob', data);
    const parentSha = repo.refs.get(`refs/heads/${opts.branch}`);
    const files = new Map(this.branchFiles(repo, opts.branch));
    files.set(opts.path, { blob: blobSha, mode: '100644' });
    const treeSha = this.buildTreeFromFlat(repo, files);
    const commitSha = this.writeCommit(repo, treeSha, parentSha !== undefined ? [parentSha] : [], opts.message);
    repo.files.set(opts.branch, files);
    repo.refs.set(`refs/heads/${opts.branch}`, commitSha);
    repo.updated_at = this.nowIsoStr;
    repo.pushed_at = this.nowIsoStr;
    return { commit: commitSha };
  }

  deleteFile(
    repo: Repo,
    opts: { branch: string; path: string; message: string },
  ): { commit: string } {
    const parentSha = repo.refs.get(`refs/heads/${opts.branch}`);
    const files = new Map(this.branchFiles(repo, opts.branch));
    files.delete(opts.path);
    const treeSha = this.buildTreeFromFlat(repo, files);
    const commitSha = this.writeCommit(repo, treeSha, parentSha !== undefined ? [parentSha] : [], opts.message);
    repo.files.set(opts.branch, files);
    repo.refs.set(`refs/heads/${opts.branch}`, commitSha);
    repo.updated_at = this.nowIsoStr;
    repo.pushed_at = this.nowIsoStr;
    return { commit: commitSha };
  }

  readFile(
    repo: Repo,
    ref: string,
    path: string,
  ): { content: Buffer; sha: string; mode: string } | undefined {
    const commit = this.resolveCommit(repo, ref);
    if (commit === undefined) return undefined;
    const files = this.flatFilesOfCommit(repo, commit);
    if (!files) return undefined;
    const file = files.get(path);
    if (!file) return undefined;
    const blob = repo.objects.get(file.blob);
    if (!blob || blob.type !== 'blob') return undefined;
    return { content: blob.data, sha: file.blob, mode: file.mode };
  }

  listDir(
    repo: Repo,
    ref: string,
    path: string,
  ): Array<{ name: string; type: 'file' | 'dir'; sha: string; path: string }> | undefined {
    const commit = this.resolveCommit(repo, ref);
    if (commit === undefined) return undefined;
    const obj = repo.objects.get(commit);
    if (!obj || obj.type !== 'commit') return undefined;
    let treeSha = parseCommit(obj.data).tree;
    if (path !== '') {
      for (const segment of path.split('/')) {
        const tree = repo.objects.get(treeSha);
        if (!tree || tree.type !== 'tree') return undefined;
        const entry = parseTree(tree.data).find((e) => e.name === segment);
        if (!entry || entry.mode !== '40000') return undefined;
        treeSha = entry.oid;
      }
    }
    const tree = repo.objects.get(treeSha);
    if (!tree || tree.type !== 'tree') return undefined;
    return parseTree(tree.data)
      .filter((e) => e.mode !== '160000')
      .map((e) => ({
        name: e.name,
        type: (e.mode === '40000' ? 'dir' : 'file') as 'file' | 'dir',
        sha: e.oid,
        path: path === '' ? e.name : `${path}/${e.name}`,
      }));
  }

  getCommitInfo(repo: Repo, sha: string): CommitInfo | undefined {
    const commitSha = this.peelToCommit(repo, sha);
    if (commitSha === undefined) return undefined;
    const obj = repo.objects.get(commitSha);
    if (!obj || obj.type !== 'commit') return undefined;
    const parsed = parseCommit(obj.data);
    return {
      sha: commitSha,
      // The stored commit object ends its message with '\n' (git object
      // format); the API message has none. Strip it here so no consumer
      // (REST commitView, GraphQL, git log paths) can leak the newline.
      message: parsed.message.replace(/\n+$/, ''),
      author: parseIdent(parsed.author),
      committer: parseIdent(parsed.committer),
      tree: parsed.tree,
      parents: parsed.parents,
    };
  }

  listCommits(
    repo: Repo,
    branch: string,
    opts: { perPage?: number; page?: number } = {},
  ): CommitInfo[] {
    const perPage = Math.max(1, Math.trunc(opts.perPage ?? 30) || 30);
    const page = Math.max(1, Math.trunc(opts.page ?? 1) || 1);
    const tip = repo.refs.get(`refs/heads/${branch}`);
    const out: CommitInfo[] = [];
    let current = tip;
    const seen = new Set<string>();
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      const info = this.getCommitInfo(repo, current);
      if (!info) break;
      out.push(info);
      current = info.parents[0];
    }
    return out.slice((page - 1) * perPage, page * perPage);
  }

  createBranch(repo: Repo, name: string, sha: string): boolean {
    const refname = `refs/heads/${name}`;
    if (repo.refs.has(refname)) return false;
    if (!repo.objects.has(sha)) return false;
    repo.refs.set(refname, sha);
    return true;
  }

  // ------------------------------------------------------------- labels

  createLabel(repo: Repo, name: string, color?: string, description?: string): Label {
    const existing = repo.labels.get(name);
    if (existing) return existing;
    const key = repoKey(repo.owner.login, repo.name);
    const id = this.labelSeq.get(key) ?? 1;
    this.labelSeq.set(key, id + 1);
    const label: Label = {
      id,
      name,
      color: color ?? 'ffffff',
      description: description ?? '',
      url: `/api/v3/repos/${key}/labels/${encodeURIComponent(name)}`,
    };
    repo.labels.set(name, label);
    return label;
  }

  getLabel(repo: Repo, name: string): Label | undefined {
    return repo.labels.get(name);
  }

  listLabels(repo: Repo): Label[] {
    return [...repo.labels.values()];
  }

  // ------------------------------------------------------------- issues

  createIssue(
    repo: Repo,
    opts: { title: string; body?: string; labels?: string[] },
  ): Issue | { error: 'bad-label'; label: string } {
    const labels: Label[] = [];
    for (const name of opts.labels ?? []) {
      const label = repo.labels.get(name);
      if (!label) return { error: 'bad-label', label: name };
      labels.push(label);
    }
    const number = repo.nextIssue++;
    const now = this.nowIsoStr;
    const issue: Issue = {
      id: this.nextGlobalId++,
      number,
      title: opts.title,
      body: opts.body ?? '',
      state: 'open',
      labels,
      user: this.viewer,
      assignee: null,
      created_at: now,
      updated_at: now,
      closed_at: null,
      html_url: `https://github.com/${repo.full_name}/issues/${number}`,
      comments: [],
    };
    repo.issues.set(number, issue);
    // New issues are always open: keep the count O(1) instead of re-scanning
    // every issue in the repo (a create per issue made the write workload O(n^2)).
    repo.open_issues_count += 1;
    return issue;
  }

  getIssue(repo: Repo, n: number): Issue | undefined {
    return repo.issues.get(n);
  }

  listIssues(
    repo: Repo,
    opts: { state?: 'open' | 'closed' | 'all'; sort?: string; direction?: 'asc' | 'desc' } = {},
  ): Issue[] {
    const state = opts.state ?? 'all';
    const direction = opts.direction ?? 'desc';
    const list = [...repo.issues.values()].filter((i) => state === 'all' || i.state === state);
    list.sort((a, b) => {
      if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
      return a.number - b.number;
    });
    if (direction === 'desc') list.reverse();
    return list;
  }

  updateIssue(
    repo: Repo,
    n: number,
    patch: { state?: 'open' | 'closed'; title?: string; body?: string },
  ): Issue | undefined {
    const issue = repo.issues.get(n);
    if (!issue) return undefined;
    if (patch.title !== undefined) issue.title = patch.title;
    if (patch.body !== undefined) issue.body = patch.body;
    if (patch.state !== undefined && patch.state !== issue.state) {
      // The count moves only on a real open<->closed transition, so it stays
      // exactly the number of open issues. Every state change flows through
      // here (REST PATCH, GraphQL closeIssue); nothing mutates issue.state
      // directly anywhere else.
      repo.open_issues_count += patch.state === 'closed' ? -1 : 1;
      issue.state = patch.state;
      issue.closed_at = patch.state === 'closed' ? this.nowIsoStr : null;
    }
    issue.updated_at = this.nowIsoStr;
    return issue;
  }

  addComment(repo: Repo, n: number, body: string): Comment | undefined {
    const issue = repo.issues.get(n);
    if (!issue) return undefined;
    const now = this.nowIsoStr;
    const comment: Comment = {
      id: repo.nextComment++,
      body,
      user: this.viewer,
      created_at: now,
      updated_at: now,
      html_url: `https://github.com/${repo.full_name}/issues/${n}#issuecomment-${repo.nextComment - 1}`,
    };
    issue.comments.push(comment);
    issue.updated_at = now;
    return comment;
  }

  listComments(repo: Repo, n: number): Comment[] {
    return repo.issues.get(n)?.comments ?? [];
  }

  // ------------------------------------------------------------- pulls

  /** First-parent walk of a commit, newest first. */
  private firstParentChain(repo: Repo, tip: string): string[] {
    const chain: string[] = [];
    let current: string | undefined = this.peelToCommit(repo, tip);
    const seen = new Set<string>();
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      chain.push(current);
      const obj = repo.objects.get(current);
      if (!obj || obj.type !== 'commit') break;
      current = parseCommit(obj.data).parents[0];
    }
    return chain;
  }

  /** Merge-base: the first commit on the base chain that is also on the head chain. */
  mergeBase(repo: Repo, headSha: string, baseSha: string): string | undefined {
    const headSet = new Set(this.firstParentChain(repo, headSha));
    for (const oid of this.firstParentChain(repo, baseSha)) {
      if (headSet.has(oid)) return oid;
    }
    return undefined;
  }

  private hasConflict(
    repo: Repo,
    headSha: string,
    baseSha: string,
  ): boolean {
    const mb = this.mergeBase(repo, headSha, baseSha);
    if (mb === undefined) return false;
    const mbFiles = this.flatFilesOfCommit(repo, mb) ?? new Map<string, FlatFile>();
    const headFiles = this.flatFilesOfCommit(repo, headSha) ?? new Map<string, FlatFile>();
    const baseFiles = this.flatFilesOfCommit(repo, baseSha) ?? new Map<string, FlatFile>();
    const paths = new Set<string>([...mbFiles.keys(), ...headFiles.keys(), ...baseFiles.keys()]);
    for (const path of paths) {
      const m = mbFiles.get(path)?.blob ?? null;
      const h = headFiles.get(path)?.blob ?? null;
      const b = baseFiles.get(path)?.blob ?? null;
      if (h !== m && b !== m && h !== b) return true;
    }
    return false;
  }

  createPull(
    repo: Repo,
    opts: { title: string; body?: string; head: string; base: string },
  ): Pull | { error: 'head' | 'base' } {
    const headSha = repo.refs.get(`refs/heads/${opts.head}`);
    if (headSha === undefined) return { error: 'head' };
    const baseSha = repo.refs.get(`refs/heads/${opts.base}`);
    if (baseSha === undefined) return { error: 'base' };
    const number = repo.nextPull++;
    const now = this.nowIsoStr;
    const ref = this.repoRefOf(repo);
    const pull: Pull = {
      id: this.nextGlobalId++,
      number,
      title: opts.title,
      body: opts.body ?? '',
      state: 'open',
      head: { ref: opts.head, sha: headSha, label: `${repo.owner.login}:${opts.head}`, repo: ref },
      base: { ref: opts.base, sha: baseSha, label: `${repo.owner.login}:${opts.base}`, repo: ref },
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      mergeable: !this.hasConflict(repo, headSha, baseSha),
      user: this.viewer,
      created_at: now,
      updated_at: now,
      closed_at: null,
      html_url: `https://github.com/${repo.full_name}/pull/${number}`,
    };
    repo.pulls.set(number, pull);
    return pull;
  }

  getPull(repo: Repo, n: number): Pull | undefined {
    return repo.pulls.get(n);
  }

  listPulls(repo: Repo, opts: { state?: 'open' | 'closed' | 'all' } = {}): Pull[] {
    const state = opts.state ?? 'all';
    const list = [...repo.pulls.values()].filter((p) => state === 'all' || p.state === state);
    list.sort((a, b) => b.number - a.number);
    return list;
  }

  pullFiles(repo: Repo, n: number): PullFile[] {
    const pull = repo.pulls.get(n);
    if (!pull) return [];
    const mb = this.mergeBase(repo, pull.head.sha, pull.base.sha);
    const mbFiles = mb !== undefined ? (this.flatFilesOfCommit(repo, mb) ?? new Map<string, FlatFile>()) : new Map<string, FlatFile>();
    const headFiles = this.flatFilesOfCommit(repo, pull.head.sha) ?? new Map<string, FlatFile>();
    const paths = new Set<string>([...mbFiles.keys(), ...headFiles.keys()]);
    const out: PullFile[] = [];
    for (const path of [...paths].sort()) {
      const old = mbFiles.get(path);
      const next = headFiles.get(path);
      if (old?.blob === next?.blob) continue;
      const status = old === undefined ? 'added' : next === undefined ? 'removed' : 'modified';
      const oldText = old !== undefined ? (repo.objects.get(old.blob)?.data.toString('utf8') ?? '') : '';
      const newText = next !== undefined ? (repo.objects.get(next.blob)?.data.toString('utf8') ?? '') : '';
      const { additions, deletions } = lineDiff(oldText, newText);
      out.push({ filename: path, status, additions, deletions, changes: additions + deletions });
    }
    return out;
  }

  mergePull(
    repo: Repo,
    n: number,
    method: string,
  ): { sha: string; merged: true; message: string } | { error: 'not-found' | 'conflict' | 'closed' } {
    const pull = repo.pulls.get(n);
    if (!pull) return { error: 'not-found' };
    if (pull.state !== 'open') return { error: 'closed' };
    // Conflict is checked against the base branch's LIVE tip, not pull.base.sha
    // (the tip at PR creation): after PR-A merges, PR-B touching the same file
    // must be a conflict even though nothing changed against the stale snapshot.
    const liveBaseSha = repo.refs.get(`refs/heads/${pull.base.ref}`) ?? pull.base.sha;
    if (this.hasConflict(repo, pull.head.sha, liveBaseSha)) return { error: 'conflict' };
    const mb = this.mergeBase(repo, pull.head.sha, liveBaseSha);
    const mbFiles = mb !== undefined ? (this.flatFilesOfCommit(repo, mb) ?? new Map<string, FlatFile>()) : new Map<string, FlatFile>();
    const headFiles = this.flatFilesOfCommit(repo, pull.head.sha) ?? new Map<string, FlatFile>();
    const baseFiles = new Map(this.branchFiles(repo, pull.base.ref));
    // Three-way result: a path takes the head value when head changed it vs merge-base,
    // otherwise it keeps the base branch value (including head-side deletions).
    const paths = new Set<string>([...mbFiles.keys(), ...headFiles.keys(), ...baseFiles.keys()]);
    const merged = new Map<string, FlatFile>();
    for (const path of paths) {
      const m = mbFiles.get(path)?.blob ?? null;
      const h = headFiles.get(path);
      const hBlob = h?.blob ?? null;
      if (hBlob !== m) {
        if (h !== undefined) merged.set(path, h);
      } else {
        const b = baseFiles.get(path);
        if (b !== undefined) merged.set(path, b);
      }
    }
    const treeSha = this.buildTreeFromFlat(repo, merged);
    const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`);
    const parents = baseTip !== undefined ? [baseTip] : [];
    let message: string;
    if (method === 'merge') {
      parents.push(pull.head.sha);
      message = `Merge pull request #${n} from ${pull.head.ref}\n\n${pull.title}`;
    } else {
      // 'squash' (and any other method: squash is the only merge the suite exercises).
      message = `${pull.title} (#${n})`;
    }
    const sha = this.writeCommit(repo, treeSha, parents, message);
    repo.files.set(pull.base.ref, merged);
    repo.refs.set(`refs/heads/${pull.base.ref}`, sha);
    repo.updated_at = this.nowIsoStr;
    repo.pushed_at = this.nowIsoStr;
    pull.state = 'closed';
    pull.merged = true;
    pull.merged_at = this.nowIsoStr;
    pull.merge_commit_sha = sha;
    pull.closed_at = this.nowIsoStr;
    pull.updated_at = this.nowIsoStr;
    return { sha, merged: true, message };
  }
}

/** Split into lines, not counting the empty piece after a trailing newline. */
function splitLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** Line additions/deletions between two texts, via LCS on lines (files here are small). */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  if (a.length === 0 && b.length === 0) return { additions: 0, deletions: 0 };
  if (a.length * b.length > 4_000_000) {
    return { additions: b.length, deletions: a.length };
  }
  // LCS lengths, two rows.
  let prev = new Array<number>(b.length + 1).fill(0);
  let curr = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
    curr.fill(0);
  }
  const lcs = prev[b.length] ?? 0;
  return { additions: b.length - lcs, deletions: a.length - lcs };
}
