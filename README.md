# github-core-clone-01 — a GitHub-compatible git forge

A Node 22, stdlib-only GitHub-compatible forge for the
[github-core-clone-01](https://make.fun/bounty/github-core-clone-01) bounty: git smart HTTP,
REST v3, GraphQL v4 and an MCP endpoint, all backed by one in-memory store. No dependencies,
no internet, no `git` binary at run time.

## Run it

```sh
node main.ts
```

(`node --experimental-strip-types main.ts` also works on older Node 22; the platform runs
`node /bot/main.ts` on Node 22.18+.) `MAKEFUN_ENV_URL` must be set — it is the env origin the
entry registers with; without it the process exits 1 at once. API calls present
`Authorization: Bearer $MAKEFUN_SHOP_TOKEN`.

## Layout

- `main.ts` — the entry ↔ env lifecycle (bind ephemeral port → POST /register → poll GET /done
  → exit 0). Keep it as it is.
- `app.ts` — the HTTP server: one Store, body read (64 MiB cap), lenient JSON, exact bearer
  auth, `X-GitHub-Request-Id` on every reply, JSON 404 fallback, 500s that never crash the
  process. Routing order: `GET /healthz` → `GET /api/v3[/]` → git → REST → GraphQL → MCP → 404.
- `lib/types.ts` — the shared contract every handler module codes against (`Ctx`, `Resp`,
  `Handler`).
- `lib/store.ts` + `lib/git.ts` — the in-memory store and the git object/pack implementation.
- `lib/rest.ts` — REST v3 resources.
- `lib/graphql.ts` + `lib/mcp.ts` — GraphQL v4 and the MCP endpoint.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT).

## Integration contract

Each handler module exports one function taking a `Ctx` and returning a `Resp` or `null`
(`null` = "not my route, try the next group"):

| module | export |
| --- | --- |
| `lib/store.ts` | `Store` (constructible with no arguments; owns `nowIso()` — the only clock) |
| `lib/git.ts` | `handleGit: Handler` |
| `lib/rest.ts` | `handleRest: Handler` |
| `lib/graphql.ts` | `handleGraphql: Handler` |
| `lib/mcp.ts` | `handleMcp: Handler` |

`app.ts` loads them dynamically for now and falls back to the 404 while a module is missing;
once all five land, the imports become static. A handler that needs a body and finds
`jsonValid === false` answers 400 `{"message":"Invalid JSON"}` itself.

## Determinism

Replay must match byte-for-byte: no wall clock anywhere (all timestamps from
`store.nowIso()`), no `Math.random` / unseeded randomness, one order of operations.

## Smoke test

`../work/smoke.mjs` boots the server against a tiny fake env and exercises healthz, the API
root, repo/contents/issue/pull flows, git info/refs, 404s, malformed JSON and no-auth 401s.
