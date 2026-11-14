// POST /api/graphql — GitHub GraphQL v4 surface for the github-core-clone entry.
// Hand-rolled document parser + executor (stdlib only, no GraphQL library), built
// to answer exactly the documents gh / github-mcp-server send (see the env's
// graphql-client.ts and checks-graphql.ts): viewer, repository (+ issue/issues/
// pullRequest/pullRequests), node(id:), the __type probes, the five mutations,
// batching, cursor pagination, opaque stable global ids.
//
// Auth: ctx.authed (Bearer MAKEFUN_SHOP_TOKEN, decided by the app router).
// Unauthenticated -> 401 {"message": ...}. Unknown field -> HTTP 200 with an
// errors array naming the field. Unknown repository -> data.repository null,
// no errors. Determinism: no wall clock (store.nowIso()), no Math.random.

import type { Ctx, Handler, Issue, Pull, Repo, Resp, Store } from './types.ts';

export const GRAPHQL_PATH = '/api/graphql';

// ---------------------------------------------------------------------------
// Global (Relay) ids: base64url of a typed, human-readable key. Opaque (never
// the plain databaseId / issue number), stable across reads, decodable so the
// mutations can round-trip repositoryId / issueId / pullRequestId / subjectId.
// ---------------------------------------------------------------------------

function b64uEncode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function b64uDecode(text: string): string | null {
  try {
    const decoded = Buffer.from(text, 'base64url').toString('utf8');
    if (decoded === '' || b64uEncode(decoded) !== text) return null;
    return decoded;
  } catch {
    return null;
  }
}

function repoGlobalId(repo: Repo): string {
  return b64uEncode(`repo:${repo.owner.login}/${repo.name}`);
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return b64uEncode(`issue:${repo.owner.login}/${repo.name}:${issue.number}`);
}

function pullGlobalId(repo: Repo, pull: Pull): string {
  return b64uEncode(`pull:${repo.owner.login}/${repo.name}:${pull.number}`);
}

function commentGlobalId(repo: Repo, issueNumber: number, commentId: number): string {
  return b64uEncode(`comment:${repo.owner.login}/${repo.name}:${issueNumber}:${commentId}`);
}

function userGlobalId(login: string): string {
  return b64uEncode(`user:${login}`);
}

function cursorEncode(n: number): string {
  return b64uEncode(`cursor:${n}`);
}

function cursorDecode(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  const decoded = b64uDecode(cursor);
  if (decoded === null) return null;
  const m = /^cursor:(\d+)$/.exec(decoded);
  return m === null ? null : Number(m[1]);
}

interface DecodedId {
  kind: string;
  owner: string;
  repo: string;
  number: number;
  extra: number;
}

function decodeGlobalId(id: unknown): DecodedId | null {
  if (typeof id !== 'string' || id === '') return null;
  const decoded = b64uDecode(id);
  if (decoded === null) return null;
  const m = /^(repo|issue|pull|comment|user):(.+)$/.exec(decoded);
  if (m === null) return null;
  const kind = m[1] as string;
  const rest = m[2] as string;
  if (kind === 'user') return { kind, owner: rest, repo: '', number: 0, extra: 0 };
  if (kind === 'repo') {
    const slash = rest.indexOf('/');
    if (slash < 0) return null;
    return { kind, owner: rest.slice(0, slash), repo: rest.slice(slash + 1), number: 0, extra: 0 };
  }
  const parts = rest.split(':');
  const full = parts[0] as string;
  const slash = full.indexOf('/');
  if (slash < 0) return null;
  const number = Number(parts[1]);
  if (!Number.isInteger(number)) return null;
  return { kind, owner: full.slice(0, slash), repo: full.slice(slash + 1), number, extra: Number(parts[2] ?? 0) };
}

// Decode-first, scan-fallback resolution (the scan covers ids handed back in a
// form this layer did not mint, e.g. a plain REST numeric id in a later flow).
function findRepoByGlobalId(store: Store, id: unknown): Repo | undefined {
  const decoded = decodeGlobalId(id);
  if (decoded !== null && decoded.kind === 'repo') return store.getRepo(decoded.owner, decoded.repo);
  if (typeof id === 'string') {
    for (const repo of store.repos.values()) if (repoGlobalId(repo) === id) return repo;
  }
  return undefined;
}

function findIssueByGlobalId(store: Store, id: unknown): { repo: Repo; issue: Issue } | undefined {
  const decoded = decodeGlobalId(id);
  if (decoded !== null && decoded.kind === 'issue') {
    const repo = store.getRepo(decoded.owner, decoded.repo);
    if (repo !== undefined) {
      const issue = store.getIssue(repo, decoded.number);
      if (issue !== undefined) return { repo, issue };
    }
    return undefined;
  }
  if (typeof id === 'string') {
    for (const repo of store.repos.values()) {
      for (const issue of store.listIssues(repo, {})) {
        if (issueGlobalId(repo, issue) === id) return { repo, issue };
      }
    }
  }
  return undefined;
}

function findPullByGlobalId(store: Store, id: unknown): { repo: Repo; pull: Pull } | undefined {
  const decoded = decodeGlobalId(id);
  if (decoded !== null && decoded.kind === 'pull') {
    const repo = store.getRepo(decoded.owner, decoded.repo);
    if (repo !== undefined) {
      const pull = store.getPull(repo, decoded.number);
      if (pull !== undefined) return { repo, pull };
    }
    return undefined;
  }
  if (typeof id === 'string') {
    for (const repo of store.repos.values()) {
      for (const pull of store.listPulls(repo, {})) {
        if (pullGlobalId(repo, pull) === id) return { repo, pull };
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Schema tables: field -> declared return type ('[T]' = list). These drive
// validation (unknown field -> error naming it), introspection (__type fields)
// and execution (which sub-selections apply to which type).
// ---------------------------------------------------------------------------

const FIELD_TYPE: Record<string, Record<string, string>> = {
  Query: {
    viewer: 'User',
    repository: 'Repository',
    node: 'Node',
    __type: '__Type',
    __schema: '__Schema',
  },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  Node: { id: 'ID' },
  User: { id: 'ID', login: 'String', name: 'String', avatarUrl: 'String' },
  Repository: {
    id: 'ID', databaseId: 'Int', name: 'String', nameWithOwner: 'String',
    owner: 'User', defaultBranchRef: 'Ref', viewerPermission: 'RepositoryPermission',
    hasIssuesEnabled: 'Boolean', description: 'String', url: 'String',
    issue: 'Issue', issues: 'IssueConnection',
    pullRequest: 'PullRequest', pullRequests: 'PullRequestConnection',
  },
  Ref: { id: 'ID', name: 'String', prefix: 'String' },
  Issue: {
    id: 'ID', number: 'Int', title: 'String', state: 'IssueState', body: 'String',
    labels: '[Label]', author: 'User', user: 'User',
    createdAt: 'String', updatedAt: 'String', closedAt: 'String', url: 'String',
    comments: 'IssueCommentConnection',
  },
  Label: { id: 'ID', name: 'String', color: 'String', description: 'String' },
  IssueConnection: { nodes: '[Issue]', totalCount: 'Int', pageInfo: 'PageInfo' },
  IssueCommentConnection: { nodes: '[IssueComment]', totalCount: 'Int', pageInfo: 'PageInfo' },
  IssueComment: { id: 'ID', body: 'String', author: 'User', createdAt: 'String', updatedAt: 'String' },
  IssueCommentEdge: { node: 'IssueComment', cursor: 'String' },
  PullRequest: {
    id: 'ID', number: 'Int', title: 'String', body: 'String', state: 'PullRequestState',
    merged: 'Boolean', headRefName: 'String', baseRefName: 'String',
    mergeable: 'MergeableState', files: 'PullRequestChangedFileConnection',
    author: 'User', user: 'User',
    createdAt: 'String', updatedAt: 'String', closedAt: 'String', mergedAt: 'String', url: 'String',
  },
  PullRequestConnection: { nodes: '[PullRequest]', totalCount: 'Int', pageInfo: 'PageInfo' },
  PullRequestChangedFileConnection: { nodes: '[PullRequestChangedFile]', totalCount: 'Int', pageInfo: 'PageInfo' },
  PullRequestChangedFile: { path: 'String', additions: 'Int', deletions: 'Int' },
  PageInfo: { hasNextPage: 'Boolean', hasPreviousPage: 'Boolean', startCursor: 'String', endCursor: 'String' },
  CreateIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CloseIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  MergePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge', subject: 'Issue', clientMutationId: 'String' },
  __Schema: {
    queryType: '__Type', mutationType: '__Type', subscriptionType: '__Type',
    types: '[__Type]', directives: '[__Directive]',
  },
  __Type: {
    name: 'String', kind: '__TypeKind', description: 'String',
    fields: '[__Field]', enumValues: '[__EnumValue]', inputFields: '[__InputValue]',
    interfaces: '[__Type]', possibleTypes: '[__Type]', ofType: '__Type',
  },
  __Field: { name: 'String', description: 'String', args: '[__InputValue]', type: '__Type', isDeprecated: 'Boolean', deprecationReason: 'String' },
  __InputValue: { name: 'String', description: 'String', type: '__Type', defaultValue: 'String' },
  __EnumValue: { name: 'String', description: 'String', isDeprecated: 'Boolean', deprecationReason: 'String' },
  __Directive: { name: 'String', description: 'String', locations: '[String]', args: '[__InputValue]' },
};

const TYPE_KIND: Record<string, string> = {
  Query: 'OBJECT', Mutation: 'OBJECT', Node: 'INTERFACE', User: 'OBJECT',
  Repository: 'OBJECT', Ref: 'OBJECT', Issue: 'OBJECT', Label: 'OBJECT',
  IssueConnection: 'OBJECT', IssueCommentConnection: 'OBJECT', IssueComment: 'OBJECT',
  IssueCommentEdge: 'OBJECT', PullRequest: 'OBJECT', PullRequestConnection: 'OBJECT',
  PullRequestChangedFileConnection: 'OBJECT', PullRequestChangedFile: 'OBJECT',
  PageInfo: 'OBJECT', CreateIssuePayload: 'OBJECT', CloseIssuePayload: 'OBJECT',
  CreatePullRequestPayload: 'OBJECT', MergePullRequestPayload: 'OBJECT',
  AddCommentPayload: 'OBJECT', __Schema: 'OBJECT', __Type: 'OBJECT', __Field: 'OBJECT',
  __InputValue: 'OBJECT', __EnumValue: 'OBJECT', __Directive: 'OBJECT',
  String: 'SCALAR', Int: 'SCALAR', Boolean: 'SCALAR', ID: 'SCALAR',
  IssueState: 'ENUM', OrderDirection: 'ENUM', IssueOrderField: 'ENUM',
  MergeableState: 'ENUM', PullRequestState: 'ENUM', PullRequestMergeMethod: 'ENUM',
  RepositoryPermission: 'ENUM', SearchType: 'ENUM', __TypeKind: 'ENUM',
};

const ENUM_VALUES: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'CODE', 'COMMIT', 'DISCUSSION'],
  __TypeKind: ['SCALAR', 'OBJECT', 'INTERFACE', 'UNION', 'ENUM', 'INPUT_OBJECT', 'LIST', 'NON_NULL'],
};

// ---------------------------------------------------------------------------
// Introspection value builders.
// ---------------------------------------------------------------------------

function typeRef(declared: string): Record<string, unknown> {
  if (declared.startsWith('[') && declared.endsWith(']')) {
    const inner = declared.slice(1, -1);
    return { kind: 'LIST', name: null, ofType: typeRef(inner) };
  }
  return { kind: TYPE_KIND[declared] ?? 'OBJECT', name: declared, ofType: null };
}

function typeFieldsList(typeName: string): Array<Record<string, unknown>> {
  const fields = FIELD_TYPE[typeName] ?? {};
  return Object.keys(fields).map((name) => ({
    __typename: '__Field',
    name,
    description: null,
    args: [],
    type: typeRef(fields[name] as string),
    isDeprecated: false,
    deprecationReason: null,
  }));
}

function typeEnumValuesList(typeName: string): Array<Record<string, unknown>> {
  return (ENUM_VALUES[typeName] ?? []).map((name) => ({
    __typename: '__EnumValue',
    name,
    description: null,
    isDeprecated: false,
    deprecationReason: null,
  }));
}

function schemaTypesList(): Array<Record<string, unknown>> {
  return Object.keys(TYPE_KIND).sort().map((name) => ({
    __typename: '__Type',
    typeName: name,
  }));
}

// ---------------------------------------------------------------------------
// Document parser: tokenizer + recursive descent. Supports the documents the
// suite sends: query/mutation, operation names, variable definitions,
// arguments (variables, strings, ints, enums, lists, input objects, null),
// aliases, inline fragments (`... on Type`) and named fragment spreads.
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selections?: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition?: string;
  selections: SelectionNode[];
}

interface SpreadNode {
  kind: 'spread';
  name: string;
}

type SelectionNode = FieldNode | FragmentNode | SpreadNode;

interface OperationNode {
  kind: 'query' | 'mutation' | 'subscription';
  name?: string;
  varDefs: Array<{ name: string; required: boolean }>;
  selections: SelectionNode[];
}

interface FragmentDef {
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentDef>;
}

interface Token {
  kind: 'name' | 'string' | 'int' | 'float' | 'punct' | 'eof';
  value: string;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < src.length) {
    const c = src[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') { i += 1; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '.' && src.slice(i, i + 3) === '...') { tokens.push({ kind: 'punct', value: '...' }); i += 3; continue; }
    if ('!$&()[]{}:=@|'.includes(c)) { tokens.push({ kind: 'punct', value: c }); i += 1; continue; }
    if (c === '"') {
      if (src.slice(i, i + 3) === '"""') {
        const end = src.indexOf('"""', i + 3);
        const raw = end < 0 ? src.slice(i + 3) : src.slice(i + 3, end);
        tokens.push({ kind: 'string', value: raw.replace(/\\"""/g, '"""') });
        i = end < 0 ? src.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (c === '-' || /[0-9]/.test(c)) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1;
      let isFloat = false;
      if (src[j] === '.') { isFloat = true; j += 1; while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1; }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true; j += 1;
        if (src[j] === '+' || src[j] === '-') j += 1;
        while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < src.length && isNameChar(src[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(c)} at offset ${i}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) { this.tokens = tokens; }

  private peek(): Token { return this.tokens[this.pos] as Token; }
  private next(): Token { const t = this.tokens[this.pos] as Token; this.pos += 1; return t; }
  private expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) throw new Error(`Expected '${value}' but got '${t.value}'`);
  }
  private acceptPunct(value: string): boolean {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === value) { this.pos += 1; return true; }
    return false;
  }
  private expectName(): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`Expected a name but got '${t.value}'`);
    return t.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.peek().kind !== 'eof') {
      const t = this.peek();
      if (t.kind === 'punct' && t.value === '{') {
        operations.push({ kind: 'query', varDefs: [], selections: this.parseSelectionSet() });
        continue;
      }
      if (t.kind === 'name' && t.value === 'fragment') {
        this.next();
        const name = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error(`Expected 'on' in fragment definition`);
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(name, { name, typeCondition, selections: this.parseSelectionSet() });
        continue;
      }
      if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation' || t.value === 'subscription')) {
        this.next();
        const kind = t.value as OperationNode['kind'];
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.next().value;
        const varDefs = this.parseVarDefs();
        this.skipDirectives();
        operations.push({ kind, name, varDefs, selections: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`Unexpected token '${t.value}' at document top level`);
    }
    return { operations, fragments };
  }

  private parseVarDefs(): Array<{ name: string; required: boolean }> {
    const defs: Array<{ name: string; required: boolean }> = [];
    if (!this.acceptPunct('(')) return defs;
    while (!this.acceptPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      // Type: a name, possibly wrapped in [ ] and suffixed with !. Skip its tokens.
      if (this.acceptPunct('[')) {
        this.expectName();
        this.expectPunct(']');
      } else {
        this.expectName();
      }
      let required = false;
      if (this.acceptPunct('!')) required = true;
      if (this.acceptPunct('=')) this.parseValue(); // default value
      defs.push({ name, required });
    }
    return defs;
  }

  private skipDirectives(): void {
    while (this.acceptPunct('@')) {
      this.expectName();
      if (this.acceptPunct('(')) {
        let depth = 1;
        while (depth > 0) {
          const t = this.next();
          if (t.kind === 'eof') throw new Error('Unterminated directive');
          if (t.kind === 'punct' && t.value === '(') depth += 1;
          if (t.kind === 'punct' && t.value === ')') depth -= 1;
        }
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.acceptPunct('}')) {
      if (this.peek().kind === 'eof') throw new Error('Unterminated selection set');
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      const t = this.peek();
      if (t.kind === 'name' && t.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (t.kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'spread', name };
      }
      this.skipDirectives();
      return { kind: 'fragment', selections: this.parseSelectionSet() };
    }
    let name = this.expectName();
    let alias: string | undefined;
    if (this.acceptPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    this.skipDirectives();
    let selections: SelectionNode[] | undefined;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selections = this.parseSelectionSet();
    const field: FieldNode = { kind: 'field', name, args };
    if (alias !== undefined) field.alias = alias;
    if (selections !== undefined) field.selections = selections;
    return field;
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') return { kind: 'variable', name: this.expectName() };
    if (t.kind === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.next();
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: Number(t.value) };
    if (t.kind === 'float') return { kind: 'float', value: Number(t.value) };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`Unexpected value token '${t.value}'`);
  }
}

function parseDocument(query: string): DocumentNode {
  return new Parser(tokenize(query)).parseDocument();
}

// Resolve an AST value against the operation variables.
function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return variables[node.name];
    case 'int': case 'float': case 'string': case 'boolean': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = resolveValue(f.value, variables);
      return out;
    }
  }
}

function resolveArgs(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of field.args) out[a.name] = resolveValue(a.value, variables);
  return out;
}

// ---------------------------------------------------------------------------
// Executor.
// ---------------------------------------------------------------------------

interface GqlError {
  message: string;
  path?: Array<string | number>;
}

interface ExecState {
  store: Store;
  ctx: Ctx;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentDef>;
  errors: GqlError[];
}

type Wrapper = Record<string, unknown> & { __typename?: string };

function effectiveType(parent: Wrapper, declaredType: string): string {
  return typeof parent.__typename === 'string' ? parent.__typename : declaredType;
}

function declaredOf(parentType: string, fieldName: string): string | undefined {
  return (FIELD_TYPE[parentType] ?? {})[fieldName];
}

function isListDeclared(declared: string): boolean {
  return declared.startsWith('[') && declared.endsWith(']');
}

function childTypeOf(declared: string): string {
  return isListDeclared(declared) ? declared.slice(1, -1) : declared;
}

function isLeafType(typeName: string): boolean {
  return typeName === 'String' || typeName === 'Int' || typeName === 'Boolean' || typeName === 'ID'
    || TYPE_KIND[typeName] === 'ENUM' || TYPE_KIND[typeName] === 'SCALAR';
}

function executeSelections(
  parent: Wrapper,
  parentType: string,
  selections: SelectionNode[],
  path: Array<string | number>,
  ex: ExecState,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const type = effectiveType(parent, parentType);
  for (const sel of selections) {
    if (sel.kind === 'spread') {
      const def = ex.fragments.get(sel.name);
      if (def !== undefined) {
        if (def.typeCondition === type || def.typeCondition === parentType) {
          Object.assign(out, executeSelections(parent, parentType, def.selections, path, ex));
        }
      } else {
        ex.errors.push({ message: `Unknown fragment "${sel.name}".`, path });
      }
      continue;
    }
    if (sel.kind === 'fragment') {
      if (sel.typeCondition === undefined || sel.typeCondition === type || sel.typeCondition === parentType) {
        Object.assign(out, executeSelections(parent, parentType, sel.selections, path, ex));
      }
      continue;
    }
    const field = sel;
    const key = field.alias ?? field.name;
    const declared = declaredOf(type, field.name);
    if (declared === undefined) {
      // Unknown field: 200 + errors naming the field; the field is absent.
      ex.errors.push({
        message: `Cannot query field "${field.name}" on type "${type}".`,
        path: [...path, key],
      });
      continue;
    }
    const childType = childTypeOf(declared);
    const args = resolveArgs(field, ex.variables);
    const resolved = resolveField(parent, type, field.name, args, ex);
    const fieldPath = [...path, key];
    if (resolved === null || resolved === undefined) {
      out[key] = null;
      continue;
    }
    if (field.selections !== undefined && !isLeafType(childType)) {
      if (isListDeclared(declared)) {
        const list = Array.isArray(resolved) ? resolved : [];
        out[key] = list.map((el, i) => {
          if (el === null || el === undefined) return null;
          return executeSelections(el as Wrapper, childType, field.selections as SelectionNode[], [...fieldPath, i], ex);
        });
      } else {
        out[key] = executeSelections(resolved as Wrapper, childType, field.selections, fieldPath, ex);
      }
    } else {
      out[key] = resolved;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Field resolvers. Each returns the raw value for a field (a wrapper object
// for object types, a scalar for leaves, an array for list fields, null).
// ---------------------------------------------------------------------------

function repoWrapper(repo: Repo): Wrapper {
  return { __typename: 'Repository', repo };
}

function issueWrapper(repo: Repo, issue: Issue): Wrapper {
  return { __typename: 'Issue', repo, issue };
}

function pullWrapper(repo: Repo, pull: Pull): Wrapper {
  return { __typename: 'PullRequest', repo, pull };
}

function userWrapper(login: string): Wrapper {
  return { __typename: 'User', login };
}

function numericDbId(repo: Repo): number {
  if (typeof repo.id === 'number' && Number.isInteger(repo.id) && repo.id > 0) return repo.id;
  const asNumber = Number(repo.id);
  if (Number.isInteger(asNumber) && asNumber > 0) return asNumber;
  let hash = 2166136261;
  for (let i = 0; i < repo.full_name.length; i += 1) {
    hash ^= repo.full_name.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (Math.abs(hash) % 2147483647) + 1;
}

function upperState(state: unknown): string {
  if (typeof state !== 'string') return 'OPEN';
  const upper = state.toUpperCase();
  return upper === 'OPEN' || upper === 'CLOSED' || upper === 'MERGED' ? upper : 'OPEN';
}

function mergeableOf(pull: Pull): string {
  const m = pull.mergeable;
  if (typeof m === 'string') {
    const upper = m.toUpperCase();
    if (upper === 'MERGEABLE' || upper === 'CONFLICTING' || upper === 'UNKNOWN') return upper;
  }
  if (typeof m === 'boolean') return m ? 'MERGEABLE' : 'CONFLICTING';
  return 'MERGEABLE';
}

interface PageInfoValue {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

function pageInfoOf(total: number, pageSize: number, hasPrev: boolean, lastCursor: string | null, firstCursor: string | null): PageInfoValue {
  return {
    hasNextPage: total > pageSize,
    hasPreviousPage: hasPrev,
    startCursor: firstCursor,
    endCursor: lastCursor,
  };
}

function labelWrappers(issue: Issue): Wrapper[] {
  const out: Wrapper[] = [];
  for (const label of issue.labels ?? []) {
    if (typeof label === 'string') {
      out.push({ __typename: 'Label', name: label, color: null, description: null });
    } else if (label !== null && typeof label === 'object') {
      out.push({ __typename: 'Label', name: label.name, color: label.color ?? null, description: label.description ?? null });
    }
  }
  return out;
}

function resolveField(parent: Wrapper, parentType: string, fieldName: string, args: Record<string, unknown>, ex: ExecState): unknown {
  const store = ex.store;
  switch (parentType) {
    case 'Query': {
      if (fieldName === 'viewer') return userWrapper(ex.ctx.login !== '' ? ex.ctx.login : store.viewer.login);
      if (fieldName === 'repository') {
        const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo === undefined ? null : repoWrapper(repo);
      }
      if (fieldName === 'node') {
        const id = args.id;
        const decoded = decodeGlobalId(id);
        if (decoded !== null) {
          if (decoded.kind === 'repo') {
            const repo = store.getRepo(decoded.owner, decoded.repo);
            return repo === undefined ? null : repoWrapper(repo);
          }
          if (decoded.kind === 'issue') {
            const found = findIssueByGlobalId(store, id);
            return found === undefined ? null : issueWrapper(found.repo, found.issue);
          }
          if (decoded.kind === 'pull') {
            const found = findPullByGlobalId(store, id);
            return found === undefined ? null : pullWrapper(found.repo, found.pull);
          }
          if (decoded.kind === 'user') return userWrapper(decoded.owner);
        }
        // Scan fallback for ids minted in another form.
        const repo = findRepoByGlobalId(store, id);
        if (repo !== undefined) return repoWrapper(repo);
        const issue = findIssueByGlobalId(store, id);
        if (issue !== undefined) return issueWrapper(issue.repo, issue.issue);
        const pull = findPullByGlobalId(store, id);
        if (pull !== undefined) return pullWrapper(pull.repo, pull.pull);
        return null;
      }
      if (fieldName === '__type') {
        const name = String(args.name ?? '');
        if (!(name in TYPE_KIND) && !(name in ENUM_VALUES)) return null;
        return { __typename: '__Type', typeName: name };
      }
      if (fieldName === '__schema') return { __typename: '__Schema' };
      return null;
    }
    case 'Mutation': {
      return resolveMutation(fieldName, args, ex);
    }
    case 'Node': {
      return parent.id ?? null;
    }
    case 'User': {
      if (fieldName === 'login') return parent.login ?? null;
      if (fieldName === 'id') return userGlobalId(String(parent.login ?? ''));
      if (fieldName === 'name') return parent.name ?? null;
      if (fieldName === 'avatarUrl') return null;
      return null;
    }
    case 'Repository': {
      const repo = parent.repo as Repo;
      switch (fieldName) {
        case 'id': return repoGlobalId(repo);
        case 'databaseId': return numericDbId(repo);
        case 'name': return repo.name;
        case 'nameWithOwner': return repo.full_name;
        case 'owner': return userWrapper(repo.owner.login);
        case 'defaultBranchRef': return { __typename: 'Ref', name: repo.default_branch };
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return repo.has_issues !== false;
        case 'description': return repo.description ?? null;
        case 'url': return repo.html_url ?? null;
        case 'issue': {
          const issue = store.getIssue(repo, Number(args.number));
          return issue === undefined ? null : issueWrapper(repo, issue);
        }
        case 'issues': return issuesConnection(store, repo, args);
        case 'pullRequest': {
          const pull = store.getPull(repo, Number(args.number));
          return pull === undefined ? null : pullWrapper(repo, pull);
        }
        case 'pullRequests': return pullsConnection(store, repo, args);
        default: return null;
      }
    }
    case 'Ref': {
      if (fieldName === 'name') return parent.name ?? null;
      if (fieldName === 'id') return b64uEncode(`ref:${String(parent.name ?? '')}`);
      if (fieldName === 'prefix') return 'refs/heads/';
      return null;
    }
    case 'Issue': {
      const repo = parent.repo as Repo;
      const issue = parent.issue as Issue;
      switch (fieldName) {
        case 'id': return issueGlobalId(repo, issue);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'state': return upperState(issue.state);
        case 'body': return issue.body ?? '';
        case 'labels': return labelWrappers(issue);
        case 'author': case 'user': return userWrapper(issue.user?.login ?? ex.ctx.login);
        case 'createdAt': return issue.created_at ?? null;
        case 'updatedAt': return issue.updated_at ?? null;
        case 'closedAt': return issue.closed_at ?? null;
        case 'url': return issue.html_url ?? null;
        case 'comments': {
          const comments = store.listComments(repo, issue.number);
          return {
            __typename: 'IssueCommentConnection',
            nodes: comments.map((c) => ({ __typename: 'IssueComment', id: commentGlobalId(repo, issue.number, c.id), body: c.body, authorLogin: c.user?.login ?? ex.ctx.login, createdAt: c.created_at ?? issue.created_at })),
            totalCount: comments.length,
            pageInfo: pageInfoOf(comments.length, comments.length, false, null, null),
          };
        }
        default: return null;
      }
    }
    case 'Label': {
      if (fieldName === 'name') return parent.name ?? null;
      if (fieldName === 'color') return parent.color ?? null;
      if (fieldName === 'description') return parent.description ?? null;
      if (fieldName === 'id') return b64uEncode(`label:${String(parent.name ?? '')}`);
      return null;
    }
    case 'IssueConnection': case 'IssueCommentConnection':
    case 'PullRequestConnection': case 'PullRequestChangedFileConnection': {
      if (fieldName === 'nodes') return (parent.nodes as unknown[]) ?? [];
      if (fieldName === 'totalCount') return parent.totalCount ?? 0;
      if (fieldName === 'pageInfo') {
        const p = parent.pageInfo as PageInfoValue;
        return { __typename: 'PageInfo', hasNextPage: p.hasNextPage, hasPreviousPage: p.hasPreviousPage, startCursor: p.startCursor, endCursor: p.endCursor };
      }
      return null;
    }
    case 'PageInfo': {
      return parent[fieldName] ?? null;
    }
    case 'IssueComment': {
      if (fieldName === 'id') return parent.id ?? null;
      if (fieldName === 'body') return parent.body ?? null;
      if (fieldName === 'author') return userWrapper(String(parent.authorLogin ?? ex.ctx.login));
      if (fieldName === 'createdAt') return parent.createdAt ?? null;
      if (fieldName === 'updatedAt') return parent.updatedAt ?? parent.createdAt ?? null;
      return null;
    }
    case 'IssueCommentEdge': {
      if (fieldName === 'node') return parent.node ?? null;
      if (fieldName === 'cursor') return parent.cursor ?? null;
      return null;
    }
    case 'PullRequest': {
      const repo = parent.repo as Repo;
      const pull = parent.pull as Pull;
      switch (fieldName) {
        case 'id': return pullGlobalId(repo, pull);
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body ?? '';
        case 'state': return pull.merged ? 'MERGED' : upperState(pull.state);
        case 'merged': return pull.merged === true;
        case 'headRefName': return pull.head?.ref ?? null;
        case 'baseRefName': return pull.base?.ref ?? null;
        case 'mergeable': return mergeableOf(pull);
        case 'author': case 'user': return userWrapper(pull.user?.login ?? ex.ctx.login);
        case 'createdAt': return pull.created_at ?? null;
        case 'updatedAt': return pull.updated_at ?? null;
        case 'closedAt': return pull.closed_at ?? null;
        case 'mergedAt': return pull.merged_at ?? null;
        case 'url': return pull.html_url ?? null;
        case 'files': {
          const raw = store.pullFiles(repo, pull.number);
          // PullFile carries `filename` (+ additions/deletions), not `path`.
          const files: Array<{ path: string; additions: number; deletions: number }> = [];
          for (const entry of raw ?? []) {
            if (typeof entry === 'string') files.push({ path: entry, additions: 0, deletions: 0 });
            else if (entry !== null && typeof entry === 'object') {
              const name = typeof (entry as { filename?: unknown }).filename === 'string'
                ? (entry as { filename: string }).filename
                : (entry as { path?: unknown }).path;
              if (typeof name === 'string') {
                files.push({
                  path: name,
                  additions: typeof (entry as { additions?: unknown }).additions === 'number' ? (entry as { additions: number }).additions : 0,
                  deletions: typeof (entry as { deletions?: unknown }).deletions === 'number' ? (entry as { deletions: number }).deletions : 0,
                });
              }
            }
          }
          const first = typeof args.first === 'number' ? args.first : files.length;
          const page = files.slice(0, Math.max(0, first));
          return {
            __typename: 'PullRequestChangedFileConnection',
            nodes: page.map((f) => ({ __typename: 'PullRequestChangedFile', path: f.path, additions: f.additions, deletions: f.deletions })),
            totalCount: files.length,
            pageInfo: pageInfoOf(files.length, page.length, false, null, null),
          };
        }
        default: return null;
      }
    }
    case 'PullRequestChangedFile': {
      if (fieldName === 'path') return parent.path ?? null;
      if (fieldName === 'additions') return parent.additions ?? 0;
      if (fieldName === 'deletions') return parent.deletions ?? 0;
      return null;
    }
    case 'CreateIssuePayload': case 'CloseIssuePayload': {
      if (fieldName === 'issue') return parent.issue ?? null;
      if (fieldName === 'clientMutationId') return parent.clientMutationId ?? null;
      return null;
    }
    case 'CreatePullRequestPayload': case 'MergePullRequestPayload': {
      if (fieldName === 'pullRequest') return parent.pullRequest ?? null;
      if (fieldName === 'clientMutationId') return parent.clientMutationId ?? null;
      return null;
    }
    case 'AddCommentPayload': {
      if (fieldName === 'commentEdge') return parent.commentEdge ?? null;
      if (fieldName === 'subject') return parent.subject ?? null;
      if (fieldName === 'clientMutationId') return parent.clientMutationId ?? null;
      return null;
    }
    case '__Schema': {
      if (fieldName === 'queryType') return { __typename: '__Type', typeName: 'Query' };
      if (fieldName === 'mutationType') return { __typename: '__Type', typeName: 'Mutation' };
      if (fieldName === 'subscriptionType') return null;
      if (fieldName === 'types') return schemaTypesList();
      if (fieldName === 'directives') return [];
      return null;
    }
    case '__Type': {
      if (parent.typeRef !== undefined) return resolveTypeRefWrapper(parent, fieldName);
      const typeName = String(parent.typeName ?? '');
      switch (fieldName) {
        case 'name': return typeName;
        case 'kind': return TYPE_KIND[typeName] ?? 'OBJECT';
        case 'description': return null;
        case 'fields': return TYPE_KIND[typeName] === 'OBJECT' || TYPE_KIND[typeName] === 'INTERFACE' ? typeFieldsList(typeName) : null;
        case 'enumValues': return TYPE_KIND[typeName] === 'ENUM' ? typeEnumValuesList(typeName) : null;
        case 'inputFields': return null;
        case 'interfaces': return [];
        case 'possibleTypes': return typeName === 'Node' ? [{ __typename: '__Type', typeName: 'Repository' }] : null;
        case 'ofType': return null;
        default: return null;
      }
    }
    case '__Field': {
      if (fieldName === 'name') return parent.name ?? null;
      if (fieldName === 'description') return parent.description ?? null;
      if (fieldName === 'args') return parent.args ?? [];
      if (fieldName === 'type') {
        const t = parent.type as Record<string, unknown> | undefined;
        return t === undefined ? null : { __typename: '__Type', typeRef: t };
      }
      if (fieldName === 'isDeprecated') return parent.isDeprecated ?? false;
      if (fieldName === 'deprecationReason') return parent.deprecationReason ?? null;
      return null;
    }
    case '__InputValue': {
      if (fieldName === 'name') return parent.name ?? null;
      if (fieldName === 'description') return parent.description ?? null;
      if (fieldName === 'type') {
        const t = parent.type as Record<string, unknown> | undefined;
        return t === undefined ? null : { __typename: '__Type', typeRef: t };
      }
      if (fieldName === 'defaultValue') return parent.defaultValue ?? null;
      return null;
    }
    case '__EnumValue': {
      if (fieldName === 'name') return parent.name ?? null;
      if (fieldName === 'description') return parent.description ?? null;
      if (fieldName === 'isDeprecated') return parent.isDeprecated ?? false;
      if (fieldName === 'deprecationReason') return parent.deprecationReason ?? null;
      return null;
    }
    case '__Directive': {
      if (fieldName === 'name') return parent.name ?? null;
      if (fieldName === 'description') return parent.description ?? null;
      if (fieldName === 'locations') return parent.locations ?? [];
      if (fieldName === 'args') return parent.args ?? [];
      return null;
    }
    default:
      return null;
  }
}

// __Type's `type` sub-object is carried as a typeRef record, not a named type;
// resolve it here: the executor routes '__Type' fields through resolveField,
// so a typeRef wrapper must answer name/kind/ofType from the record.
function resolveTypeRefWrapper(parent: Wrapper, fieldName: string): unknown {
  const ref = parent.typeRef as Record<string, unknown> | undefined;
  if (ref === undefined) return null;
  if (fieldName === 'name') return ref.name ?? null;
  if (fieldName === 'kind') return ref.kind ?? null;
  if (fieldName === 'description') return null;
  if (fieldName === 'ofType') {
    const inner = ref.ofType as Record<string, unknown> | undefined;
    return inner === undefined || inner === null ? null : { __typename: '__Type', typeRef: inner };
  }
  if (fieldName === 'fields' || fieldName === 'enumValues' || fieldName === 'inputFields') return null;
  if (fieldName === 'interfaces' || fieldName === 'possibleTypes') return [];
  return null;
}

function issuesConnection(store: Store, repo: Repo, args: Record<string, unknown>): Wrapper {
  let all = store.listIssues(repo, {});
  const states = Array.isArray(args.states) ? (args.states as unknown[]).map((s) => String(s).toUpperCase()) : [];
  if (states.length > 0) {
    all = all.filter((issue) => states.includes(upperState(issue.state)));
  }
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const direction = String(orderBy.direction ?? 'ASC').toUpperCase() === 'DESC' ? -1 : 1;
  // CREATED_AT order == creation order == number order (ties by number).
  const sorted = [...all].sort((a, b) => (a.number - b.number) * direction);
  const after = cursorDecode(args.after);
  let rest = sorted;
  let hasPrev = false;
  if (after !== null) {
    hasPrev = true;
    rest = direction === 1 ? sorted.filter((i) => i.number > after) : sorted.filter((i) => i.number < after);
  }
  const first = typeof args.first === 'number' ? Math.max(0, args.first) : rest.length;
  const page = rest.slice(0, first);
  const last = page.length > 0 ? page[page.length - 1] as Issue : null;
  const firstNode = page.length > 0 ? page[0] as Issue : null;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue) => issueWrapper(repo, issue)),
    totalCount: all.length,
    pageInfo: pageInfoOf(rest.length, page.length, hasPrev, last === null ? null : cursorEncode(last.number), firstNode === null ? null : cursorEncode(firstNode.number)),
  };
}

function pullsConnection(store: Store, repo: Repo, args: Record<string, unknown>): Wrapper {
  let all = store.listPulls(repo, {});
  const states = Array.isArray(args.states) ? (args.states as unknown[]).map((s) => String(s).toUpperCase()) : [];
  if (states.length > 0) {
    all = all.filter((pull) => states.includes(pull.merged ? 'MERGED' : upperState(pull.state)));
  }
  const sorted = [...all].sort((a, b) => b.number - a.number);
  const after = cursorDecode(args.after);
  let rest = sorted;
  let hasPrev = false;
  if (after !== null) {
    hasPrev = true;
    rest = sorted.filter((p) => p.number < after);
  }
  const first = typeof args.first === 'number' ? Math.max(0, args.first) : rest.length;
  const page = rest.slice(0, first);
  const last = page.length > 0 ? page[page.length - 1] as Pull : null;
  const firstNode = page.length > 0 ? page[0] as Pull : null;
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((pull) => pullWrapper(repo, pull)),
    totalCount: all.length,
    pageInfo: pageInfoOf(rest.length, page.length, hasPrev, last === null ? null : cursorEncode(last.number), firstNode === null ? null : cursorEncode(firstNode.number)),
  };
}

// ---------------------------------------------------------------------------
// Mutations.
// ---------------------------------------------------------------------------

function isErrorResult(value: unknown): value is { error: string } {
  return value !== null && typeof value === 'object' && typeof (value as { error?: unknown }).error === 'string';
}

function resolveMutation(fieldName: string, args: Record<string, unknown>, ex: ExecState): unknown {
  const store = ex.store;
  const input = (args.input ?? {}) as Record<string, unknown>;
  switch (fieldName) {
    case 'createIssue': {
      const repo = findRepoByGlobalId(store, input.repositoryId);
      if (repo === undefined) {
        ex.errors.push({ message: `Repository not found for id ${String(input.repositoryId ?? '')}.` });
        return null;
      }
      const title = String(input.title ?? '');
      if (title === '') {
        ex.errors.push({ message: 'createIssue input.title must not be empty.' });
        return null;
      }
      const created = store.createIssue(repo, { title, body: typeof input.body === 'string' ? input.body : '' });
      if (isErrorResult(created)) {
        ex.errors.push({ message: `createIssue failed: unknown label "${created.label}".` });
        return null;
      }
      return { __typename: 'CreateIssuePayload', issue: issueWrapper(repo, created) };
    }
    case 'closeIssue': {
      const found = findIssueByGlobalId(store, input.issueId);
      if (found === undefined) {
        ex.errors.push({ message: `Issue not found for id ${String(input.issueId ?? '')}.` });
        return null;
      }
      store.updateIssue(found.repo, found.issue.number, { state: 'closed' });
      const issue = store.getIssue(found.repo, found.issue.number);
      if (issue === undefined) {
        ex.errors.push({ message: `Issue #${found.issue.number} could not be read after closing.` });
        return null;
      }
      return { __typename: 'CloseIssuePayload', issue: issueWrapper(found.repo, issue) };
    }
    case 'createPullRequest': {
      const repo = findRepoByGlobalId(store, input.repositoryId);
      if (repo === undefined) {
        ex.errors.push({ message: `Repository not found for id ${String(input.repositoryId ?? '')}.` });
        return null;
      }
      const created = store.createPull(repo, {
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
        head: String(input.headRefName ?? ''),
        base: String(input.baseRefName ?? ''),
      });
      if (isErrorResult(created)) {
        ex.errors.push({
          message: created.error === 'head'
            ? `createPullRequest failed: head branch "${String(input.headRefName ?? '')}" does not exist.`
            : `createPullRequest failed: base branch "${String(input.baseRefName ?? '')}" does not exist.`,
        });
        return null;
      }
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullWrapper(repo, created) };
    }
    case 'mergePullRequest': {
      const found = findPullByGlobalId(store, input.pullRequestId);
      if (found === undefined) {
        ex.errors.push({ message: `Pull request not found for id ${String(input.pullRequestId ?? '')}.` });
        return null;
      }
      const method = String(input.mergeMethod ?? 'MERGE').toLowerCase();
      const merged = store.mergePull(found.repo, found.pull.number, method === 'squash' ? 'squash' : method === 'rebase' ? 'rebase' : 'merge');
      if (isErrorResult(merged)) {
        ex.errors.push({
          message: merged.error === 'not-found'
            ? `mergePullRequest failed: pull request #${found.pull.number} does not exist.`
            : `mergePullRequest failed: pull request #${found.pull.number} has a merge conflict.`,
        });
        return null;
      }
      const pull = store.getPull(found.repo, found.pull.number);
      if (pull === undefined) {
        ex.errors.push({ message: `Pull request #${found.pull.number} could not be read after merging.` });
        return null;
      }
      return { __typename: 'MergePullRequestPayload', pullRequest: pullWrapper(found.repo, pull) };
    }
    case 'addComment': {
      const found = findIssueByGlobalId(store, input.subjectId);
      if (found === undefined) {
        ex.errors.push({ message: `Issue not found for subject id ${String(input.subjectId ?? '')}.` });
        return null;
      }
      const body = String(input.body ?? '');
      const comment = store.addComment(found.repo, found.issue.number, body);
      let commentId: number | undefined = comment?.id;
      if (commentId === undefined) {
        const comments = store.listComments(found.repo, found.issue.number);
        const last = comments[comments.length - 1];
        commentId = last?.id;
      }
      if (commentId === undefined) {
        ex.errors.push({ message: `addComment failed: no comment was recorded on issue #${found.issue.number}.` });
        return null;
      }
      return {
        __typename: 'AddCommentPayload',
        subject: issueWrapper(found.repo, found.issue),
        commentEdge: {
          __typename: 'IssueCommentEdge',
          cursor: cursorEncode(commentId),
          node: {
            __typename: 'IssueComment',
            id: commentGlobalId(found.repo, found.issue.number, commentId),
            body,
            authorLogin: ex.ctx.login,
            createdAt: store.nowIso(),
          },
        },
      };
    }
    default:
      ex.errors.push({ message: `Unknown mutation "${fieldName}".` });
      return null;
  }
}

// ---------------------------------------------------------------------------
// One operation -> {data, errors?}; one HTTP body -> one Resp.
// ---------------------------------------------------------------------------

function executeOperation(ctx: Ctx, doc: DocumentNode, op: OperationNode, variables: Record<string, unknown>): { data: Record<string, unknown> | null; errors?: GqlError[] } {
  const ex: ExecState = { store: ctx.store, ctx, variables, fragments: doc.fragments, errors: [] };
  const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
  const root: Wrapper = { __typename: rootType };
  const data = executeSelections(root, rootType, op.selections, [], ex);
  if (ex.errors.length > 0) return { data, errors: ex.errors };
  return { data };
}

function runOneOperation(ctx: Ctx, body: unknown): { data: Record<string, unknown> | null; errors?: GqlError[] } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { data: null, errors: [{ message: 'GraphQL request body must be a JSON object with a query string.' }] };
  }
  const record = body as Record<string, unknown>;
  const query = record.query;
  if (typeof query !== 'string' || query.trim() === '') {
    return { data: null, errors: [{ message: 'GraphQL request body must include a query string.' }] };
  }
  const variables = (record.variables ?? {}) as Record<string, unknown>;
  if (variables === null || typeof variables !== 'object' || Array.isArray(variables)) {
    return { data: null, errors: [{ message: 'GraphQL variables must be a JSON object.' }] };
  }
  let doc: DocumentNode;
  try {
    doc = parseDocument(query);
  } catch (err) {
    return { data: null, errors: [{ message: `GraphQL syntax error: ${err instanceof Error ? err.message : String(err)}` }] };
  }
  if (doc.operations.length === 0) {
    return { data: null, errors: [{ message: 'GraphQL document contains no operation.' }] };
  }
  let op: OperationNode | undefined;
  const operationName = record.operationName;
  if (typeof operationName === 'string' && operationName !== '') {
    op = doc.operations.find((o) => o.name === operationName);
    if (op === undefined) return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
  } else {
    op = doc.operations[0];
  }
  return executeOperation(ctx, doc, op, variables);
}

function jsonResp(ctx: Ctx, status: number, body: unknown): Resp {
  return {
    status,
    headers: {
      'content-type': 'application/json',
      'x-github-request-id': ctx.requestId !== '' ? ctx.requestId : 'graphql-1',
    },
    body: JSON.stringify(body),
  };
}

async function graphqlHandler(ctx: Ctx): Promise<Resp | null> {
  if (ctx.method !== 'POST') return null;
  if (ctx.path !== GRAPHQL_PATH && ctx.path !== `${GRAPHQL_PATH}/`) return null;
  if (!ctx.authed) {
    return jsonResp(ctx, 401, { message: 'Requires authentication' });
  }
  if (!ctx.jsonValid) {
    return jsonResp(ctx, 400, { message: 'Malformed JSON body' });
  }
  const body = ctx.json;
  if (Array.isArray(body)) {
    // GitHub operation batching: one result per operation, in order.
    const results = body.map((entry) => runOneOperation(ctx, entry));
    return jsonResp(ctx, 200, results);
  }
  return jsonResp(ctx, 200, runOneOperation(ctx, body));
}

export const graphqlHandlers: Handler[] = [graphqlHandler];
