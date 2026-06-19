# Contributing

`@avatarsd-llc/strawberry-cli` is the framework-free WS+protobuf client for the Strawberry
(Gorshok-v4) grow controller, consumed four ways from one artifact: a library, the `strawberry`
CLI, a Claude Code agent skill, and the docs. See [`library.md`](./library.md),
[`cli.md`](./cli.md), and [`protocol.md`](./protocol.md) before changing wire-facing code.

## Prerequisites

- Node **22+** (the built-in global `WebSocket` is used; on older Node the optional `ws` peer
  dependency is needed for the Node transport).
- `npm install`.

## Layout

| Path | What |
|------|------|
| `src/core/` | `DeviceClient`, `PushBus`, codec/token seams |
| `src/wire/` | transport seam + WS implementations + frame framing |
| `src/auth/` | pure-JS SEC-001 HMAC |
| `src/api/commands.ts` | typed 1:1-with-proto command builders |
| `src/cli/` | the `strawberry` CLI (`index.ts` dispatch + `commands/*.ts`) |
| `src/proto/` | **generated** protobuf-ts codec (gitignored; see below) |
| `proto/messages.proto` | **vendored** schema (the source of truth for the codec) |
| `test/` | vitest unit + protocol-matrix tests |
| `sil/` | software-in-the-loop: a protocol-faithful mock board + runner |
| `scripts/` | `gen-proto.mjs`, `check-purity.mjs`, `hil-matrix.mjs` |
| `skill/` | Claude Code agent skills that drive the CLI |
| `docs/` | this reference set |

## The protobuf codec is generated — never edit it

`src/proto/messages.ts` is **generated** from `proto/messages.proto` and is gitignored. Do not
edit it by hand; regenerate it:

```bash
npm run proto
```

`scripts/gen-proto.mjs` runs `protoc` with the protobuf-ts plugin and the options
`long_type_string,client_none,server_none` — **byte-identical to the firmware web-ui's
generator**, so the SPA and this library share the same codec.

### The proto is vendored from strawberry-fw

`proto/messages.proto` is vendored from the firmware repo (`components/proto/messages.proto`),
which is the schema's single source of truth. This package is embedded in `strawberry-fw` as a
git submodule at `packages/device-client`, so:

- In the firmware tree, point the generator at the in-tree proto:
  `PROTO_DIR=../../components/proto npm run proto` (the `PROTO_DIR` env var overrides the default
  `./proto`).
- In the standalone repo, the generator defaults to the vendored `./proto`.
- When the schema changes in `strawberry-fw`, re-vendor `proto/messages.proto`, run
  `npm run proto`, and rebuild. The protocol counts in [`protocol.md`](./protocol.md) are codec
  truth — if a count moves, update that doc too.

## Build, test, gate

```bash
npm run build         # tsup -> dist/ (ESM .mjs + CJS .cjs + .d.ts), three subpaths
npm test              # vitest run (unit + protocol matrix)
npm run lint:purity   # asserts no @angular/* or rxjs leak into the library
```

`npm run build` runs `tsup`; the codec must be generated first (`npm run proto`) or the build
fails on the missing `src/proto/messages.ts`. The purity gate keeps the library framework-free —
it is the invariant that lets the same code run in the SPA and in Node.

## Test tiers — unit, SIL, HIL

Three layers validate the client; they are designed to agree row-for-row.

### 1. Unit (vitest) — `npm test`

Mock-based tests in `test/`: the HMAC vector (against the pinned cross-impl value), wire
framing round-trips, codec round-trips, CLI arg parsing, `wg-conf` parsing, and a protocol
matrix (`test/ws-protocol-matrix.test.ts`) asserting the codec surface counts (64 commands / 38
server / 17 queries / 13 topics). These run with no network and no hardware.

> Lesson from HIL: 100% line coverage of mock tests still misses **firmware-reality mismatches**
> (socket-bound tokens, push-only stats). Unit coverage is necessary, not sufficient — the SIL
> and HIL tiers exist to catch what mocks cannot.

### 2. SIL (software-in-the-loop) — `npm run sil`

```bash
npm run sil            # builds, boots the mock board on an ephemeral loopback port, drives the CLI
npm run sil:mock       # just boot the mock board (sil/mock-board.mjs)
npm run sil:docker     # run the mock in a container, drive the CLI against it
```

`sil/mock-board.mjs` is a protocol-faithful stand-in for the firmware WS backend: it speaks the
same 1-byte framing, the canonical protobuf codec (imported from the built `dist/` so it agrees
byte-for-byte), and **deliberately reproduces the documented firmware quirks** so SIL
expectations match HIL row-for-row:

- `query stats` -> "unknown query" (push-only on the firmware).
- `auth resume` on a new connection -> rejected (tokens are socket-bound).
- `grow io-add` to an inactive unit -> `ERR_NOT_FOUND`; to an active unit -> ok.

`sil/run-sil.mjs` drives the real CLI binary against the mock under a sandboxed `HOME` (so the
per-host `FileTokenStore` can't leak between runs) and asserts one row per command. Exit `0` iff
every row meets its expectation. This is the host-runnable twin of the HIL matrix and runs in CI.

### 3. HIL (hardware-in-the-loop) — `scripts/hil-matrix.mjs`

```bash
node scripts/hil-matrix.mjs --host 10.5.60.177 --password-file ./board.pass
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
  globals in `src/core`, `src/wire/transport.ts`, `src/auth`, or `src/api`. Node-only code lives
  behind the `./node` subpath; browser-only behind structural `*Like` interfaces. The purity gate
  enforces this.
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
5. If the codec surface counts changed, [`protocol.md`](./protocol.md) is updated to match.
