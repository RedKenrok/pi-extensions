# agent-tool

## Overview

`agent-tool` is a Pi extension that adds one `agent` tool and the human-facing `/agents` command. It runs child Pi sessions in background worker processes behind a local supervisor. A spawn call records the child and returns a handle immediately; the parent is free to keep working while the child runs.

The implementation uses Pi’s own session, model, authentication, reasoning, resource-loading, and agent-loop facilities. It does not copy provider credentials or invent a second transcript format.

## What it provides

| Interface | Purpose |
| --- | --- |
| `agent` tool | Spawn, inspect, wait for, steer, pause, resume, and stop background children. |
| `/agents` | Open the human-facing agent overview. |
| `/agents status` | Show current child and supervisor status. |
| `/agents inspect <agent-id>` | Inspect one child without a model request. |
| `/agents pause`, `resume`, and `stop` | Control children directly from Pi. |
| `/agents idles`, `idle`, and `cancel-idle` | Show, inspect, and cancel idle barriers. |

Children use Pi's own conversations and authenticated models. The supervisor adds best-effort scheduling, ownership, recovery, workspaces, controls, and result delivery around those sessions.

## Requirements

- Node.js 22.19 or newer.
- Pi `>=0.85.1`.
- A model already authenticated through Pi for real child runs.
- Git when using isolated worktrees.

## Installation and loading

From the repository root:

```sh
npm install
npm run check
npm run compat
pi install ./packages/agent-tool
```

For project-local installation, use `pi install ./packages/agent-tool --local`. Restart or reload Pi after installation. The extension starts its supervisor lazily on first use; no daemon setup is required.

For one-off loading from the repository root, run:

```sh
pi -e ./packages/agent-tool
```

The package manifest declares `pi.extensions: ["./index.ts"]`.

State lives under `<Pi agent directory>/agent-tool/`, normally `~/.pi/agent/agent-tool/`. Best-effort supervisor state is stored as loose JSON files under `state/`; the directory also contains an authenticated user-only Unix socket, child session references, worker configuration handoffs, and rotated result artifacts. Pi remains authoritative for each child’s JSONL conversation.

## Usage

The `agent` tool uses an `action` discriminator:

| Action | Purpose |
| --- | --- |
| `catalog` | List authenticated models, supported reasoning levels, profiles, and known scheduler admission blocks. |
| `spawn` | Commit a new child and return its identifiers immediately. |
| `list` | List children, optionally filtered by state. |
| `inspect`, `inspect_many` | Read current state, events, summaries, and diagnostics without exposing child transcripts or accumulated output. |
| `wait` | Observe up to eight children synchronously for at most 60 seconds. |
| `idle` | Join a specific child group under a completion condition and coalesce its notifications. |
| `idle_list`, `idle_inspect`, `idle_update`, `idle_cancel` | Manage idle conditions. |
| `message` | Steer an active child or queue a follow-up. |
| `pause`, `resume`, `stop` | Control child execution and recovery. |

The parent must inspect choices with `catalog` before its first spawn. `catalog` returns the models selected for the current Pi session (`--models` or `enabledModels`), falling back to all authenticated models when no scope is configured. Its model-visible text includes every exact provider/model ID on the page and that model's supported reasoning efforts, plus any effort selected by the session scope. Models are linked by `scopeId` to normalized provider `scopes`. Each scope has an `admission` object that distinguishes `no_known_block`, `cooling_down`, and `manual_retry_required`. These blocks are learned reactively from provider failures; `no_known_block` means only that the supervisor has no persisted block. The catalog omits remaining subscription quota because Pi exposes no supported universal API for it. An unknown provider filter is rejected with the exact available provider names instead of returning an ambiguous empty catalog.

```json
{"action":"catalog"}
```

Start a background child:

```json
{
  "action": "spawn",
  "name": "auth-review",
  "model": { "provider": "openai-codex", "id": "gpt-6-luna" },
  "prompt": "Review authentication. Report correctness issues with file and line references. Do not edit files.",
  "instructions": "Order findings by severity and identify missing evidence.",
  "tools": ["read", "grep", "find", "ls"],
  "workspace": "shared",
  "recovery": "when_available",
  "requestId": "auth-review-v1"
}
```

The response includes `agentId` and per-attempt `runId` values plus requested and effective configuration. `spawn` does not wait for the child model. `model` is required and must use the exact `{ "provider": "…", "id": "…" }` returned by `catalog`; spawn never silently inherits the parent model. Each run has a one-hour wall-clock limit by default. Override it with `limits: { "runtimeSeconds": 7200 }`; the value is a positive integer number of seconds. Spawn has no turn-count or token-count limit.

**Completion workflow:** continue independent work after `spawn`, or simply end the parent turn; do not poll for completion. Ordinary child completion is delivered automatically and starts a new parent turn once the parent is idle, so a single child does not require an `idle` call. Use `idle` only when a specific group should be joined under an aggregate condition such as all-settled, quorum, or fail-fast. `wait` is only for one brief synchronous observation while other parent work remains. `stop` cancels work whose result is no longer wanted; it is not a way to wait, and an in-flight operation may finish before cancellation settles.

If a provider scope already has a known cooldown, a child is committed directly as `blocked` rather than being reported as temporarily queued. Its response includes the reason, normalized error, and admission guidance. Once the scope requires manual retry, further spawns in that parent and scope are rejected by default; set `blockedPolicy` to `enqueue` only to deliberately add waiting work. Resume assigns one shared probe owner while the supervisor is running. Concurrent resumes still save their requested model and run configuration, but remain blocked behind that owner until its successful probe releases them.

After the parent itself returns from a quota interruption, it should call `list` once and reuse the existing agent IDs. The child worker processes will have exited, but quota-affected agents normally remain in `blocked`, retaining their saved conversations. Resume one blocked agent per provider scope; when that probe succeeds, siblings using the default `when_available` recovery policy are released automatically. An agent whose state is literally `stopped` was cancelled and is terminal, so it cannot be resumed; spawn a replacement only in that case. Agents configured with `recovery: "manual"` must each be resumed explicitly.

Inspect, idle, wait, steer, and control it:

```json
{"action":"inspect","agentId":"ag_…"}
{"action":"idle","agentIds":["ag_…","ag_…"],"until":"all_settled","requestId":"review-group"}
{"action":"wait","agentIds":["ag_…"],"afterEventId":41,"timeoutMs":60000}
{"action":"message","agentId":"ag_…","delivery":"steer","text":"Focus on the token refresh race.","requestId":"focus-1"}
{"action":"message","agentId":"ag_…","delivery":"followUp","text":"Afterward, summarize test gaps.","requestId":"gaps-1"}
{"action":"pause","agentId":"ag_…","mode":"graceful"}
{"action":"resume","agentId":"ag_…","prompt":"Continue after the pause."}
{"action":"stop","agentId":"ag_…","reason":"No longer needed"}
```

`idle` is the advanced join option for a parent that wants one aggregate result from a defined set of one to eight children. It is not required for ordinary completion delivery. It supports `all_settled`, `any_settled`, `all_succeeded`, `first_failure`, and `quorum` conditions; `all_settled` is the default. The call commits the condition and returns immediately. An armed result requests early termination of the parent tool batch, so a standalone `idle` call settles the run without another model response merely acknowledging the wait. Matching child notifications are coalesced, and Pi injects one aggregate message when the condition resolves. A paused or nonrecoverably blocked member can resolve the condition with `attention_required`; recoverable quota waits remain armed.

`activityPolicy` controls what happens if the parent becomes active while the condition is pending: keep it, cancel it, or retain notification without automatic wakeup. `disconnectPolicy` either defers delivery until the exact parent session reconnects or permits a headless continuation. Pending conditions can be listed, inspected, updated, or cancelled by their saved `idleId`.

Examples of the extended controls:

```json
{"action":"idle","agentIds":["ag_1","ag_2","ag_3"],"until":"quorum","quorum":2,"activityPolicy":"notify_only","requestId":"two-reviews"}
{"action":"idle_list","state":"pending"}
{"action":"idle_inspect","idleId":"idle_…"}
{"action":"idle_update","idleId":"idle_…","removeAgentIds":["ag_3"],"addAgentIds":["ag_4"],"requestId":"swap-reviewer"}
{"action":"idle_cancel","idleId":"idle_…","requestId":"no-longer-needed"}
{"action":"inspect_many","agentIds":["ag_1","ag_2"]}
```

The completion conditions are: `any_settled` for the first terminal member, `quorum` after the requested number settle, `all_succeeded` for fail-fast all-success, and `first_failure` for failure monitoring (or `all_succeeded` when every member completes).

The aggregate message contains bounded final-result excerpts. If an excerpt is truncated, the parent is told that full child output and transcripts are intentionally unavailable. It can resume a completed child and request a concise restatement instead of importing that child's accumulated context. If every requested agent is already settled, `idle` resolves immediately and does not schedule a redundant continuation. `requestId` makes retries idempotent.

`wait` remains the short synchronous observation primitive. It observes at most eight agents, subscribes before checking the cursor, returns on any event, and times out after at most 60 seconds without cancelling a child. Ordinary completion, failure, quota blocks, and reconciliation blocks outside an idle barrier are delivered automatically to the owning parent session.

Notifications use Pi follow-up delivery and trigger a new LLM turn when the parent is idle. While a parent run is active, notifications remain in the supervisor outbox so an `idle` barrier can coalesce them before they enter Pi's follow-up queue. Pi exposes no extension API for retracting a follow-up after it has been queued. If the parent session is disconnected, notifications stay in the outbox and are replayed after it reattaches.

`disconnectPolicy: "continue_headless"` is an explicit exception for a clean Pi quit. When its barrier later resolves, the supervisor claims one continuation, reopens the exact saved parent session, and appends one tool-free model turn containing only bounded final-result excerpts, never accumulated child output or transcripts. Its run ID and process ID are persisted so supervisor recovery does not duplicate a live continuation. Missing session/model/cwd state fails visibly on the barrier. The default `defer` policy makes no unattended model call. Reload, fork, session replacement, and an unclean parent crash also defer rather than risk concurrent writes; a headless run already claimed before reattachment is allowed to finish.

## Configuration and behavior

Creation always requires an explicit model. Reasoning precedence is explicit call, then profile, then the parent snapshot; tool precedence is explicit call, then profile, then the read-only default (`read`, `grep`, `find`, and `ls`) intersected with the parent toolbox. A profile model is advertised by `catalog` as a recommendation but is never selected silently. An inherited reasoning level that the selected model does not support is rejected; it is never silently clamped. Resume keeps the saved configuration unless an allowed override is supplied.

Supported per-call fields include:

- `prompt`, `instructions`, and explicit non-instruction `context`.
- `profile`, using `user:name` or `project:name` when names collide.
- exact `model: { provider, id }` and Pi reasoning levels returned by `catalog`.
- a parent-approved `tools` allowlist. By default the child receives only active `read`, `grep`, `find`, and `ls` tools. An explicit list or profile may grant other tools active in the parent, including mutation tools when needed. Extension implementations are independently loaded in the worker only when they contribute a requested tool. The `agent` tool is always removed to prevent recursive delegation.
- `cwd` and either shared or isolated `workspace` mode.
- `recovery: manual | when_available` and an optional per-child `limits.runtimeSeconds` wall-clock limit (default `3600`).
- `requestId` for idempotent retries across parent turns.

Text fields are capped at 32 KiB and a spawn payload at 128 KiB. Prompt/template expansion is disabled for tasks and controls, so slash-prefixed and template-shaped text is transported literally.

### Usage reporting

Each worker records a baseline when its saved Pi session opens, then checkpoints the run's delta at completed turn boundaries and before terminal, pause, or provider-availability events. `list`, `inspect`, `/agents status`, `/agents inspect`, individual completion messages, and aggregate idle messages show the current run's input, output, cache-read, cache-write, total tokens, and cost when Pi reports one. `inspect` also shows lifetime totals across every saved run of the same child and its wall-clock runtime limit.

These numbers describe observed model usage, not account allowance. A missing provider cost is displayed as `cost unknown`, never as zero, and subscription quota remains `unknown` because Pi 0.85.1 exposes no supported universal quota API. During an active streaming turn, the latest checkpoint may lag until that turn ends.

Host limits can be configured before Pi starts:

| Environment variable | Default | Meaning |
| --- | ---: | --- |
| `PI_TOOLS_MAX_RUNNING` | 16 | Concurrent workers per supervisor |
| `PI_TOOLS_MAX_PER_SCOPE` | 16 | Concurrent workers sharing a credential scope |
| `PI_TOOLS_MAX_PER_PARENT` | 32 | Outstanding children owned by one parent |
| `PI_TOOLS_MAX_QUEUED` | 128 | Outstanding children across the supervisor |

Limits are host policy. An agent call cannot override them.

### Background research

If the parent has the `research` tool active, a child can receive it explicitly:

```json
{
  "action": "spawn",
  "name": "standards-research",
  "model": { "provider": "openai-codex", "id": "gpt-6-luna" },
  "prompt": "Research the current primary-source guidance and return a cited answer.",
  "tools": ["research"],
  "requestId": "standards-research-v1"
}
```

agent-tool snapshots the active tool's exact Pi-reported extension path and passes only that path to the worker. General extension discovery remains disabled, so unrelated extension schemas and instructions are absent. The research extension still performs its own Pi-managed Codex subscription authentication and availability checks; agent-tool never substitutes an API key or another credential store.

### Profiles

User profiles live in Pi’s configured agent directory under `agents/`. Trusted project profiles are found at the nearest `.pi/agents/` within the Git/project boundary. Example:

```markdown
---
name: reviewer
description: Read-only correctness reviewer
model: openai-codex/gpt-5.3-codex
reasoning: high
tools: [read, grep, find, ls]
---
Review for correctness. Do not edit files. Return evidence with every finding.
```

`reasoning` is an `agent-tool` extension to Pi’s bundled profile convention. The resolved profile body, fields, source path, and SHA-256 hash are snapshotted at spawn, so later edits cannot change a waiting child.

### Workspaces

`shared` uses the selected working directory and reports that fact in the spawn response. Concurrent writers should be assigned different files.

`worktree` requires Git and creates a detached worktree under the supervisor state directory unless an explicit path is supplied. The source repository and exact base revision are persisted with the child and verified when an idempotent spawn is reconciled. A missing workspace blocks visibly before launch. Pause and stop preserve the worktree; agent-tool never merges or deletes it automatically. Tool allowlists and working directories are not operating-system sandboxes.

### Human controls

These commands do not require a model request:

```text
/agents
/agents status
/agents idles
/agents idle <idle-id>
/agents cancel-idle <idle-id>
/agents inspect <agent-id>
/agents pause <agent-id>
/agents pause <agent-id> interrupt
/agents resume <agent-id>
/agents stop <agent-id>
/agents stop-all
```

Status distinguishes running, gracefully pausing, paused by the user, waiting for quota, and blocked for reconciliation. Inspect additionally shows the run and fencing generation, desired state, model/reasoning, workspace base revision, cooldown provenance, pending controls, and uncertain operations. It does not expose the child transcript, transcript path, accumulated output artifact, or artifact path.

### Best-effort state and recovery

Supervisor coordination state is stored in loose JSON files using the exact integer format version `1`. There are no migrations or compatibility readers. A missing, malformed, older, or newer schema is discarded and reported as requiring a Pi restart; previously running agents are not recovered. Writes use temporary files and rename to avoid routinely leaving partial JSON, but accepted mutations are not promised to survive crashes and multi-file updates are not transactional.

Workers receive only a restrictive configuration-file path on their command line. Prompts and credentials do not appear in process arguments. The worker re-resolves Pi authentication at each run. IPC and state files are mode `0600`; directories and the local socket are user-only. Provider error bodies, tokens, authorization headers, and API keys are not written to supervisor records or returned by the tool.

When valid state happens to be available after restart:

1. queued work stays queued and user pause/stop intent is preserved;
2. an expired worker lease triggers fenced termination; replacement waits until the old PID is known dead or the worker has reported that it settled;
3. the exact saved Pi session file is reopened, never “most recent”;
4. missing/corrupt transcripts or workspaces become visible recovery blocks;
5. started read-only operations may be repeated, while uncertain writes, shell operations, and external effects require explicit reconciliation.

Conversation continuity is guaranteed; an interrupted stream or process cannot be unfrozen. Resume starts another model request on the same saved conversation with a continuation instruction. Cross-provider model changes on a persisted conversation are rejected because Pi 0.85.1 does not expose a reliable history-transport compatibility proof.

Durable controls carry message IDs in the child transcript. If a crash leaves a control marked submitted but absent from the transcript, the child blocks instead of resending blindly. Resolve it explicitly with a resume prompt containing either:

```text
reconcile message msg_…: retry
reconcile message msg_…: skip
```

Likewise, if valid best-effort state records a side-effecting tool start without its result, resume blocks. Inspect the agent's `uncertainOperations`, verify the external state, and give every operation an explicit decision in the resume prompt:

```text
reconcile tool call_…: retry
reconcile tool call_…: skip
```

`retry` permits the child to perform the operation again; `skip` records that it must continue without repeating it. The supervisor records these decisions with the new run on a best-effort basis.

### Quota and credential cooldowns

The supervisor groups work by a local opaque provider/credential-store scope, never by a token. A block opens one shared circuit breaker. Siblings do not probe simultaneously; exactly one eligible child performs the real continuation probe, and a successful probe gradually releases the queue. User-paused and stopped agents are never revived by recovery.

Reset time is used only when supported evidence supplies it (`Retry-After` or a typed/provider reset field). An ambiguous 429 is a short rate limit with unknown reset, not “five hours from now.” Without reliable reset evidence, probes back off from one minute to at most 30 minutes and stop after six attempts. Known weekly/account restrictions and authentication failures require user action unless reliable new evidence appears. The default automatic-recovery deadline is 24 hours.

Machine sleep and supervisor restart do not restart the countdown: persisted UTC deadlines are compared with the current clock when the service returns. A probe is a real model continuation when no nonbillable provider availability API exists, so it can consume usage.

## Security and privacy

- Child workers resolve authentication through Pi at run time. Credentials and prompts are not copied into process arguments.
- IPC and state files use mode `0600`; state directories and the Unix socket are user-only.
- Provider error bodies, tokens, authorization headers, and API keys are not written to supervisor records or returned by the tool.
- Parent ownership is tied to the Pi session ID. A different session cannot inspect or control those children. Forked branches that retain the same Pi session ID share child visibility and control; the recorded branch anchor is diagnostic and is used to avoid unsafe headless continuation, not as an authorization boundary.
- Tool allowlists narrow the worker's active tools, but they are not operating-system sandboxes. A child with shell or write tools still has the underlying process user's access.
- Shared workspaces permit concurrent access to the same files. Assign separate files or use isolated worktrees when concurrent writes could conflict.
- Worktrees are preserved on pause and stop; the extension never merges or deletes them automatically.

## Development and verification

From the repository root:

```sh
npm run check
npm run compat
```

The automated suite covers versioned JSON reopen and reset, idempotent controls and resumes, every idle completion policy, barrier list/inspect/update/cancel, parent-activity policies, aggregate wakeups, bounded multi-inspection, exact extension forwarding for background research, headless continuation, immediate settlement, nonrecoverable attention, notification truncation guidance, late-event fencing, stale-worker lease termination, shared cooldown single-probe behavior, explicit manual recovery, known multi-hour reset plus restart/sleep, bounded unknown-reset backoff, ownership isolation, outbox replay, wait races, uncertain-side-effect decisions, worktree provenance, missing workspaces, queue saturation, malformed state, literal transport, and secret redaction. The Unix-socket process handshake test skips only when the execution sandbox itself denies local socket listeners.

The compatibility spike uses Pi's faux provider and makes no billable request. It checks the pinned SDK assumptions for exact session reopen, literal prompts, model-derived reasoning levels, selected extension-tool execution, recursive `agent` exclusion, controlled resource loading, pre-dispatch tool blocking, and abort settlement. The resulting design constraints are documented in [Architecture](docs/architecture.md).

Do not deliberately exhaust an account for testing. Synthetic errors and a fake clock cover quota and long-duration recovery paths without consuming a real account's allowance.

## Known limitations

- Recovery runs only while the machine and supervisor are running. OS-login service packaging is not included.
- Headless parent continuation is deliberately limited to one tool-free turn after an observed clean quit and must be requested on the barrier. It does not run after an unclean crash, reload, fork, or session replacement.
- Delivery is at least once with event-ID deduplication, not a cross-process exactly-once promise.
- The supervisor coordinates only workers using its own Pi agent directory; it cannot gate unrelated Pi processes or other applications.
- No child delegation, parent-history cloning, automatic credential switching, provider/model fallback, purchase flow, merge, cleanup, or adoption by another parent is implemented.
- A child can use only tools active in the parent host. Worker resource loading retains extensions that contribute a selected tool and removes unselected tools; the `agent` tool is always excluded to prevent recursive delegation.
- File-backed extension tools can be reconstructed from Pi's source metadata. Process-local inline/SDK tools without a real source path cannot cross the worker boundary; if selected, the run fails before the model prompt instead of silently omitting them. Loading a file-backed tool necessarily executes its extension module and lifecycle hooks in the worker.
- Subscription quota remaining and cost may be unknown. Token usage and Pi-reported cost are separate from provider allowance.
- macOS/Linux use process-group cancellation. Windows falls back to the worker PID and depends on the invoked tool’s cancellation behavior for descendants.
