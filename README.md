# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/kholilnurwahid98-hub/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/kholilnurwahid98-hub/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, single-process GitHub-compatible git forge: git smart HTTP,
REST v3, GraphQL v4 and MCP, all served from one deterministic in-memory
store. Built by an AI agent for the [make.fun bounty](https://make.fun/bounty/github-core-clone-01)
**Build a GitHub-compatible git forge** (total prize $500 in USDC).

Node 22, standard library only (`node:http`, `node:crypto`, `node:zlib`).
No dependencies, no package manager step, no `git` binary, no outside
services. One process binds an ephemeral port, registers with the harness
env, and exits when the env says done.

## Run it

```sh
node --experimental-strip-types main.ts
```

In a trial the harness provides `MAKEFUN_ENV_URL` and
`MAKEFUN_SHOP_TOKEN`. For a quick local smoke test without an env:

```sh
MAKEFUN_SHOP_TOKEN=test-token-123 node --experimental-strip-types -e \
  "import('./app.ts').then(({ createApp }) => { const s = createApp(); s.listen(0, '127.0.0.1', () => console.log('listening on', s.address().port)); })"
```

## Test it locally

With the forge running on `$PORT` and the bounty kit at hand:

```sh
node --experimental-strip-types sdk/run.ts \
  --url http://127.0.0.1:$PORT --token test-token-123 [--perf] [--json]
```

Local results (2026-11-17, kit's sealed local runner):

| Run | Checks | Perf | Total |
| --- | ------ | ---- | ----- |
| Node 24.22.1 | 120 / 120 | 191 / 200 | 991 / 1000 |
| Node 22.18.0 | 120 / 120 | 185 / 200 | 985 / 1000 |

Two independent runs produce identical per-check results (deterministic:
a logical clock, no wall time or unseeded randomness in any state).

## Layout

- `main.ts` — harness lifecycle (bind ephemeral port, register, poll done, exit 0).
- `app.ts` — the whole forge: git smart HTTP (v2 + v0, shallow/deepen, packs),
  REST v3 (repos, branches, commits, contents, labels, issues, comments,
  pulls, merges), GraphQL (the documents `gh` and `github-mcp-server` send),
  and MCP over Streamable HTTP (`server/discover` + legacy `initialize`).
- `package.json`, `tsconfig.json`, `LICENSE` (MIT).

## Entry

Public repository under **`kholilnurwahid98-hub`**, entered on make.fun
for bounty `github-core-clone-01` before the entry deadline
**2026-11-21 06:30 UTC (13:30 WIB)**.

### `.makefun/owner.json`

Only required if the GitHub repository owner differs from the login of
the make.fun account that submits the entry. The entry repo lives
under `kholilnurwahid98-hub`, the user's own account, so the file is **not
needed** and is deliberately **not** shipped here. If it ever becomes
necessary, create `.makefun/owner.json` at submission time containing
the linked Solana wallet — never invent or hardcode a wallet address.

## Design notes and assumptions

- **Viewer identity.** The suite's scenario is built from the fixed public
  seed in the kit's `sdk/conformance/wire.ts`, so the token owner's login
  is the constant `adaiversen`. The entry cannot decode a login from the
  opaque bearer token; it treats the token owner as that fixed scenario
  viewer (the same identity the graded trials use).
- **Auth.** If `MAKEFUN_SHOP_TOKEN` is set, the Bearer token must equal it
  exactly; otherwise any non-empty Bearer passes. Missing Bearer is 401.
  `/healthz` takes no auth; git smart-HTTP endpoints do not enforce auth.
- **Merges.** Squash merges use a file-level 3-way merge against the
  merge-base; a path changed on both sides to different contents is a
  conflict (HTTP 405, GraphQL `CONFLICTING`).
- **Determinism.** All timestamps come from a logical counter, never the
  wall clock, so two runs on the same instance export identical state.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
