# strawberry — monorepo

Open-source, framework-free TypeScript tooling for the **Strawberry** (Gorshok-v4)
ESP32-C6 grow controller. This repo is an **npm-workspaces monorepo** with two
published packages:

| Package | Path | What it is |
| --- | --- | --- |
| [`@avatarsd-llc/strawberry-client`](./packages/strawberry-client) | `packages/strawberry-client` | The framework-free WebSocket + protobuf client library (`DeviceClient`, generated codec, pure-JS HMAC). Runs unchanged in a browser, in Node, and in a Pulumi provider host — no Angular, no RxJS. Consumed by the web-ui SPA, the Pulumi deploy provider, and the CLI below. |
| [`@avatarsd-llc/strawberry-cli`](./packages/strawberry-cli) | `packages/strawberry-cli` | The `strawberry` CLI — a board-setup command surface over the library — plus the Claude Code agent skills (`skill/`) that drive it. Depends on `@avatarsd-llc/strawberry-client`. |

`@avatarsd-llc/strawberry-client` is also embedded in
[`avatarsd-llc/strawberry-fw`](https://github.com/avatarsd-llc/strawberry-fw) as a git
**submodule** at `packages/strawberry-client`.

## Install (end users)

```bash
npm i @avatarsd-llc/strawberry-cli      # the CLI (pulls the library transitively)
npm i @avatarsd-llc/strawberry-client       # the library only
```

**Node 22+** is the baseline. The [`ws`](https://www.npmjs.com/package/ws) package is an
**optional** peer dependency, dynamically imported only by the library's `./node`
transport.

## Develop (this repo)

```bash
npm install                                   # links the workspace; installs shared devDeps
npm run proto                                 # regenerate the gitignored protobuf codec (strawberry-client)
npm run typecheck                             # tsc --noEmit in both packages
npm test                                      # vitest in both packages
npm run build                                 # build strawberry-client, then strawberry-cli
npm run lint:purity                           # framework-free gate (strawberry-client)
npm run sil                                   # SIL acceptance: CLI bin vs the mock board (informational)
```

Per-package commands use the workspace flag, e.g.
`npm run build -w @avatarsd-llc/strawberry-client`.

See [`docs/CONTRIBUTING.md`](./docs/CONTRIBUTING.md) for the contribution workflow,
[`packages/strawberry-client/docs/library.md`](./packages/strawberry-client/docs/library.md) for
the library reference, [`packages/strawberry-client/docs/protocol.md`](./packages/strawberry-client/docs/protocol.md)
for the WS+protobuf protocol, and
[`packages/strawberry-cli/docs/cli.md`](./packages/strawberry-cli/docs/cli.md) for the CLI
command reference.

## License

Apache-2.0. See [`LICENSE`](./LICENSE).
