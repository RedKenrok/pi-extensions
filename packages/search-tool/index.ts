import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import searchTool from "./src/search.ts";

export default (pi: ExtensionAPI) => {
	pi.registerTool(searchTool());
};
