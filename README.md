# Pi extensions

This repository is an npm workspace of Pi extension packages I have written for myself:

- [`fetch-tool`](packages/fetch-tool), which provides the `fetch` HTTP client tool.
- [`codex-compaction`](packages/codex-compaction), which adds portable Codex remote-compaction checkpoints to Pi's native compaction lifecycle.
- [`codex-research-tool`](packages/codex-research-tool), which provides the Codex-backed `research` tool.

> In addition I also use `pi install npm:@everyx/pi-subagent` and `pi install npm:@everyx/pi-sleep-guard`.

## Security boundaries

The packages deliberately have different network and authentication boundaries:

- `codex-research-tool` authenticates with Pi-managed `openai-codex` OAuth and sends only the supplied query plus fixed instructions to fixed `chatgpt.com` Codex endpoints. It does not forward the Pi conversation, workspace files, or local instructions.
- `codex-compaction` sends only Pi's discarded conversation prefix to a fixed `chatgpt.com` Codex endpoint with Pi-managed OAuth. Its opaque checkpoint is account/model/endpoint-bound and is paired with a portable native text summary.
- `fetch-tool` sends requests to caller-selected HTTP(S) destinations and can forward caller-supplied secrets in headers or bodies. Destinations can include local and private-network services, including after redirects; no private-network destination policy is currently enforced.

## Requirements

- Node.js 22.19.0 or newer.
- Pi `@earendil-works/pi-coding-agent` `>=0.85.1`.

## Installation and loading

Install one package from the repository root:

```sh
pi install ./packages/fetch-tool
pi install ./packages/codex-compaction
pi install ./packages/codex-research-tool
```

For development, packages can instead be symlinked into Pi's user extension directory (use `.pi/extensions/` for project-local discovery), then loaded with `/reload`:

```sh
mkdir -p ~/.pi/agent/extensions
ln -s "$(pwd)/packages/fetch-tool" ~/.pi/agent/extensions/fetch-tool
ln -s "$(pwd)/packages/codex-compaction" ~/.pi/agent/extensions/codex-compaction
ln -s "$(pwd)/packages/codex-research-tool" ~/.pi/agent/extensions/codex-research-tool
```

## Development

Install dependencies and run the shared verification suite from the repository root:

```sh
npm install
npm run check
```

`npm run check` type-checks all packages, runs Biome, and executes every workspace's tests. The repository uses one root lockfile and keeps development-only dependencies in the root package.

Additional verification commands:

```sh
npm run ci
npm run compat
npm run test:payload
npm run test:coverage
```

`npm run ci` includes the shared checks, the Pi SDK compatibility spike, and provider-payload verification. `npm run test:payload` starts a local synthetic provider and therefore requires permission to bind a loopback listener in restricted sandboxes.
