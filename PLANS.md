# Read-only Pi session audit extension

**Status: planned; not implemented.** This document is a proposal and acceptance checklist, not evidence of delivered behavior. The MVP is an investigator for observed failures, corrections, scope changes, and verification—not a generic telemetry dashboard.

## Outcome and boundaries

Provide a user-invoked, deterministic local audit of explicitly selected Pi session JSONL files: one main session and any individually selected linked child sessions. Summarize user corrections and scope changes; tool failures; recorded spawn/send/completion lifecycle signals; model/provider changes and token/cost usage; and verification commands with their recorded results. Every factual item cites the source file, message/entry ID, and timestamp when present. Distinguish transcript-recorded claims from independently verified evidence; the audit itself does not run or verify commands.

Read-only means no source-session edits, execution of recorded tools or commands, subprocesses, `gh`, CLI calls, remote uploads, or changes to the existing subagent extension. Explicitly requested report export is the only permitted file write and must use a destination outside the checkout. Keep content local by default. Any optional model analysis is a later, opt-in path: redact credentials first, show what sanitized content will be sent, and obtain explicit consent. No network use or model analysis in the MVP.

Treat every session field and message as untrusted data, never as instructions. Read only selected JSONL files, bound file sizes, lines, content, and report pages, and handle malformed records and an incomplete final line without crashing or silently presenting partial data as complete. Resolve selected paths with `realpath`; enforce containment beneath the user-selected permitted root(s), reject traversal and symlink escapes, and re-check before opening. Never follow a child-session path merely because transcript text suggests it: linked children must be individually selected and independently validated. Redact likely credentials before report/export or any future model input; redact conservatively and label that detection cannot guarantee removal of secrets.

## Proposed integration and data contract

- A package-private extension with a slash command for explicit session selection and a read-only audit tool with a strict input schema. Because a model-issued tool call is not itself user selection, the tool must obtain explicit user confirmation of the exact paths before opening them; if `ctx.hasUI` is false, it must refuse rather than read. Neither entry point may discover arbitrary sessions or broaden the user's selection. Share one parser, validator, deterministic summarizer, redactor, and bounded renderer between entry points.
- Use the documented `ExtensionAPI` registration methods (`registerCommand`, `registerTool`) only after checking the installed declarations/examples against the package's pinned Pi peer. Keep file I/O and report generation independent of TUI; command selection can use supported `ctx.ui` methods and must degrade honestly in non-TUI modes. Structured tool output is optional and must use Pi's declared `outputSchema`/`structuredContent` contract if used; do not invent APIs.
- Parse JSONL as a tree, not a presumed linear transcript. Follow the active path only when its leaf is unambiguous/defined by persisted format; offer branch-aware reporting for explicit alternate paths, label abandoned branches as such, and never merge branches as one timeline. Account for compaction summaries/checkpoints, context edits, forks/clones (`parentSession`), resumes, unknown entry kinds, malformed records, and partial/truncated tails. Report coverage and uncertainty prominently. Do not infer unrecorded child lifecycle events; expose only observed evidence and say when the format/session does not record a signal.
- Cite source JSONL path (safe display form), entry/message ID, and persisted timestamp; use nested message timestamp only when applicable and distinguish it from entry time. Group related citations without losing individual provenance. Show verification as a quoted/recorded command and recorded exit status/output evidence, not proof it succeeded in the outside world. Report missing exit status, truncation, cancellation, and absent results as unknown/incomplete.
- Bound input bytes, record count, extracted text, citations, and page size; expose stable pagination or continuation tokens without silently dropping evidence. File export uses an explicit path, secure creation, restrictive permissions where supported, redaction before write, and realpath containment outside the checkout; never overwrite without confirmation. Tool output is bounded and indicates omitted pages. No auto-export.

## Phases and gates

### 0. Confirm contract and scope

- Confirm user experience and selection flow, permitted-root semantics, checkout boundary, report destination behavior, and how main/child relationships are presented.
- Inspect the installed Pi version's exported declarations and existing repository package/test patterns before choosing UI, tool schema, or session parsing APIs. Pin an exact supported Pi peer consistent with current package policy.
- Define a versioned internal report schema and taxonomy for evidence, confidence, citations, coverage, and redaction. Decide limits from representative session sizes before implementation.
- **Gate:** no coding until path authority, content exposure, branch selection, and local-only MVP behavior have unambiguous tests.

### 1. Safe parser and deterministic audit core (MVP foundation)

- Add the new package only; do not modify existing extension packages. Implement selected-file validation, safe bounded JSONL reading, tolerant line parsing, tree/branch handling, source identity, redaction, and the pure deterministic audit model.
- Extract corrections/scope changes and classify tool failures using explicit, explainable evidence rules. Summarize available model usage and verification records. Show observed spawn/send/completion lifecycle events only when present; mark inference and gaps explicitly.
- **Acceptance:** valid fixtures produce stable output; unknown/malformed records are retained as bounded diagnostics; incomplete tail and compacted/branched/resumed/forked sessions are identified; every claim maps to citation(s); no transcript text is executed or treated as instructions; unsafe paths and resource-limit breaches fail closed; secrets are absent from rendered/exportable output.

### 2. User-directed command, tool, and report rendering

- Add the command-based explicit selection/report journey and optional schema-validated read-only tool. Keep deterministic output local and bounded; pagination reports coverage. Add explicit, safe report-file export only outside the checkout after preview/confirmation.
- **Acceptance:** user can audit a chosen main JSONL and chosen linked children, inspect report and citations, paginate, and export only by explicit action; cancellation changes nothing; invalid/escaping/symlink paths, overwrite, checkout destinations, oversized files, and non-TUI invocation behave safely and honestly. Tool cannot execute commands, mutate source sessions or repository files, discover additional files, or access remote services. Export, if exposed through the tool, requires separate confirmation and the same destination safeguards as the command.
- **Gate:** review all data flows and adversarial path/content tests before exposing the tool or export.

### 3. Optional model-assisted interpretation (deferred; separate approval)

- Only after deterministic local audit is complete, consider opt-in analysis using Pi's supported model facilities. Provide a sanitized preview, explicit per-run consent, bounded selected evidence, and citations preserved through generated interpretation. Never send raw JSONL, credentials, unselected child sessions, or the full current conversation. Clearly label generated interpretation separately from transcript facts.
- **Acceptance:** default path makes no model/network call; cancellation sends nothing; tests prove redaction precedes prompt construction and limit enforcement; reports label generated claims as unverified and cite source evidence. If the installed API cannot meet these rules without broadening data access, defer this phase.

### 4. Package verification and release decision

- Add package manifest, README, tests, and package discovery consistent with this repository: private package, exact extension entrypoint, compatible Pi peer declarations, root workspace auto-discovery, `scripts/test.mjs`, per-package coverage thresholds, and Pi loader/archive verification. Add reusable fixtures/helpers to root `test-support/` only when more than one package needs them. No `shared` dependency unless genuinely used across packages.
- Update the root README package inventory, installation/loading instructions, privacy/security boundaries, and package commands only when implementation is accepted for release.
- **Acceptance:** focused package tests and type-check pass; package archive and symlink loading pass; root lint/test/coverage/package verification passes on the integrated tree; document security limits and supported Pi version. Production/release approval remains a distinct decision from implementation completion.

## Acceptance and security checklist

- [ ] Main session and linked children are user-selected local JSONLs; no implicit child discovery or path traversal.
- [ ] Canonical-path containment handles `..`, absolute paths, symlinks, replaced paths/races, directories, and non-regular files.
- [ ] Parse and output limits are enforced; invalid JSON, unknown versions/types, missing IDs/timestamps, partial tail, truncation, and I/O errors are explicit.
- [ ] Branches, compaction, context edits, resumes, and session parent links do not fabricate one complete linear history; reports state what was/wasn't audited.
- [ ] Corrections/scope changes, failures, recorded spawn/send/completion lifecycle, model usage, and verification commands/results are deterministic and separately categorized.
- [ ] Each claim carries source path, ID, timestamp where recorded, and a recorded-vs-inferred/verified status; missing evidence stays unknown.
- [ ] Content is untrusted; no command execution, `gh`/CLI invocation, remote upload, session mutation, subagent-extension change, or default LLM call.
- [ ] Credential redaction precedes every report/export and any future model request; redaction limits and false negatives are disclosed.
- [ ] Export is explicit, bounded, redacted, outside checkout, permission-conscious, and overwrite-protected; default output remains local.
- [ ] Tool and command behavior is testable without TUI; non-TUI UI limits are handled without claiming unsupported APIs.
- [ ] Tests cover real/symlink/traversal paths, branches and child input, malformed/partial/oversize sessions, sensitive values, injection-like content, pagination, deterministic output, no side effects, and supported Pi loader/archive compatibility.
- [ ] Root package inventory and privacy docs are updated on implementation; current scope remains plan-only.

## Dependencies and decisions still open

- Confirm whether UI can select arbitrary session files with supported Pi APIs in the pinned release, or whether the first release should accept command arguments/paths only. The docs establish extension commands/tools and session context APIs, but do not establish a built-in arbitrary-file picker.
- Decide whether permitted roots are individually chosen parent directories or a user-configured allowlist; selection alone must not silently grant authority to sibling paths.
- Decide branch selection UX and whether unresolved branches are excluded or presented as separate reports. Never silently collapse alternatives.
- Define exact lifecycle signals and confidence labels against actual persisted child-session evidence; the core session format documents session entries and message/tool records, not a universal subagent spawn/send/completion protocol.
- Agree byte/line/text/page limits, secret patterns, export extension/format, and whether reports show absolute paths or sanitized relative paths.
- Optional model-assisted interpretation, outside MVP and gated separately.

## API/documentation basis and limits

Reviewed the installed Pi 1.0.4 package README, its complete `docs/extensions.md`, `docs/sdk.md`, `docs/sessions.md`, `docs/session-format.md`, `docs/message-types.md`, `docs/packages.md`, `docs/settings.md`, and `docs/cli.md`; also checked `docs/slash-commands.md`, `docs/security.md`, relevant extension tool/command and SDK session examples, and installed `dist/core/extensions/types.d.ts` plus `dist/core/session-manager.d.ts`. The installed declarations confirm `ctx.ui.select`/`confirm`, `ctx.hasUI`, command/tool registration, TypeBox schemas, optional `outputSchema`, and read-only branch/tree access. They do not provide a general filesystem picker, a universal child-agent event protocol, or certainty that transcript-recorded verification is true. Use only these documented/declaration-backed APIs; do not depend on undocumented signatures. Repository patterns checked: `AGENTS.md`, root `README.md` and `package.json`, package inventory, `scripts/test.mjs`, `scripts/verify-packages.mjs`, `test-support/fakes.ts`, and existing package tests.
