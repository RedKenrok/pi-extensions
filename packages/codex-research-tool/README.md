# codex-research-tool

## Overview

`codex-research-tool` is a Pi extension that adds one focused web-research tool, `research`, backed by the user's ChatGPT/Codex subscription. It accepts one self-contained question and returns a concise answer with normalized source links.

The extension deliberately uses Pi-managed `openai-codex` OAuth. It does not use OpenAI API keys, API billing, the Codex app or CLI credential store, or credentials copied from another application. Sign-in must be completed inside Pi.

## What it provides

| Interface | Purpose |
| --- | --- |
| `research` tool | Ask one web-research question and receive a cited answer. |
| `/research` | Show the most recent availability status. |
| `/research status` | Show the same availability status explicitly. |
| `/research refresh` | Repeat the bounded OAuth and backend-availability check. |

The slash commands do not perform research or start an LLM turn. The `research` tool is registered only while a usable Pi-managed Codex credential and compatible backend are available.

## Requirements

- Node.js 22.19 or newer.
- Pi `@earendil-works/pi-coding-agent` 0.85.x, tested with Pi 0.85.1.
- A Pi-managed `openai-codex` OAuth login containing a refreshable access token and ChatGPT account ID.
- ChatGPT/Codex subscription capacity for each research request.

## Installation and loading

From this directory:

```sh
npm install
pi install .
```

For project-local installation, use:

```sh
pi install . --local
```

Restart or reload Pi after installation. For one-off loading from the repository root, run:

```sh
pi -e ./packages/codex-research-tool
```

The package manifest declares `pi.extensions: ["./index.ts"]`.

Sign in from Pi even if the Codex app or CLI is already signed in:

```text
/login openai-codex
/research refresh
```

When a fresh session cannot authenticate, Pi reports:

```text
Research unavailable: sign in with /login openai-codex, then run /research refresh.
```

## Usage

The complete public tool contract is:

```json
{
  "query": "Which Node.js release line is currently Active LTS, and what primary source confirms it?",
  "model": "gpt-6-luna",
  "effort": "high"
}
```

`query` is trimmed, must not be empty, and is limited to 4,000 characters. It is not silently split or rewritten. `model` is optional and accepts an exact Codex subscription model ID of at most 128 characters. `effort` optionally selects an exact reasoning level supported by that model. Both are checked against the authenticated account's model catalog before research begins. Endpoint, credentials, account ID, and system instructions remain fixed implementation details. There is no `codex_search` alias.

A successful result contains these model-visible sections:

```text
Status
Query
Model
Reasoning effort (when explicitly selected)
Answer
Sources
```

HTTP(S) URL annotations become deduplicated sources, and safe annotation ranges become claim markers. An answer without citations is returned as `uncited` and explicitly labeled as not source-verified. Empty answers and responses with no observed web-search activity are errors.

## Configuration and behavior

### Availability and lifecycle

On `session_start`, the extension checks whether Pi stores an OAuth credential for `openai-codex`, asks Pi's model registry to refresh and resolve a usable bearer token, reads the corresponding ChatGPT account ID, and fetches a non-consuming model catalog containing at least one research-capable model. Only then does it register `research`.

If authentication later disappears or the backend rejects access, the extension removes only its own tool and preserves every unrelated active tool. A stale invocation still rechecks credentials before transport. Authentication, access, client-version, and compatibility failures block ordinary automatic reactivation until `/research refresh` is run. An explicit refresh invalidates the cached model selection and repeats both the credential and backend checks. Intentional user deactivation is otherwise preserved.

Account identity resolution uses this order:

1. a nonempty `accountId` stored on Pi's refreshed OAuth credential;
2. the `chatgpt_account_id` claim in the refreshed access token.

Both the refreshed bearer token and account ID are required. Pi's nonempty stored `accountId` is authoritative, so an opaque access token is accepted when that metadata is present; malformed token metadata fails closed when the stored account ID is absent. Missing credentials, API-key credentials, refresh failure, unstable account switching, and timeout also fail closed.

Pi 0.85.1 does not expose cancellation for its internal credential-refresh operation. The extension bounds its own wait and ignores late completion for availability changes, although Pi may finish its serialized refresh in the background.

### Research request

Each call sends one self-contained query to the fixed Codex subscription backend. It requests live web search with medium context, requires search-tool activity, sets `store: false`, and streams progress into Pi. The surrounding Pi conversation, repository files, and local instruction files are not forwarded.

Web search is performed inside the Codex response by the backend's `web_search` tool. The extension observes search activity and receives the synthesized answer and URL annotations, but it does not expose a browser session, page bodies, navigation controls, cookies, or caller-selected requests. Consequently, `research` is a one-shot research-answer interface rather than standalone browsing. Use a separate HTTP retrieval tool when a caller needs to choose and inspect a specific URL.

When `model` is omitted, model discovery prefers `gpt-6-luna` when the account offers it, then uses the catalog's declared default or first available model. A tool call may override that choice with an exact model ID available to the same authenticated ChatGPT account and may supply its `effort`. If either choice is unavailable, the tool returns an `invalid_input` error containing the available model IDs and each model's advertised reasoning levels, including its default when reported.

The extension uses these fixed endpoints:

- `https://chatgpt.com/backend-api/codex/models` for model discovery;
- `https://chatgpt.com/backend-api/codex/responses` for research.

Redirects are disabled. Authorized requests send the bearer token and `ChatGPT-Account-ID` together.

The model-catalog request sends an explicit Codex protocol compatibility version maintained by `codex-research-tool`. This is intentionally separate from Pi's package version: the backend uses `client_version` to filter out models that require newer Codex request semantics. Catalog entries explicitly marked as unavailable to the API or web search are not offered for research.

### Limits and errors

- Ten-minute total deadline, including OAuth resolution, model discovery, and research.
- Pi Escape/cancellation and session shutdown abort active transport.
- No automatic retries; repeating a query may consume additional subscription capacity.
- 2 MiB maximum SSE stream and 256 KiB maximum individual SSE frame.
- 20,000-character maximum result text, with bounded answer metadata and an explicit truncation notice.
- Redirects, 401, 403, 429, 5xx responses, empty or incompatible model catalogs, malformed SSE, failed/incomplete events, premature EOF, missing search activity, empty answers, and cancellation become sanitized structured errors.

Pi 0.85.1's `AgentToolResult` type has no `isError` field. Failures therefore use model-visible `Status: error` content and `details.status: "error"` with a structured error object; they are not formatted as ordinary answers.

## Security and privacy

- Credentials are read through Pi's public credential and model-registry APIs and are sent only to the fixed `chatgpt.com` Codex endpoints.
- The research request includes only the fixed concise research instruction and the supplied query. Pi history, workspace files, and local instructions are excluded.
- `store: false` is set on backend requests.
- Raw response bodies, bearer tokens, account IDs, authorization headers, and credential-refresh failures are never included in tool results or diagnostics.
- Error messages are classified and sanitized before they enter the model context.
- Sources and answers remain untrusted web content even when citations are present.

## Development and verification

The workspace test suite uses synthetic credentials and HTTP/SSE fixtures. Coverage includes OAuth/account precedence and races, API-key rejection, timeouts and cancellation, lifecycle transitions, stale calls, unrelated-tool preservation, the exact tool schema, validated per-call model overrides, non-Codex conversation models, citations, Unicode and chunk boundaries, CRLF and multiline SSE, terminal-envelope fallback, premature EOF, failure events, absent search activity, output limits, redirects, status classification, model catalogs, and secret sanitization.

An offline RPC load check can be run from the repository root:

```sh
printf '%s\n' '{"id":"state","type":"get_state"}' | \
  pi --mode rpc --offline --no-session --no-context-files -e ./packages/codex-research-tool
```

## Known limitations

- The ChatGPT subscription endpoint is not a documented public third-party search API and may change independently of this extension.
- The Codex protocol compatibility version must be reviewed when upstream Codex changes its model or response schema. An empty compatible catalog is reported as `client_outdated` instead of being misdiagnosed as an authentication failure.
- The tool handles one query per call. It does not provide batching, standalone browsing, a cookie store, or configurable endpoints.
- An answer can be returned as `uncited` when the backend supplies no usable URL annotations; this is explicitly marked as not source-verified.
- Availability depends on Pi-managed OAuth and the subscription backend. Signing into another OpenAI application does not make the tool available in Pi.
- There are no automatic retries, because repeated research can consume subscription allowance.
