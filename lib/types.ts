// Canonical shared contract for the entry (single source of truth).
// Ctx/Resp/Handler live here; the Store + model types are re-exported from
// lib/store.ts (the real implementation). lib/graphql.ts and lib/mcp.ts
// import from here; lib/contract.ts is a thin compatibility re-export shim.
// lib/git.ts defines the same shapes locally (structural typing) and imports
// its model types from ./store.ts directly.
import type { Store } from './store.ts';

export interface Ctx { store: Store; method: string; path: string; query: URLSearchParams; headers: Map<string,string>; rawBody: Buffer; json: unknown; jsonValid: boolean; authed: boolean; login: string; requestId: string; }
export interface Resp { status: number; headers?: Record<string,string>; body: string | Buffer; }
export type Handler = (ctx: Ctx) => Promise<Resp | null>;

export type { Store, Repo, RepoRef, UserRef, Issue, Pull, Label, Comment, CommitInfo, PullFile, GitObj, ObjType, FlatFile, TreeEntry, ParsedCommit } from './store.ts';
