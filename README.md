# github-core-clone

A standalone GitHub-compatible git forge in TypeScript, using only the Node
standard library. One process, one in-memory store, four surfaces:

- **Git smart HTTP** at `/{owner}/{repo}.git` — upload-pack protocol v2 (with
  a v0 fallback) and receive-pack v0, with shallow fetch, annotated-tag
  peeling and strict fast-forward pushes.
- **REST v3** at `/api/v3` — repositories, branches, commits, contents,
  labels, issues, comments and pull requests with squash merge and 3-way
  conflict detection.
- **GraphQL v4** at `/api/graphql` — a dependency-free parser and executor
  with fragments, aliases, variables, batched documents, cursor pagination
  and introspection.
- **MCP** at `/mcp` — JSON-RPC 2.0 over Streamable HTTP, revision 2026-07-28
  with the legacy initialize handshake, six tools.

## Run

```sh
MAKEFUN_SHOP_TOKEN=<token> node main.ts
```

The server binds an ephemeral port on 127.0.0.1. When `MAKEFUN_ENV_URL` is
set, it registers its port with the harness, waits for the trial to finish,
then exits 0. Without it, the server stays up for local checks.

`GET /healthz` answers `{"ok": true}`.

## Determinism

Every timestamp comes from `MAKEFUN_TRIAL_NOW` and every ordering counter is
a plain increment. No wall clock, no unseeded randomness, so a replayed trial
produces byte-identical results.
