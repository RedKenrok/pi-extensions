// Tool input limits. The TypeBox schema and the runtime checks both read these,
// because Pi does not guarantee schema validation before execute() runs.
export const MAX_QUERY_CHARS = 4_000;
export const MAX_MODEL_ID_CHARS = 128;
export const MAX_EFFORT_CHARS = 32;

export const RESEARCH_DEADLINE_MS = 10 * 60_000;
export const MAX_RESULT_CHARS = 20_000;
export const MAX_SOURCES_CHARS = 6_000;
export const MAX_SOURCE_TITLE_CHARS = 300;

// Availability checks run before every agent turn, so they must stay short
// enough that a slow backend cannot noticeably delay the user's prompt.
export const AVAILABILITY_TIMEOUT_MS = 5_000;

// A verified credential is reused for this long as long as Pi's stored
// credential is unchanged. The stored credential is still reread on every
// check, so a logout is noticed immediately; only the token refresh is skipped.
export const AUTH_CACHE_TTL_MS = 30_000;
// Never serve a cached token this close to its recorded expiry, so Pi gets a
// chance to refresh it before the backend rejects it.
export const AUTH_EXPIRY_MARGIN_MS = 60_000;

// The catalog changes rarely, and per-call model overrides would otherwise
// cost an extra round trip on every research call.
export const CATALOG_CACHE_TTL_MS = 5 * 60_000;

// Progress updates re-render the TUI; one every quarter second is smooth
// enough to show activity without redrawing on every streamed token.
export const PROGRESS_INTERVAL_MS = 250;
export const PROGRESS_PREVIEW_CHARS = 240;
