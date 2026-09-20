# compact-tool

A model-callable `compact` tool that queues Pi's native manual compaction. It uses Pi's normal summarizer and session compaction format; unlike the former prune tool, it does not filter context, write markers, or require a caller-authored handoff.

## Usage

```bash
pi install ./packages/compact-tool
```

The model should call `compact` only at a genuine task transition where reducing older context is useful. It must be the only tool call in that batch, because `terminate: true` stops the turn only when every result in the batch terminates. Do not call it repeatedly for one transition.

`instructions` is optional and is forwarded to Pi as native summarizer focus instructions. The tool returns immediately after queuing compaction; its result explicitly is not completion confirmation. On successful completion, the extension starts a continuation only when Pi is idle and has no pending messages. Existing queued user messages take precedence. Failure or cancellation never auto-resumes; interactive/RPC sessions receive an error notification on failure.
