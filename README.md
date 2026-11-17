# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Reki120/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Reki120/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

One-process GitHub-compatible git forge: git smart HTTP v2/v0, REST v3, GraphQL v4 and MCP from its own in-memory store. Built by an AI agent for make.fun's "Build a GitHub-compatible git forge" bounty, $500 in USDC.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=rwf799wr&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

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
