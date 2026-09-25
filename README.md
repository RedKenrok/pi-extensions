# Pi extensions

This repository is an npm workspace of Pi extension packages I have written for myself:

- [`fetch-tool`](packages/fetch-tool), which provides the `fetch` HTTP client tool.
- [`codex-compaction`](packages/codex-compaction), which adds portable Codex remote-compaction checkpoints to Pi's native compaction lifecycle.
- [`codex-research-tool`](packages/codex-research-tool), which provides the Codex-backed `research` tool.
- [`pi-notify`](packages/notify), which notifies the terminal when an interactive run is ready for input.

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

For development, packages can instead be symlinked into Pi's user extension directory (use `.pi/extensions/` for project-local discovery), then loaded with `/reload`:

```sh
mkdir -p ~/.pi/agent/extensions
ln -s "$(pwd)/packages/fetch-tool" ~/.pi/agent/extensions/fetch-tool
ln -s "$(pwd)/packages/codex-compaction" ~/.pi/agent/extensions/codex-compaction
ln -s "$(pwd)/packages/codex-research-tool" ~/.pi/agent/extensions/codex-research-tool
ln -s "$(pwd)/packages/notify" ~/.pi/agent/extensions/notify
```

## Development

Install dependencies and run the shared verification suite from the repository root:

```sh
npm install
npm run ci
```

`npm run ci` type-checks all packages, runs read-only Biome checks, executes every workspace's tests and coverage thresholds, and verifies local package archives plus isolated consumer installs with exact Pi peers, loads every advertised TypeScript extension entrypoint through Pi's loader, and checks Pi peer dependency resolution. The consumer verifier may fetch dependencies from the configured npm registry but never publishes packages. CI runs the suite on Node 22.19.0 (the declared minimum), 24.x, and 26.x against coherent Pi peer versions 0.85.1 and 0.87.1. The current-version job installs overrides in its ephemeral CI checkout without saving them to the lockfile; local consumers of the verifier are scratch directories. The repository uses one root lockfile and keeps development-only dependencies in the root package.

Additional verification commands:

```sh
npm run test
npm run test:coverage
```
