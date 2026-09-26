export const DEFAULT_TIMEOUT = 30_000;
export const MIN_TIMEOUT = 100;
// setTimeout clamps larger delays to 1 ms, so this is the longest deadline
// that still behaves as a deadline.
export const MAX_TIMEOUT = 2_147_483_647;

export const DEFAULT_MAX_RESPONSE_SIZE = 16 * 1024 * 1024;
// HTML and structured data usually shrink substantially once converted or
// minified, so they may download more than ordinary responses.
export const DEFAULT_MAX_DOWNLOAD_SIZE = 32 * 1024 * 1024;
export const DEFAULT_MAX_OUTPUT_SIZE = 512 * 1024;
export const MIN_OUTPUT_SIZE = 1024;
export const MAX_OUTPUT_SIZE = DEFAULT_MAX_RESPONSE_SIZE;
export const DEFAULT_BINARY_PREVIEW_SIZE = 150;

// Mimicking a real browser is the point: many sites serve bot challenges,
// stripped pages, or 403s to anything else, so requests identify as a current
// desktop Safari by default. Keep this a genuine, current Safari string rather
// than a neutral one, and refresh the version numbers when this Safari release
// ages out. Callers can still override the header per request.
export const DEFAULT_USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
