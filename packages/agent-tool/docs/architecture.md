# Architecture

This document records the design constraints for `agent-tool`. Installation, commands, configuration, and user-facing behavior are documented in the [README](../README.md).

## System boundary

The `agent` tool creates Pi agent sessions. Pi remains responsible for model execution, authentication, tools, project instructions, and conversation files. A local supervisor adds scheduling, best-effort controls and recovery, and parent-session result delivery. Each child executes in a separate worker process so interruption has a process boundary.

The system guarantees **conversation continuity, not exact execution continuation**. A resumed child retains its identity, saved conversation, task, and completed results. An interrupted stream or command cannot be unfrozen; recovery starts another model request after reconciling incomplete work.

```text
Pi parent session
  └─ agent extension / notification bridge
       └─ authenticated local IPC
            └─ supervisor (queue, journal, cooldowns, outbox)
                 ├─ SDK worker → persistent Pi child session
                 ├─ SDK worker → persistent Pi child session
                 └─ best-effort controls and result artifacts
```

## Invariants

- Open child conversations by exact session path and ID; never resume “most recent.”
- Preserve the selected provider and model during recovery. Reject cross-provider resume while saved-history compatibility cannot be established.
- Transport task and control text literally, with prompt-template expansion disabled.
- Treat tool selection as narrowing the parent-approved toolbox. Default to the parent's active read-only built-ins (`read`, `grep`, `find`, and `ls`); require an explicit call or profile for all other tools. Never expose `agent` to a child.
- Distinguish queued, submitted, applied, settled, and delivered operations. An SDK promise settling proves only its own boundary.
- Preserve pause and stop intent across recovery. Stop overrides pause; pause overrides automatic resume.
- Do not infer subscription allowance or reset time from token counts or ambiguous provider errors.
- Do not replay a possibly completed side effect without evidence or an explicit reconciliation decision.
- Scope child ownership and result delivery to the parent session ID. Session switches do not transfer ownership; forks that retain the same session ID share ownership.

## Pi SDK constraints

The adapter is pinned to `@earendil-works/pi-coding-agent` 0.85.1. The nonbillable `npm run compat` spike exercises the SDK assumptions on which this architecture depends:

| SDK behavior | Architectural consequence |
| --- | --- |
| `SessionManager.create` and `SessionManager.open` preserve session identity and messages. | Store and reopen the exact session file and ID. |
| `session.prompt` supports `expandPromptTemplates: false`. | Transport tasks and controls without slash-command or template expansion. |
| Available models and supported thinking levels are discoverable at runtime. | Validate authentication and reasoning before starting a child request. |
| Resource loading accepts explicit extension paths and tool filtering. | Load only selected parent-reported file-backed tools and remove `agent`. |
| A `tool_call` hook can block before dispatch. | Journal tool start and enforce graceful-pause boundaries before side effects. |
| Active prompts and compaction can be aborted. | Combine SDK abort with worker process-tree termination for interrupt controls. |
| Provider errors have no universal quota-reset contract. | Trust only recognized reset evidence; otherwise use bounded probes with unknown provenance. |

File-backed extensions can be reconstructed in a worker from Pi's source metadata. Process-local inline or SDK-created tools cannot cross the process boundary and must fail before prompting rather than disappear silently.

## Persistence and process ownership

One supervisor runs per Pi user/config directory. It starts lazily with a lock and readiness handshake and communicates over a user-restricted local socket or named pipe. Workers receive a configuration path and IPC credentials; prompts and provider credentials are not placed in process arguments.

Supervisor state lives outside the repository under the Pi agent directory. Loose JSON files record agents, runs, controls, events, leases, cooldowns, uncertain operations, and notifications. Every document uses the exact integer format version `1`; incompatible or malformed state is discarded rather than migrated. This state is disposable and best-effort: writes are not transactional and acknowledged changes are not guaranteed to survive a crash. Pi's JSONL session is authoritative for conversation history.

Each worker generation has a fencing token. The supervisor accepts events only from the current generation and launches no replacement until the previous local worker is known dead; an expired lease alone is insufficient. Idempotency is scoped to the parent session and tool call, with `requestId` available for retries across turns.

Full results live in bounded, rotated internal artifacts with restrictive permissions. Parent-facing inspect actions expose neither those artifacts nor child transcript paths. Supervisor records exclude credentials, authorization headers, and raw provider error bodies.

## Worker lifecycle and controls

A worker resolves the saved model and authentication through Pi, validates reasoning and tools, opens the exact child session, subscribes to lifecycle events, and then submits the saved task or continuation.

| State | Meaning |
| --- | --- |
| `queued` | Durable work awaiting admission. |
| `running` | A worker owns the current generation. |
| `pausing` | A pause is accepted and awaiting its selected boundary. |
| `paused` | Quiescent by user request; only explicit resume restarts it. |
| `blocked` | Progress requires availability, authentication, workspace repair, or reconciliation. |
| `recovering` | Previous execution is being reconciled before replacement. |
| `completed` | The assignment settled; a follow-up creates another run on the same child. |
| `failed` | The run cannot recover automatically. |
| `stopping` / `stopped` | Cancellation in progress / terminal cancellation. |

Controls are serialized per child. A late completion may preserve useful output but cannot overturn an accepted stop or start another run.

- **Steer and follow-up:** persist messages before SDK submission and track their delivery state. A submitted message absent from the reopened transcript requires explicit reconciliation instead of blind resend.
- **Graceful pause:** finish the current tool, then block the next tool or model request. The child remains `pausing` until that boundary is reached.
- **Interrupt pause and stop:** abort Pi, cancel descendants, preserve partial output, and identify uncertain effects. Neither operation rolls back completed external actions.
- **Resume:** reopen the saved conversation and issue a new continuation request containing the objective, completed work, interruption reason, pending controls, and unresolved actions.

## Parent delivery and ownership

Child execution continues after `spawn` returns. Terminal events are persisted to an outbox before the bridge inserts a compact message into the owning parent session. Delivery is at least once, with event IDs for deduplication. Results remain queued while the parent is disconnected.

An `idle` barrier groups owned children in best-effort state and emits one bounded digest when its condition resolves. Recoverable availability blocks remain pending; a nonrecoverable member may resolve early for attention. Barriers are reevaluated after supervisor recovery.

A session switch detaches the bridge instead of redirecting output. Forks that retain the same session ID share child visibility and control, but do not trigger headless continuation. Optional headless continuation is limited to one fenced, tool-free turn after an observed clean quit; reload, replacement, fork, and unclean crash do not trigger it.

## Availability recovery

Quota policy is provider-specific. Only typed or allowlisted reset evidence is treated as authoritative. An ambiguous 429 is not classified as a particular subscription window.

When availability blocks a run, the supervisor:

1. Persists the classification, checkpoint, pending controls, limits, and reset-time provenance.
2. Opens a circuit breaker for the credential scope and releases the settled worker slot.
3. Waits for a supported reset time plus jitter, or uses bounded exponential probes when the reset is unknown.
4. Permits one probe per scope and gradually releases queued work after success.
5. Re-resolves credentials and reopens the same child conversation without provider/model fallback.

Persisted UTC deadlines survive supervisor restart and machine sleep. User pause and stop always take precedence. Completed output remains deliverable while related work is blocked.

## Crash recovery and uncertain effects

At startup, the supervisor fences stale generations, preserves queued and paused intent, and reconciles orphaned running work. Missing workspaces, corrupt state, and missing transcripts become explicit blocks rather than replacement state.

The supervisor cannot atomically commit filesystem or remote effects. Workers record tool start before dispatch and completion after observing output as a best-effort aid to recovery. If a crash occurs between an effect and its result, recovery inspects the affected resource or uses a tool-specific idempotency key. Read-only operations can usually repeat; writes and external submissions require evidence. Unknown outcomes remain `recovery_required` until an explicit retry or skip decision is recorded.

Recovery does not fabricate tool results or manually reconstruct incomplete provider messages. Original transcripts and artifacts remain available internally for child-session recovery, but are not exposed through parent inspect actions.

## Workspace boundary

The default workspace is the parent's working directory, so concurrent writers require distinct files or isolated worktrees. Worktree mode records the source repository and exact base revision. Pause and stop preserve the worktree; the extension does not merge or delete it automatically.

Working directories and tool allowlists are coordination boundaries, not operating-system sandboxes.

## Acceptance properties

- Background children can overlap parent work and deliver results without busy polling.
- Model, reasoning, profile, workspace, and tool restrictions are applied or rejected before a child model request.
- Retried spawn and control requests do not duplicate children, messages, or runs.
- Controls remain ordered through restart and availability waits; late events cannot revive stopped work.
- Pause and cancellation report partial and uncertain outcomes truthfully and account for descendant processes.
- Shared credential scopes permit only one recovery probe and never revive paused or stopped children.
- Crash recovery preserves identity and exposes uncertain effects rather than replaying them.
- Parent lifecycle changes do not transfer ownership or redirect results to another conversation.
- Limits, truncation, unavailable credentials, corrupt state, and missing workspaces fail visibly without leaking secrets.
