import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fetchTool from "./src/fetch.ts";

// Only registerTool is needed, which also lets tests pass a minimal typed fake.
export default (pi: Pick<ExtensionAPI, "registerTool">) => {
	pi.registerTool(fetchTool());
};
