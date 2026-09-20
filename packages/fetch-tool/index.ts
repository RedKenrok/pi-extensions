import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fetchTool from "./src/fetch.ts";

export default (pi: ExtensionAPI) => {
	pi.registerTool(fetchTool());
};
