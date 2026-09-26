# pi-extensions-shared

Runtime helpers shared by the extensions in this repository. It is not a Pi extension and registers nothing.

| Module | Contents |
| --- | --- |
| `pi-extensions-shared/codex` | Fixed Codex endpoints on `chatgpt.com` and the headers every Codex subscription request needs. |
| `pi-extensions-shared/jwt` | Reading the ChatGPT account id from an OpenAI OAuth access token. |
| `pi-extensions-shared/sse` | A linear-time SSE frame reader with stream and frame byte limits, and a frame parser. |
| `pi-extensions-shared/body` | Reading a response body with a hard byte limit and abort support. |
| `pi-extensions-shared/record` | `isRecord` and small string guards. |
| `pi-extensions-shared/diagnostics` | The `PI_EXT_DEBUG` convention: opt-in, one `[package] reason` line on stderr. |

Helpers report failures as neutral errors (`SseLimitError`, `BodyTooLargeError`, the abort signal's reason), so each extension keeps its own user-facing wording and error codes.

Consumers depend on it and bundle it; see "Shared code" in the repository README for how bundling works. Tests run with `npm run test --workspace pi-extensions-shared`.
