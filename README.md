# github-core-clone

[![make.fun](https://make.fun/badge/Orchdhaaa/github-core-clone)](https://make.fun/bounty/github-core-clone-01)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A standalone, GitHub-compatible git forge in one Node process. No database, no
UI, no git binary, no npm dependencies: just the standard library. It serves
the four surfaces agents already speak, from its own in-memory store:

- **Git smart HTTP** — upload-pack protocol v2 and v0, receive-pack v0, with
  exact-set and shallow fetch, annotated-tag peeling, and fast-forward-only
  pushes with per-ref report-status.
- **REST v3** — repositories, branches, commits, contents, labels, issues,
  comments and pull requests, including squash merge with 3-way conflict
  detection, under `/api/v3`.
- **GraphQL v4** — a dependency-free parser and executor at `/api/graphql`,
  with fragments, aliases, variables, batch documents, cursor pagination and
  introspection.
- **MCP** — JSON-RPC 2.0 at `/mcp`, revision 2026-07-28 (`server/discover`)
  and the handshake revisions through `initialize`, exposing six tools
  (`create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`).

## Run it

```sh
node main.ts
```

With `MAKEFUN_ENV_URL` set (a trial pod) the server binds an ephemeral port,
registers it with the suite, and exits 0 when the suite answers `/done`.
Without it (local development) it listens on `$PORT` (or an ephemeral port)
and keeps serving; set `MAKEFUN_SHOP_TOKEN` to the bearer token the suite
presents.

## Determinism

No wall clock and no unseeded randomness reach any observable output.
Timestamps come from `MAKEFUN_TRIAL_NOW` plus a counter clock, ids and
request ids from counters, so two runs of the same request sequence produce
byte-identical output and a replay matches its live pass.

## Layout

- `main.ts` — entrypoint: bind, register, long-poll `/done`, exit 0.
- `app.ts` — HTTP server, routing, auth, request ids.
- `store.ts` — in-memory store, deterministic clock, git object operations.
- `gitpack.ts` — pkt-lines and packfiles (build, parse, deltas).
- `gitproto.ts` — upload-pack v0/v2, receive-pack v0, advertisements.
- `rest.ts` — REST v3 handlers and serializers.
- `graphql.ts` — GraphQL parser, executor and introspection.
- `mcp.ts` — MCP tools over the same store.

## License

MIT. See [LICENSE](LICENSE).
