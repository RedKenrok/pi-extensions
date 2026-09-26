# codex-compaction

A Pi extension (tested with Pi 0.87.1, peer range `>=0.85.1 <1.0.0`) that uses Codex `RemoteCompactionV2` checkpoints when the active model is the trusted, Pi-managed `openai-codex` provider. Pi remains responsible for deciding when to compact, selecting the discarded prefix and retained tail, and persisting the resulting `CompactionEntry`.

## Usage

```sh
pi install ./packages/codex-compaction
```

Sign in through Pi first with `/login openai-codex`. The package registers no model-facing tool or command.

## Behavior and fallback

At `session_before_compact`, the extension asks the fixed `https://chatgpt.com` Codex endpoint to compact Pi's discarded messages (plus a compatible checkpoint from the previous compaction). The request also includes the current system prompt and active tool schemas required by the Codex protocol; Pi's kept tail is not sent as conversation input and remains unchanged. The opaque checkpoint is stored in `CompactionEntry.details` and substituted for Pi's generated summary input on later provider requests.

A native Pi summary is retained alongside the checkpoint so the session remains useful if this extension is disabled or the provider changes. Requests with custom compaction instructions use native compaction because the remote protocol cannot guarantee those instructions are honored. Authentication, endpoint, account, model, or checkpoint mismatches also use native compaction.

Cancellation, timeout, redirects, malformed or oversized SSE, incompatible responses, and remote failures fail closed to Pi's native compactor. When the extension itself returns the native result because the remote request failed or missed its grace period, the entry's `details.fallbackReason` records `remote_failed` or `remote_grace_elapsed`. Successive compactions only reuse checkpoints whose recorded account, model, API, and endpoint exactly match the active request. State is reconstructed from the active session branch, so reloads and forks do not rely on process-global history.

A native compaction entry without a compatible remote checkpoint is a permanent opaque-history boundary for that branch: later compactions stay native rather than creating a checkpoint that silently omits older history. This includes native compactions created while using custom instructions, another provider, or the extension being disabled.

## Diagnostics

Fallbacks are silent by default. Set `PI_EXT_DEBUG=codex-compaction` (a comma-separated list of package names, or `*`) to print one line per fallback to stderr, such as `[codex-compaction] tail_incompatible`. The codes are `custom_instructions`, `no_model`, `untrusted_model`, `auth_unavailable`, `aborted`, `invalid_checkpoint`, `summary_without_checkpoint`, `checkpoint_incompatible`, `tail_incompatible`, `nothing_to_discard`, `native_failed`, `remote_failed`, and `remote_grace_elapsed`. They never include tokens, account identifiers, or conversation content.

## Security and privacy

The discarded conversation messages, together with the required current system prompt and active tool schemas, are sent to the fixed `https://chatgpt.com/backend-api/codex` service using credentials resolved by Pi for `openai-codex`. Redirects are rejected so credentials are never forwarded to another origin. Checkpoints are opaque provider data and may contain conversation-derived information; they are persisted in the Pi session file under `CompactionEntry.details`.

No project configuration can replace the trusted origin or inject credentials. As with normal Codex use, OpenAI's service terms and data handling apply.

## Tradeoffs and compatibility

Remote checkpoints are intended to retain Codex-native context that may not fit cleanly in a text summary, but they are experimental, opaque, and specific to one account, model, API, and endpoint. If replay cannot be proved safe, the extension leaves Pi's provider payload untouched.

A successful hybrid compaction makes two requests: Pi's native summarization request and the Codex remote-compaction request. Both can consume service quota. Pi records the native summary's usage but not the remote request's, so Pi session totals under-report it. When the backend reports usage for the remote request, it is kept in `details.remoteCompaction.usage` so the session file still has a record. By default, the extension waits up to 5 seconds after native compaction for the remote request; configure `remoteGraceMs` when creating the extension (an integer from 0 to 60000) to change this grace period. `remoteGraceMs` and `timeoutMs` are validated when the extension is created, so an invalid value fails at load time. If remote work does not finish in time, native output is returned and the remote request is aborted.

The extension stores and replays the single opaque compaction item returned by Codex rather than retaining an additional 64K slice of discarded user messages. Pi already preserves its independently selected kept tail, so retaining another slice would duplicate content and weaken Pi's boundary. On successive compactions, the prior opaque item seeds the next prefix-only request.

The deterministic suite uses synthetic SSE and Pi lifecycle fixtures; it does **not** make a live remote-compaction request. `tests/contract.test.ts` runs against the installed Pi instead of fixtures: it checks that Pi's converted compaction summary still matches the wrapper text replay looks for, and that payload capture never reaches the network, so upstream changes fail CI for each tested Pi version. `remote_compaction_v2` is an experimental Codex API and can change independently of Pi. A protocol change safely falls back to native compaction but may make remote checkpoints unavailable until this package is updated.

## Upstream references

Design and interoperability were checked against these upstream projects; no implementation was copied wholesale:

- [OpenAI Codex](https://github.com/openai/codex): Codex Responses transport and remote-compaction behavior.
- [algal](https://github.com/czottmann/algal): independent hybrid/opaque-checkpoint design prior art and tradeoffs.
- [OpenAI Node SDK Responses types](https://github.com/openai/openai-node/tree/master/src/resources/responses): public Responses item and `compaction_trigger` shapes.
- [Pi compaction documentation](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/compaction.md): Pi's compaction boundary, extension hooks, and session entries.

This package targets `@earendil-works/pi-coding-agent >=0.85.1` and uses Pi's exported `compact()` helper and public SDK payload hook. It does not copy upstream source.
