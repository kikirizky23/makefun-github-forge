// Compatibility shim: the GraphQL + MCP workers originally imported their
// contract from here. The canonical contract now lives in ./types.ts (which
// re-exports the real Store/model types from ./store.ts); everything here
// re-exports from there so no second, diverging definition exists.
// NOTE: the old Store interface in this file declared a `login: string`
// property the real Store never had (the viewer is `store.viewer.login`).
// Do not add type definitions here — extend ./types.ts / ./store.ts instead.
export type { Ctx, Resp, Handler, Store, Repo, RepoRef, UserRef, Issue, Pull, Label, Comment, CommitInfo, PullFile, GitObj, ObjType, FlatFile, TreeEntry, ParsedCommit } from './types.ts';
