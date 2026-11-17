# git-forge — a standalone GitHub-compatible git forge

One process (Node 22, standard library only) serving git smart HTTP v2, the REST v3
API, GraphQL v4 and MCP from its own in-memory store. No UI, no outside service, no
git binary. Built for the make.fun bounty
[github-core-clone-01](https://make.fun/bounty/github-core-clone-01).

## Run it

```sh
node main.ts
```

The platform runs `node /bot/main.ts`: the program binds an ephemeral port, registers
it with the suite at `$MAKEFUN_ENV_URL`, serves until the suite says done, then exits 0.

## Layout

- `main.ts` — the entry <-> env lifecycle (bind, register, poll done, exit 0).
- `app.ts` — the HTTP server: routing, auth, JSON discipline.
- `store.ts` — the in-memory store: git objects, refs, repos, issues, pull requests,
  pack read/write, deterministic timestamps.
- `git.ts` — git smart HTTP: protocol v2 and v0 upload-pack, v0 receive-pack, pkt-lines,
  sideband framing, fast-forward rules.
- `rest.ts` — REST v3: repos, branches, commits, contents, labels, issues, comments,
  pull requests, merges.
- `graphql.ts` — GraphQL v4: the documents `gh` and `github-mcp-server` send, plus
  introspection, cursor pagination and batching.
- `mcp.ts` — MCP over Streamable HTTP (revision 2026-07-28, with the legacy
  initialize handshake): `server/discover`, `tools/list`, `tools/call`.

## Notes

- The token owner is the scenario viewer (`adaiversen`, from the kit's sealed
  `wire.ts`); every repository belongs to that login, another owner is a 404.
- Timestamps and commit dates come from a monotonic counter off the scenario epoch,
  never the wall clock, so two runs fed the same requests leave the same state.
- The server sends plain (undeltified) packs and accepts plain packs; the suite's
  client never sends deltas on push.
