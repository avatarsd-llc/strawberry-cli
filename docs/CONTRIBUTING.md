# Contributing

This repo is an **npm-workspaces monorepo** with two packages: the framework-free WS+protobuf
client library [`@avatarsd-llc/strawberry-client`](../packages/strawberry-client) and the `strawberry`
CLI [`@avatarsd-llc/strawberry-cli`](../packages/strawberry-cli) (plus its Claude Code agent
skills) that consumes it. See
[`../packages/strawberry-client/docs/library.md`](../packages/strawberry-client/docs/library.md),
[`../packages/strawberry-cli/docs/cli.md`](../packages/strawberry-cli/docs/cli.md), and
[`../packages/strawberry-client/docs/protocol.md`](../packages/strawberry-client/docs/protocol.md)
before changing wire-facing code.

## Prerequisites

- Node **22+** (the built-in global `WebSocket` is used; on older Node the optional `ws` peer
  dependency is needed for the Node transport).
- `npm install` at the repo root (links the workspace and installs shared devDeps).

## Layout

The monorepo root holds the private workspace `package.json` (fan-out scripts) and shared
devDeps; each package owns its own `package.json`, `tsup.config.ts`, `tsconfig.json`, and
`vitest.config.ts`.

| Path | What |
|------|------|
| `packages/strawberry-client/` | **the library** `@avatarsd-llc/strawberry-client` (v0.1.0) |
| `packages/strawberry-client/src/core/` | `DeviceClient`, `PushBus`, codec/token seams |
| `packages/strawberry-client/src/wire/` | transport seam + WS implementations + frame framing |
| `packages/strawberry-client/src/auth/` | pure-JS HMAC |
| `packages/strawberry-client/src/api/commands.ts` | typed 1:1-with-proto command builders |
| `packages/strawberry-client/src/proto/` | **generated** protobuf-ts codec (gitignored; see below) |
| `packages/strawberry-client/proto/messages.proto` | **vendored** schema (source of truth for the codec) |
| `packages/strawberry-client/scripts/` | `gen-proto.mjs`, `check-purity.mjs` |
| `packages/strawberry-client/test/` | vitest unit + protocol-matrix tests |
| `packages/strawberry-cli/` | **the CLI** `@avatarsd-llc/strawberry-cli` (v0.2.0) |
| `packages/strawberry-cli/src/cli/` | the `strawberry` CLI (`index.ts` dispatch + `commands/*.ts`); imports the library by package specifier |
| `packages/strawberry-cli/bin/` | `strawberry-cli.mjs` bin shim (imports `dist/cli.mjs`) |
| `packages/strawberry-cli/test/` | CLI args + wg-conf vitest tests |
| `packages/strawberry-cli/sil/` | software-in-the-loop: a protocol-faithful mock board + runner |
| `packages/strawberry-cli/scripts/` | `hil-matrix.mjs` |
| `packages/strawberry-cli/skill/` | Claude Code agent skills that drive the CLI |
| `docs/` | this contributing guide (`CONTRIBUTING.md`); library/protocol/cli docs live under each package's `docs/` |

## The protobuf codec is generated — never edit it

`packages/strawberry-client/src/proto/messages.ts` is **generated** from
`packages/strawberry-client/proto/messages.proto` and is gitignored. Do not edit it by hand;
regenerate it from the repo root:

```bash
npm run proto                                   # fan-out to the strawberry-client workspace
# or: npm run proto -w @avatarsd-llc/strawberry-client
```

`packages/strawberry-client/scripts/gen-proto.mjs` runs `protoc` with the protobuf-ts plugin and the options
`long_type_string,client_none,server_none` — **byte-identical to the firmware web-ui's
generator**, so the SPA and this library share the same codec.

### The proto is vendored from strawberry-fw

`proto/messages.proto` is vendored from the firmware repo (`components/proto/messages.proto`),
which is the schema's single source of truth. This package is embedded in `strawberry-fw` as a
git submodule at `packages/strawberry-client`, so:

- In the firmware tree, point the generator at the in-tree proto:
  `PROTO_DIR=../../components/proto npm run proto` (the `PROTO_DIR` env var overrides the default
  `./proto`).
- In the standalone repo, the generator defaults to the vendored `./proto`.
- When the schema changes in `strawberry-fw`, re-vendor
  `packages/strawberry-client/proto/messages.proto`, run `npm run proto`, and rebuild. The protocol
  counts in [`../packages/strawberry-client/docs/protocol.md`](../packages/strawberry-client/docs/protocol.md)
  are codec truth — if a count moves, update that doc too.

## Build, test, gate

From the repo root (workspace-aware; the library builds before the CLI):

```bash
npm run build         # build strawberry-client (4 subpaths) then strawberry-cli (dist/cli.{mjs,cjs})
npm run typecheck     # tsc --noEmit in both packages
npm test              # vitest run in both packages (unit + protocol matrix)
npm run lint:purity   # asserts no @angular/* or rxjs leak into the library (strawberry-client)
```

Per-package: append `-w @avatarsd-llc/strawberry-client` or `-w @avatarsd-llc/strawberry-cli`.
The strawberry-client build runs `tsup`; the codec must be generated first (`npm run proto`) or the
build fails on the missing `packages/strawberry-client/src/proto/messages.ts`. The CLI build resolves
`@avatarsd-llc/strawberry-client` from the workspace-linked package, so build the library first (the
root `build` script and CI already order it that way). The purity gate keeps the library
framework-free — the invariant that lets the same code run in the SPA and in Node.

## Test tiers — unit, SIL, HIL

Three layers validate the client; they are designed to agree row-for-row.

### 1. Unit (vitest) — `npm test`

Mock-based tests split across the two packages: in `packages/strawberry-client/test/` the HMAC vector
(against the pinned cross-impl value), wire framing round-trips, codec round-trips, and the
protocol matrix; in `packages/strawberry-cli/test/` the CLI arg parsing and `wg-conf` parsing. The
protocol matrix (`packages/strawberry-client/test/ws-protocol-matrix.test.ts`) asserts the codec
surface counts (64 commands / 38
server / 17 queries / 13 topics). These run with no network and no hardware.

> Lesson from HIL: 100% line coverage of mock tests still misses **firmware-reality mismatches**
> (socket-bound tokens, push-only stats). Unit coverage is necessary, not sufficient — the SIL
> and HIL tiers exist to catch what mocks cannot.

### 2. SIL (software-in-the-loop) — `npm run sil`

```bash
npm run sil            # from repo root: builds the library + CLI, boots the mock board, drives the CLI
# or, in packages/strawberry-cli:
npm run sil:mock       # just boot the mock board (sil/mock-board.mjs)
```

`packages/strawberry-cli/sil/mock-board.mjs` is a protocol-faithful stand-in for the firmware WS
backend: it speaks the same 1-byte framing, the canonical protobuf codec (imported from the built
`@avatarsd-llc/strawberry-client` sibling package so it agrees byte-for-byte), and **deliberately
reproduces the documented firmware quirks** so SIL
expectations match HIL row-for-row:

- `query stats` -> "unknown query" (push-only on the firmware).
- `auth resume` on a new connection -> rejected (tokens are socket-bound).
- `grow io-add` to an inactive unit -> `ERR_NOT_FOUND`; to an active unit -> ok.

`packages/strawberry-cli/sil/run-sil.mjs` drives the real CLI binary against the mock under a sandboxed `HOME` (so the
per-host `FileTokenStore` can't leak between runs) and asserts one row per command. Exit `0` iff
every row meets its expectation. This is the host-runnable twin of the HIL matrix and runs in CI.

### 3. HIL (hardware-in-the-loop) — `packages/strawberry-cli/scripts/hil-matrix.mjs`

```bash
node packages/strawberry-cli/scripts/hil-matrix.mjs --host 192.0.2.177 --password-file ./board.pass
```

Exercises every CLI command against a **live board**. Tiers per row:

- `READ` — safe, read-only; asserts a real reply.
- `MUTATE` — creates a throwaway unit/endpoint, verifies, then cleans up.
- `DRY` — destructive (ota/reboot/net/factory): run against an unreachable host so the command
  is proven to **parse and fail cleanly**, never execute.
- `LIMIT` — a documented firmware limitation; asserts the expected rejection.

Exit `0` iff every row meets its expectation. The HIL matrix is the source of truth for "covers
the real hardware"; the SIL run mirrors it without a board. Findings from HIL runs are catalogued
in [`../HIL-FINDINGS.md`](../HIL-FINDINGS.md) — read it before changing wire behaviour; it
documents the socket-bound-token, push-only-stats, and unit-materialization realities.

## Conventions

- **No emojis** in code, commits, or docs.
- Keep the library **framework-free** — no `@angular/*`, no `rxjs`, no DOM-only or Node-only
  globals in `packages/strawberry-client/src/core`, `.../src/wire/transport.ts`, `.../src/auth`, or
  `.../src/api`. Node-only code lives behind the `./node` subpath; browser-only behind structural
  `*Like` interfaces. The purity gate enforces this.
- The CLI must import the library by **package specifier** (`@avatarsd-llc/strawberry-client`,
  `/node`, `/proto`, `/design`) — never via a relative path that escapes
  `packages/strawberry-cli/src`.
- **Enumerate the wire surface from the codec**, never a hand-written literal list — the counts
  (64/38/17/13) are codec truth.
- Respect the seams: `DeviceClient` must not name a `WebSocket` or the protobuf runtime directly;
  go through `Transport` / `Codec` / `TokenStore`. This is what keeps a future TLV transport a
  drop-in.
- Apache-2.0; new files keep the license posture of the repo.

## Definition of done

1. `npm run proto` (if the schema moved) + `npm run build` pass.
2. `npm test` is green (including the protocol matrix).
3. `npm run lint:purity` is clean.
4. If wire behaviour changed: `npm run sil` is green, and ideally one HIL matrix pass against a
   board, with any new reality recorded in [`../HIL-FINDINGS.md`](../HIL-FINDINGS.md).
5. If the codec surface counts changed,
   [`../packages/strawberry-client/docs/protocol.md`](../packages/strawberry-client/docs/protocol.md) is
   updated to match.
