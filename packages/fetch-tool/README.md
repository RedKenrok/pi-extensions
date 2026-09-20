# fetch-tool

`fetch-tool` is a Pi package that adds the `fetch` tool for bounded HTTP(S) requests. It can return text, readable Markdown, compacted structured data, or a short binary preview.

## Requirements and loading

- Node.js 22.19 or newer.
- Pi `@earendil-works/pi-coding-agent` `>=0.85.1 <0.86.0`.
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

Caller cancellation is reported separately from timeout. HTML conversion removes common navigation, forms, advertising, cookie UI, social UI, scripts, and styles; favors semantic article/main containers; and resolves relative links against the final response URL. Declared HTTP and HTML character encodings are honored when supported.

Ordinary responses may download up to 16 MiB. HTML and minifiable structured responses may download up to 32 MiB before transformation. Text output defaults to 512 KiB and returns a UTF-8-safe prefix with truncation metadata when larger. Binary responses expose metadata and a base64 preview of only the first 150 bytes.

The default safe-header mode includes common content, cache, redirect, and retry headers while omitting cookies and most diagnostic/security headers.

## Security and privacy

- Requests go to the supplied URL and follow the selected redirect policy. Local and private-network services are reachable; do not expose the tool to untrusted callers when that access is unsafe.
- Caller-supplied headers and bodies can contain secrets and are forwarded to the selected destination. Full response-header mode can also expose sensitive values to model context.
- Downloaded content is untrusted. Markdown conversion removes executable page elements but cannot remove textual prompt injection.
- The package does not persist fetched content, credentials, or cookies and does not maintain a cookie jar.
- This is an HTTP client, not a browser: it does not execute JavaScript or solve interactive authentication and bot challenges.

## Development

From the repository root:

```sh
npm run check
```

The tests cover defaults, safe headers, text truncation, binary previews, character encodings, HTML extraction and absolute links, cancellation, timeout signals, and JSON, NDJSON, XML, and HTML minification.
