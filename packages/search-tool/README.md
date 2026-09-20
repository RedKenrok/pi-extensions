# search-tool

`search-tool` is a Pi package that adds the `search` tool for one or more DuckDuckGo Lite searches. It returns bounded, validated HTTP(S) results without acquiring or managing an account credential.

## Requirements and loading

- Node.js 22.19 or newer.
- Pi `@earendil-works/pi-coding-agent` `>=0.85.1 <0.86.0`.
- Network access to DuckDuckGo Lite.

From the repository root:

```sh
pi install ./packages/search-tool
# One-off loading:
pi -e ./packages/search-tool
```

For project-local installation, add `--local` to `pi install`.

## Usage

Run one search:

```json
{
  "queries": "Node.js fetch AbortSignal documentation"
}
```

Run several searches concurrently:

```json
{
  "queries": [
    "Node.js fetch AbortSignal documentation",
    "WHATWG Fetch redirect modes",
    "MDN TextDecoder charset labels"
  ]
}
```

## Behavior

| Parameter | Default | Meaning |
| --- | --- | --- |
| `queries` | required | One query or an array of one to eight queries; each is at most 500 characters. |
| `timeout` | `30000` | Per-query deadline in milliseconds; minimum 100 ms. |

At most four requests run concurrently. Each query returns up to ten results. Titles are limited to 300 characters and descriptions to 1,000 characters. DuckDuckGo redirect wrappers are decoded, internal results and unsupported schemes are discarded, and only HTTP(S) destinations are returned. In a multi-query request, each query reports success or failure independently. Search responses are limited to 2 MiB.

## Security and privacy

- Queries are sent to DuckDuckGo Lite.
- Results and linked pages are untrusted external content and can contain prompt injection.
- The package does not persist queries, search results, credentials, or cookies.
- Search parses DuckDuckGo's HTML interface rather than a versioned API, so upstream markup changes can affect extraction.

## Development

From the repository root:

```sh
npm run check
```

The tests cover query validation, cancellation and timeout behavior, URL normalization, result extraction, concurrency, and the ten-result cap.
