# fetch-tool

`fetch-tool` is a Pi package that adds the `fetch` tool for bounded HTTP(S) requests. It can return text, readable Markdown, compacted structured data, or a short binary preview.

## Requirements and loading

- Node.js 22.19 or newer.
- Pi `@earendil-works/pi-coding-agent` `>=0.85.1 <1.0.0`.
- Network access to the requested destination.

From the repository root:

```sh
pi install ./packages/fetch-tool
# One-off loading:
pi -e ./packages/fetch-tool
```

For project-local installation, add `--local` to `pi install`.

## Usage

Fetch a page as readable Markdown:

```json
{
  "url": "https://example.com/docs",
  "markdown": true
}
```

Send JSON and include all response headers:

```json
{
  "url": "https://api.example.com/items",
  "method": "POST",
  "headers": { "Authorization": "Bearer …" },
  "body": { "name": "example" },
  "includeHeaders": "all"
}
```

## Parameters

| Parameter | Default | Meaning |
| --- | --- | --- |
| `url` | required | HTTP or HTTPS URL to request. |
| `method` | `GET` | `GET`, `POST`, `PUT`, `DELETE`, `PATCH`, `HEAD`, or `OPTIONS`. |
| `headers` | none | Request headers. A browser-like user agent is added when absent. |
| `body` | none | String, object, or array. Objects and arrays are JSON-encoded. |
| `timeout` | `30000` | Deadline in milliseconds; minimum 100 ms. |
| `markdown` | `false` | Extract likely main HTML content and convert it to Markdown. |
| `minify` | `true` | Compact supported JSON, NDJSON, XML, and HTML responses. |
| `maxOutputSize` | `524288` | Maximum model-facing text body, from 1 KiB through 16 MiB. |
| `redirect` | `follow` | `follow`, `error`, or `manual`. |
| `includeHeaders` | `safe` | `safe`, `all`, or `none`; booleans alias `all` and `none`. |

Caller cancellation is reported separately from timeout, and validation and operational failures are thrown as failed tool results with an `errorType` of `validation`, `timeout`, `aborted`, `size_limit`, `fetch` (network, DNS, TLS, or redirect-policy failures, including the underlying cause), or `unknown`. Deadlines are checked between synchronous decoding and transformation stages; JavaScript cannot interrupt an individual synchronous parser/minifier while it is running, so a single transform may exceed the deadline before the next check.

Markdown uses ATX headings (`#`), fenced code blocks, and `-` bullets. HTML conversion removes scripts, styles, forms, navigation, advertising, cookie UI, and social UI. Page-level `header` and `footer` elements are removed, but those inside an `article`, `main`, or `section` are kept because they usually hold the title, byline, and footnotes. It favors semantic article/main containers unless a small container (such as a teaser card) holds much less text than the page's main content. Relative links resolve against `<base href>` when present, otherwise against the final response URL, and lazy-loaded images (`data-src` or `srcset`) keep their real source. When `markdown` is requested, `details.markdown` reports `converted`, `failed` (the HTML is returned instead), or `not_html` (the response is returned unchanged), and the result text says so for the last two.

Declared HTTP and HTML `<meta>` character encodings are honored when supported; unknown labels fall back to UTF-8. Responses are treated as text for `text/*`, JSON, NDJSON, XML (including `+json` and `+xml` types), JavaScript, YAML, TOML, GraphQL, SQL, and form-encoded bodies. A response without a `Content-Type` is shown as text when it looks like UTF-8 text, and as a binary preview otherwise.

Ordinary responses may download up to 16 MiB. HTML and minifiable structured responses may download up to 32 MiB before transformation. Limits apply to the decoded body, so a small compressed response that expands past the limit is rejected. `HEAD`, 204, and 304 responses never read a body. Text output defaults to 512 KiB and returns a UTF-8-safe prefix with truncation metadata when larger. Binary responses expose metadata and a base64 preview of only the first 150 bytes.

The response body appears only in the model-facing text. `details` carries metadata (status, final URL, headers, title, body type, sizes, truncation, minification, Markdown status) but not the body, because Pi persists `details` in the session file.

JSON and NDJSON minification preserves numeric spelling and string contents without rounding large integers. XML processing only trims document-edge whitespace: internal whitespace is preserved because it may be meaningful without a schema.

The default safe-header mode includes common content, cache, redirect, and retry headers while omitting cookies and most diagnostic/security headers.

## Diagnostics

Fallbacks such as a failed Markdown conversion or an unsupported charset are silent by default. Set `PI_EXT_DEBUG=fetch-tool` (a comma-separated list of package names, or `*` for all) to have each fallback and failed request write one `[fetch-tool] <reason>: <detail>` line to stderr. Details never include URLs, headers, or bodies.

## Security and privacy

- Requests go to the supplied URL and follow the selected redirect policy (default `follow`). Network destinations are intentionally unrestricted: local and private-network services are reachable, including through redirects. Do not expose the tool to untrusted callers when that access is unsafe.
- Caller-supplied headers and bodies can contain secrets and are forwarded to the selected destination. Full response-header mode can also expose sensitive values to model context.
- Downloaded content is untrusted. Markdown conversion removes executable page elements but cannot remove textual prompt injection.
- The package does not persist fetched content, credentials, or cookies and does not maintain a cookie jar.
- `user:password@` credentials in a URL are removed before the URL is echoed in results or errors.
- This is an HTTP client, not a browser: it does not execute JavaScript or solve interactive authentication and bot challenges.

## Development

From the repository root, run `npm run lint`, `npm run test`, and `npm run test:coverage`. Unit tests stub `fetch`; `tests/integration.test.ts` runs against a local HTTP server to exercise real redirects, compression, chunking, and timeouts; `tests/minify.property.test.ts` checks the minifiers against seeded random documents.
