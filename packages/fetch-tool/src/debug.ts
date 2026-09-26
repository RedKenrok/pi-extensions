import {
	createDiagnostics,
	type DiagnosticsOptions,
} from "pi-extensions-shared/diagnostics";

const PACKAGE_NAME = "fetch-tool";

/**
 * Silent fallbacks keep the tool usable, but make field failures hard to
 * explain. With `PI_EXT_DEBUG=fetch-tool` (or `*`) each fallback writes one
 * reason line to stderr. Details must stay short and never contain URLs,
 * headers, or bodies, because stderr often ends up in shared logs.
 */
export const debug = (
	reason: string,
	detail: string,
	sink: DiagnosticsOptions = {},
): void => {
	// Resolved per call so PI_EXT_DEBUG can be toggled without a reload.
	createDiagnostics(PACKAGE_NAME, sink)(reason, detail);
};
