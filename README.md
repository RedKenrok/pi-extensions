# Pi extensions

This repository is an npm workspace of Pi extension packages I have written for myself:

- [`fetch-tool`](packages/fetch-tool), which provides the `fetch` HTTP client tool.
- [`codex-compaction`](packages/codex-compaction), which adds portable Codex remote-compaction checkpoints to Pi's native compaction lifecycle.
- [`codex-research-tool`](packages/codex-research-tool), which provides the Codex-backed `research` tool.
- [`pi-notify`](packages/notify), which notifies the terminal when an interactive run is ready for input.

[`pi-extensions-shared`](packages/shared) is not an extension. It holds runtime helpers used by several packages (Codex endpoints and headers, JWT account parsing, SSE framing, bounded body reads, `PI_EXT_DEBUG` diagnostics).

> In addition I also use `pi install npm:@everyx/pi-subagent` and `pi install npm:@everyx/pi-sleep-guard`.

## Security boundaries

The packages deliberately have different network and authentication boundaries:

- `codex-research-tool` authenticates with Pi-managed `openai-codex` OAuth and sends only the supplied query plus fixed instructions to fixed `chatgpt.com` Codex endpoints. It does not forward the Pi conversation, workspace files, or local instructions.
- `codex-compaction` sends Pi's discarded conversation prefix, along with the system prompt and active tool schemas included in the compaction request, to a fixed `chatgpt.com` Codex endpoint with Pi-managed OAuth. Its opaque checkpoint is account/model/endpoint-bound and is paired with a portable native text summary.
- `fetch-tool` sends requests to caller-selected HTTP(S) destinations and can forward caller-supplied secrets in headers or bodies. Destinations can include local and private-network services, including after redirects; no private-network destination policy is currently enforced.
- `pi-notify` makes no network requests, but sends the workspace basename, session name, and short session ID to the terminal or Windows notification system; they may appear in OS notification history.

## Requirements

- Node.js 22.19.0 or newer.
- Pi `@earendil-works/pi-coding-agent` `>=0.85.1 <1.0.0` (extension packages declare this peer range). CI tests the pinned 0.85.1 minimum and 0.87.1 current compatibility set, with matching `pi-ai` and `pi-tui` peers where applicable. This does not claim compatibility with every release in the broad peer range.

## Installation and loading

These packages are intentionally private, local-use extensions, not registry releases. Their manifests set `private: true`; do not publish them to npm. Install one package from a local checkout:

```sh
pi install ./packages/fetch-tool
pi install ./packages/codex-compaction
pi install ./packages/codex-research-tool
pi install ./packages/notify
```

For development, run `npm install` at the checkout root first, then symlink packages into Pi's user extension directory (use `.pi/extensions/` for project-local discovery) and load with `/reload`. If you move or switch checkouts, update old extension symlinks to point at the checkout you installed:

```sh
mkdir -p ~/.pi/agent/extensions
ln -s "$(pwd)/packages/fetch-tool" ~/.pi/agent/extensions/fetch-tool
ln -s "$(pwd)/packages/codex-compaction" ~/.pi/agent/extensions/codex-compaction
ln -s "$(pwd)/packages/codex-research-tool" ~/.pi/agent/extensions/codex-research-tool
ln -s "$(pwd)/packages/notify" ~/.pi/agent/extensions/notify
```

## Shared code

Every extension is installed on its own, so shared runtime code cannot be imported across packages by path. Instead each extension declares `pi-extensions-shared` as a dependency and lists it in `bundleDependencies`:

- `npm install` at the repository root links the live shared sources into **each consumer's** `node_modules` (also available via `npm run link:shared`). Pi resolves imports from the symlinked extension path, so a hoisted workspace link at the root alone is not sufficient. Local installs (`pi install ./packages/<name>`) and symlinked extensions use these live sources.
- When a package is packed, its `prepack` script (`scripts/bundle-shared.mjs`) temporarily copies the shared package into that package's own `node_modules` so the archive is self-contained; `postpack` restores the local link. npm does not bundle workspace symlinks on its own.

`scripts/verify-packages.mjs` checks that every consumer bundles the complete shared sources, that the development links remain live, and that each extension loads both through a symlink and from a clean archive install.

## Diagnostics

Every package falls back quietly by default: a failed notification, a remote compaction that falls back to native, or an unconvertible page never interrupts Pi. To see why, set `PI_EXT_DEBUG` to a comma-separated list of package names (`fetch-tool`, `codex-compaction`, `codex-research-tool`, `pi-notify`) or `*`. Each enabled package then writes one `[package] reason-code` line to stderr per event. Lines never contain credentials, account IDs, URLs with userinfo, request bodies, or conversation content.

## Development

Install dependencies and run the shared verification suite from the repository root:

```sh
npm install
npm run ci
```

`npm run ci` type-checks all packages, runs read-only Biome checks, executes every workspace's tests and coverage thresholds, and verifies local package archives plus isolated consumer installs with exact Pi peers, loads every advertised TypeScript extension entrypoint through Pi's loader, and checks Pi peer dependency resolution. The consumer verifier may fetch dependencies from the configured npm registry but never publishes packages. CI runs the suite on Node 22.19.0 (the declared minimum), 24.x, and 26.x against coherent Pi peer versions 0.85.1 and 0.87.1. The current-version job installs overrides in its ephemeral CI checkout without saving them to the lockfile; local consumers of the verifier are scratch directories. The repository uses one root lockfile and keeps development-only dependencies in the root package.

Tests import shared helpers (deferred promises, JWT and SSE fixtures, an event-loop hold for `AbortSignal.timeout()` waits) from the root `test-support/` directory. It is linted and type-checked with the packages, and the package verifier rejects any archive that contains it.

Additional verification commands:

```sh
npm run test
npm run test:coverage
```
